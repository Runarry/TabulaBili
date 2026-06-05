import { adminPage } from './admin-page.js';
import { materializeConfig, mergeConfig, normalizeEnvelope, sameConfigEnvelope } from './config-merge.js';
import { normalizeReportPayload } from './report-aggregate.js';

const MAX_BULK_REPORT_BATCHES = 50;
const MAX_BULK_REPORT_EVENTS = 2000;
const READ_CACHE_TTL_MS = 30 * 1000;
const READ_CACHE_MAX_ENTRIES = 100;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

function text(value, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(value, {
    status,
    headers: {
      'content-type': contentType,
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type'
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getBearer(request, url) {
  const header = request.headers.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return url.searchParams.get('auth') || '';
}

function getReportSampleOptions(url) {
  return {
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
    includeTotal: shouldIncludeTotal(url),
    q: url.searchParams.get('q') || '',
    feedback: url.searchParams.get('feedback') || 'all',
    sort: url.searchParams.get('sort') || 'lastSeenAt',
    clientId: url.searchParams.get('clientId') || '',
    mode: url.searchParams.get('mode') || '',
    source: url.searchParams.get('source') || '',
    category: url.searchParams.get('category') || '',
    upMid: url.searchParams.get('upMid') || '',
    upName: url.searchParams.get('upName') || '',
    minSeenCount: Number(url.searchParams.get('minSeenCount') || 0),
    minClickCount: Number(url.searchParams.get('minClickCount') || 0),
    since: url.searchParams.get('since') || '',
    until: url.searchParams.get('until') || '',
    hasFeedback: url.searchParams.get('hasFeedback') || ''
  };
}

function shouldIncludeTotal(url) {
  return url.searchParams.get('includeTotal') !== '0';
}

function getReportEventOptions(url, sampleId) {
  return {
    sampleId,
    limit: Number(url.searchParams.get('limit') || 100),
    offset: Number(url.searchParams.get('offset') || 0),
    eventKind: url.searchParams.get('eventKind') || '',
    days: Number(url.searchParams.get('days') || 30)
  };
}

function getCleanupOptions(body) {
  const source = body && typeof body === 'object' ? body : {};
  const parsedRetentionDays = Number(source.retentionDays || 365);
  const retentionDays = Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0
    ? parsedRetentionDays
    : 365;
  const before = source.before
    ? String(source.before)
    : new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    before,
    dryRun: source.dryRun !== false
  };
}

function isValidDate(value) {
  return Number.isFinite(Date.parse(value || ''));
}

function validateReportPayload(raw, options = {}) {
  const payload = normalizeReportPayload(raw);
  const requireEvents = options.requireEvents === true;
  const hasEvents = raw && typeof raw === 'object' && Array.isArray(raw.events);
  if (
    !payload.batchId
    || !payload.clientId
    || (requireEvents && (!hasEvents || !payload.events.length))
  ) {
    return { error: 'invalid_batch' };
  }
  return { payload };
}

function validateBulkReportPayload(body) {
  const source = body && typeof body === 'object' ? body : {};
  const batches = Array.isArray(source.batches) ? source.batches : null;
  if (!batches || !batches.length) return { error: 'invalid_batches' };
  if (batches.length > MAX_BULK_REPORT_BATCHES) return { error: 'too_many_batches' };

  const payloads = [];
  let eventCount = 0;
  for (const raw of batches) {
    const validated = validateReportPayload(raw, { requireEvents: true });
    if (validated.error) return { error: validated.error };
    eventCount += validated.payload.events.length;
    if (eventCount > MAX_BULK_REPORT_EVENTS) return { error: 'too_many_events' };
    payloads.push(validated.payload);
  }

  return { payloads, eventCount };
}

async function saveReportBatch(storage, payload) {
  const result = await storage.saveReportBatch(payload);
  return {
    batchId: payload.batchId,
    ok: true,
    ...result
  };
}

async function saveBulkReportBatches(storage, payloads, eventCount) {
  if (typeof storage.saveBulkReportBatches === 'function') {
    const result = await storage.saveBulkReportBatches(payloads);
    return {
      ok: true,
      batchCount: payloads.length,
      eventCount,
      duplicateBatchCount: Number(result.duplicateBatchCount || 0),
      duplicateEventCount: Number(result.duplicateEventCount || 0),
      results: result.results || []
    };
  }

  const results = [];
  let duplicateBatchCount = 0;
  let duplicateEventCount = 0;

  for (const payload of payloads) {
    const result = await saveReportBatch(storage, payload);
    results.push(result);
    if (result.duplicateBatch) duplicateBatchCount += 1;
    duplicateEventCount += Number(result.duplicateEventCount || 0);
  }

  return {
    ok: true,
    batchCount: payloads.length,
    eventCount,
    duplicateBatchCount,
    duplicateEventCount,
    results
  };
}

function createApp(options) {
  const storage = options.storage;
  const secret = options.secret;
  const readCache = new Map();
  let configEnvelopeCache = null;
  if (!storage) throw new Error('storage is required');
  if (!secret) throw new Error('SYNC_SECRET is required');

  async function requireAuth(request, url) {
    return getBearer(request, url) === secret;
  }

  function getReadCache(key) {
    const cached = readCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      readCache.delete(key);
      return null;
    }
    return cached.value;
  }

  function setReadCache(key, value) {
    if (!readCache.has(key) && readCache.size >= READ_CACHE_MAX_ENTRIES) {
      const oldestKey = readCache.keys().next().value;
      if (oldestKey) readCache.delete(oldestKey);
    }
    readCache.set(key, {
      value,
      expiresAt: Date.now() + READ_CACHE_TTL_MS
    });
    return value;
  }

  function invalidateReadCache() {
    readCache.clear();
  }

  function getReadCacheKey(prefix, url) {
    const params = new URLSearchParams(url.searchParams);
    params.delete('auth');
    params.sort();
    const query = params.toString();
    return query ? `${prefix}:${query}` : prefix;
  }

  async function cachedJson(key, createValue) {
    const cached = getReadCache(key);
    if (cached) return json(cached);
    return json(setReadCache(key, await createValue()));
  }

  function getConfigEnvelopeCache() {
    if (!configEnvelopeCache || configEnvelopeCache.expiresAt <= Date.now()) {
      configEnvelopeCache = null;
      return undefined;
    }
    return configEnvelopeCache.value;
  }

  function setConfigEnvelopeCache(value) {
    configEnvelopeCache = {
      value,
      expiresAt: Date.now() + READ_CACHE_TTL_MS
    };
    return value;
  }

  async function getCachedConfigEnvelope() {
    const cached = getConfigEnvelopeCache();
    if (cached !== undefined) return cached;
    return setConfigEnvelopeCache(await storage.getConfig());
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/data') {
        return text(adminPage('data'), 200, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/analytics') {
        return text(adminPage('analytics'), 200, 'text/html; charset=utf-8');
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true });
      }
      if (!(await requireAuth(request, url))) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/api/auth/check' && request.method === 'POST') {
        return json({ ok: true });
      }

      if (url.pathname === '/api/config/sync' && request.method === 'POST') {
        const body = await readJson(request);
        const current = await getCachedConfigEnvelope();
        const merged = mergeConfig(current, body && body.config ? body.config : body);
        if (!current || !sameConfigEnvelope(current, merged)) {
          await storage.saveConfig(merged);
          setConfigEnvelopeCache(merged);
          invalidateReadCache();
        }
        return json({ config: normalizeEnvelope(merged), materialized: materializeConfig(merged) });
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('config', url), async () => {
          const config = normalizeEnvelope(await getCachedConfigEnvelope());
          return { config, materialized: materializeConfig(config) };
        });
      }

      if (url.pathname === '/api/reports' && request.method === 'POST') {
        const validated = validateReportPayload(await readJson(request));
        if (validated.error) return json({ error: validated.error }, 400);
        const result = await storage.saveReportBatch(validated.payload);
        invalidateReadCache();
        return json({ ok: true, ...result });
      }

      if (url.pathname === '/api/reports/bulk' && request.method === 'POST') {
        const validated = validateBulkReportPayload(await readJson(request));
        if (validated.error) return json({ error: validated.error }, 400);
        const result = await saveBulkReportBatches(storage, validated.payloads, validated.eventCount);
        invalidateReadCache();
        return json(result);
      }

      if (url.pathname === '/api/reports/summary' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('summary', url), () => storage.getReportSummary());
      }

      if (url.pathname === '/api/reports/cleanup' && request.method === 'POST') {
        if (typeof storage.cleanupReports !== 'function') return json({ error: 'cleanup_not_supported' }, 501);
        const cleanupOptions = getCleanupOptions(await readJson(request));
        if (!isValidDate(cleanupOptions.before)) return json({ error: 'invalid_before' }, 400);
        cleanupOptions.before = new Date(cleanupOptions.before).toISOString();
        const result = await storage.cleanupReports(cleanupOptions);
        if (!cleanupOptions.dryRun) invalidateReadCache();
        return json(result);
      }

      if (url.pathname === '/api/reports/batches' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('batches', url), () => storage.listReportBatches({
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
          includeTotal: shouldIncludeTotal(url)
        }));
      }

      if (url.pathname === '/api/reports/samples' && request.method === 'GET') {
        const options = getReportSampleOptions(url);
        if (url.searchParams.get('export') === '1') options.includeTotal = false;
        if (url.searchParams.get('export') === '1') {
          const result = await storage.listReportSamples(options);
          return text(JSON.stringify(result.items, null, 2), 200, 'application/json; charset=utf-8');
        }
        return cachedJson(getReadCacheKey('samples', url), () => storage.listReportSamples(options));
      }

      const sampleEventsMatch = url.pathname.match(/^\/api\/reports\/samples\/([^/]+)\/events$/);
      if ((url.pathname === '/api/reports/events' || sampleEventsMatch) && request.method === 'GET') {
        const sampleId = sampleEventsMatch
          ? decodeURIComponent(sampleEventsMatch[1])
          : (url.searchParams.get('sampleId') || '');
        if (!sampleId) return json({ error: 'invalid_sample' }, 400);
        return cachedJson(getReadCacheKey(`events:${url.pathname}`, url), () =>
          storage.listReportEvents(getReportEventOptions(url, sampleId)));
      }

      if (url.pathname === '/api/reports/analytics' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('analytics', url), () => storage.getReportAnalytics({
          days: Number(url.searchParams.get('days') || 30),
          tzOffsetMinutes: Number(url.searchParams.get('tzOffsetMinutes') || 0),
          clientId: url.searchParams.get('clientId') || '',
          mode: url.searchParams.get('mode') || '',
          source: url.searchParams.get('source') || '',
          category: url.searchParams.get('category') || '',
          feedback: url.searchParams.get('feedback') || '',
          section: url.searchParams.get('section') || 'all'
        }));
      }

      return json({ error: 'not_found' }, 404);
    }
  };
}

export { createApp };
