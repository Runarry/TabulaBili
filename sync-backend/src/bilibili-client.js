const DEFAULT_BASE_URL = 'https://api.bilibili.com';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_USER_AGENT = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/125.0.0.0 Safari/537.36'
].join(' ');

const RETRYABLE_TYPES = new Set(['rate_limited', 'risk_control', 'http_429', 'network', 'timeout']);

class BiliApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BiliApiError';
    this.code = details.code ?? null;
    this.status = details.status ?? 0;
    this.type = details.type || classifyBiliFailure(details.code, details.status);
    this.retryable = details.retryable ?? RETRYABLE_TYPES.has(this.type);
    this.endpoint = details.endpoint || '';
    this.hint = details.hint || getBiliFailureHint(this.type);
    this.payload = details.payload;
  }
}

function classifyBiliFailure(code, status = 0) {
  const numericCode = Number(code);
  const numericStatus = Number(status);
  if (numericCode === -799) return 'rate_limited';
  if (numericCode === -352 || numericStatus === 412) return 'risk_control';
  if (numericStatus === 429) return 'http_429';
  if (numericStatus >= 500) return 'server_error';
  if (numericStatus >= 400) return 'http_error';
  if (Number.isFinite(numericCode) && numericCode !== 0) return 'business_error';
  return 'unknown';
}

function getBiliFailureHint(type) {
  if (type === 'risk_control') {
    return 'B站风控拦截了本次公开接口请求。后端不会绕过风控，已记录失败并进入退避；请降低采集频率，稍后重试。';
  }
  if (type === 'rate_limited' || type === 'http_429') {
    return 'B站返回限频。后端已记录失败并进入退避；请减少单次目标数、页数和视频数后稍后重试。';
  }
  if (type === 'timeout' || type === 'network') {
    return '网络或上游服务暂时不可用。后端已记录失败，可稍后重试。';
  }
  return '';
}

function formatBiliFailureMessage({ type, status, code, message }) {
  const detail = message ? `：${message}` : '';
  if (type === 'risk_control') return `B站风控拦截${status ? `（HTTP ${status}）` : ''}${detail}`;
  if (type === 'rate_limited') return `B站请求过于频繁${code != null ? `（code ${code}）` : ''}${detail}`;
  if (type === 'http_429') return `B站请求过于频繁（HTTP 429）${detail}`;
  if (status) return `Bilibili HTTP ${status}${detail}`;
  if (code != null) return `Bilibili API code ${code}${detail}`;
  return message || 'Bilibili API error';
}

function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withTimeout(fetcher, timeoutMs) {
  return async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new BiliApiError('Bilibili request timed out', { type: 'timeout', retryable: true });
      }
      throw new BiliApiError(error && error.message ? error.message : 'Bilibili network error', {
        type: 'network',
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

class BilibiliClient {
  constructor(options = {}) {
    const fetcher = options.fetcher || globalThis.fetch;
    if (typeof fetcher !== 'function') throw new Error('fetch is required');
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = withTimeout(fetcher, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.referer = options.referer || 'https://www.bilibili.com/';
  }

  async request(path, params = {}) {
    const url = appendParams(new URL(path, `${this.baseUrl}/`), params);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'user-agent': this.userAgent,
          referer: this.referer
        }
      });
    } catch (error) {
      if (error instanceof BiliApiError) {
        error.endpoint = path;
      }
      throw error;
    }

    const rawText = await response.text();
    const payload = parseJsonText(rawText);

    if (!response.ok) {
      const code = payload && payload.code;
      const type = classifyBiliFailure(code, response.status);
      throw new BiliApiError(formatBiliFailureMessage({
        type,
        status: response.status,
        code,
        message: payload && (payload.message || payload.msg)
      }), {
        status: response.status,
        code,
        type,
        endpoint: path,
        payload: payload || { text: rawText.slice(0, 500) }
      });
    }

    if (!payload) {
      throw new BiliApiError('Bilibili returned non-JSON response', {
        status: response.status,
        type: 'invalid_json',
        endpoint: path,
        payload: { text: rawText.slice(0, 500) }
      });
    }

    const code = Number(payload && payload.code);
    if (code !== 0) {
      const type = classifyBiliFailure(code, response.status);
      throw new BiliApiError(formatBiliFailureMessage({
        type,
        status: response.status,
        code,
        message: payload && (payload.message || payload.msg)
      }), {
        code,
        status: response.status,
        type,
        endpoint: path,
        payload
      });
    }

    return payload.data;
  }

  fetchUpCard(mid) {
    return this.request('/x/web-interface/card', { mid });
  }

  fetchRelationStat(mid) {
    return this.request('/x/relation/stat', { vmid: mid });
  }

  fetchNavNum(mid) {
    return this.request('/x/space/navnum', { mid });
  }

  fetchArchivePage(mid, page = 1, pageSize = 30) {
    return this.request('/x/space/arc/search', {
      mid,
      pn: page,
      ps: pageSize,
      order: 'pubdate'
    });
  }

  fetchVideoView(bvid) {
    return this.request('/x/web-interface/view', { bvid });
  }

  fetchVideoTags(bvid) {
    return this.request('/x/tag/archive/tags', { bvid });
  }
}

export { BiliApiError, BilibiliClient, classifyBiliFailure };
