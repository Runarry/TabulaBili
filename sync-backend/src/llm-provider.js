const DEFAULT_TIMEOUT_MS = 30000;
const PROMPT_VERSION = 'up-portrait-v1';

class LlmProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LlmProviderError';
    this.type = details.type || 'llm_error';
    this.status = details.status || 0;
    this.retryable = details.retryable !== false;
    this.payload = details.payload;
  }
}

function getEnvValue(env, key) {
  return env && Object.hasOwn(env, key) ? env[key] : undefined;
}

function normalizeProviderConfig(env = {}) {
  const processEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const provider = String(getEnvValue(env, 'LLM_PROVIDER') || processEnv.LLM_PROVIDER || '').trim();
  const baseUrl = String(getEnvValue(env, 'LLM_BASE_URL') || processEnv.LLM_BASE_URL || '').trim();
  const apiKey = String(getEnvValue(env, 'LLM_API_KEY') || processEnv.LLM_API_KEY || '').trim();
  const model = String(getEnvValue(env, 'LLM_MODEL') || processEnv.LLM_MODEL || '').trim();
  const timeoutMs = Number(getEnvValue(env, 'LLM_TIMEOUT_MS') || processEnv.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    provider: provider || 'compatible',
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function stripJsonFence(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

function parseLlmJson(text) {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch (error) {
    throw new LlmProviderError('LLM returned invalid JSON', {
      type: 'invalid_json',
      retryable: false,
      payload: { text: String(text || '').slice(0, 1000) }
    });
  }
}

function normalizeTextArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function normalizePortraitOutput(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    summary: String(source.summary || '').trim(),
    contentPositioning: String(source.contentPositioning || '').trim(),
    audienceHypothesis: String(source.audienceHypothesis || '').trim(),
    contentStyle: String(source.contentStyle || '').trim(),
    commercialFit: String(source.commercialFit || '').trim(),
    risks: normalizeTextArray(source.risks),
    evidence: normalizeTextArray(source.evidence)
  };
}

function buildPortraitMessages(input) {
  const compactFacts = {
    profile: input.profile,
    rulePortrait: input.rulePortrait,
    recentVideos: (input.videos || []).slice(0, 20).map((video) => ({
      bvid: video.bvid,
      title: video.title,
      tname: video.tname,
      publishedAt: video.publishedAt,
      viewCount: video.viewCount,
      likeCount: video.likeCount,
      coinCount: video.coinCount,
      favoriteCount: video.favoriteCount,
      replyCount: video.replyCount,
      danmakuCount: video.danmakuCount,
      shareCount: video.shareCount,
      tags: video.tags
    }))
  };
  return [
    {
      role: 'system',
      content: [
        '你是一个内容运营分析助手。只基于用户提供的结构化公开数据生成 B站 UP主画像。',
        '不要声称拥有未提供的私人信息。受众画像必须标注为推断。',
        '必须输出 JSON，不要输出 Markdown。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        '请生成 UP主画像 JSON，字段固定为：',
        'summary, contentPositioning, audienceHypothesis, contentStyle, commercialFit, risks, evidence。',
        'risks 和 evidence 必须是字符串数组。',
        '输入事实：',
        JSON.stringify(compactFacts)
      ].join('\n')
    }
  ];
}

async function fetchWithTimeout(fetcher, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new LlmProviderError('LLM request timed out', { type: 'timeout', retryable: true });
    }
    throw new LlmProviderError(error && error.message ? error.message : 'LLM network error', {
      type: 'network',
      retryable: true
    });
  } finally {
    clearTimeout(timer);
  }
}

class OpenAICompatibleProvider {
  constructor(options = {}) {
    this.provider = options.provider || 'compatible';
    this.baseUrl = options.baseUrl || '';
    this.apiKey = options.apiKey || '';
    this.model = options.model || '';
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.fetcher = options.fetcher || globalThis.fetch;
    if (typeof this.fetcher !== 'function') throw new Error('fetch is required');
  }

  assertConfigured() {
    if (!this.baseUrl || !this.apiKey || !this.model) {
      throw new LlmProviderError('LLM provider is not configured', {
        type: 'llm_not_configured',
        retryable: false
      });
    }
  }

  buildRequest(input) {
    this.assertConfigured();
    return {
      url: chatCompletionsUrl(this.baseUrl),
      body: {
        model: this.model,
        messages: buildPortraitMessages(input),
        temperature: 0.2,
        response_format: { type: 'json_object' }
      }
    };
  }

  async generatePortrait(input) {
    const request = this.buildRequest(input);
    const response = await fetchWithTimeout(this.fetcher, request.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request.body)
    }, this.timeoutMs);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LlmProviderError('LLM returned non-JSON response', {
        status: response.status,
        type: 'invalid_response'
      });
    }

    if (!response.ok) {
      throw new LlmProviderError(`LLM HTTP ${response.status}`, {
        status: response.status,
        type: response.status === 429 ? 'rate_limited' : 'http_error',
        retryable: response.status >= 429,
        payload
      });
    }

    const content = payload && payload.choices && payload.choices[0]
      && payload.choices[0].message && payload.choices[0].message.content;
    if (!content) {
      throw new LlmProviderError('LLM response did not include message content', {
        type: 'invalid_response',
        retryable: false,
        payload
      });
    }

    return {
      ...normalizePortraitOutput(parseLlmJson(content)),
      provider: this.provider,
      model: this.model,
      promptVersion: PROMPT_VERSION,
      generatedAt: new Date().toISOString()
    };
  }
}

function createLlmProvider(options = {}) {
  const config = normalizeProviderConfig(options.env || {});
  return new OpenAICompatibleProvider({
    ...config,
    fetcher: options.fetcher || options.fetch
  });
}

export {
  LlmProviderError,
  OpenAICompatibleProvider,
  PROMPT_VERSION,
  buildPortraitMessages,
  createLlmProvider,
  normalizeProviderConfig,
  normalizePortraitOutput
};
