import { adminPage } from './admin-page.js';
import { BilibiliClient } from './bilibili-client.js';
import { materializeConfig, mergeConfig, normalizeEnvelope, sameConfigEnvelope } from './config-merge.js';
import { createLlmProvider } from './llm-provider.js';
import { normalizeReportPayload } from './report-aggregate.js';
import {
  SYNC_DATASET_NAMES,
  SYNC_DATA_VERSION,
  normalizeSyncLimit
} from './storage/sync-data.js';
import { UpCollector, compactError, generateUpPortrait } from './up-collector.js';
import { buildRulePortrait } from './up-portrait-rules.js';

const MAX_BULK_REPORT_BATCHES = 50;
const MAX_BULK_REPORT_EVENTS = 2000;
const READ_CACHE_TTL_MS = 30 * 1000;
const READ_CACHE_MAX_ENTRIES = 100;
const SYNC_PULL_DEFAULT_MAX_PAGES = 50;
const SYNC_PULL_MAX_PAGES = 500;

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

function normalizeMidList(body) {
  const source = body && typeof body === 'object' ? body : {};
  const raw = Array.isArray(source.mids)
    ? source.mids
    : String(source.mids || source.mid || '')
      .split(/[\s,，;；]+/);
  return [...new Set(raw.map((item) => String(item || '').trim()).filter((item) => /^\d+$/.test(item)))];
}

function getCollectorOptions(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    maxTargets: source.maxTargets,
    includeArchives: source.includeArchives,
    includeKnownVideos: source.includeKnownVideos,
    maxPages: source.maxPages,
    existingMaxPages: source.existingMaxPages,
    pageSize: source.pageSize,
    maxVideos: source.maxVideos,
    requestIntervalMs: source.requestIntervalMs,
    successRefreshHours: source.successRefreshHours
  };
}

function normalizeSyncDatasets(value) {
  if (value == null || value === '') return { datasets: SYNC_DATASET_NAMES, invalid: [] };
  const raw = Array.isArray(value)
    ? value
    : String(value).split(/[\s,，;；]+/);
  const requested = raw.map((item) => String(item || '').trim()).filter(Boolean);
  if (!requested.length || requested.includes('all')) return { datasets: SYNC_DATASET_NAMES, invalid: [] };
  const known = new Set(SYNC_DATASET_NAMES);
  const invalid = requested.filter((item) => !known.has(item));
  return {
    datasets: [...new Set(requested.filter((item) => known.has(item)))],
    invalid
  };
}

function normalizeSyncMaxPages(value) {
  const number = Number(value || SYNC_PULL_DEFAULT_MAX_PAGES);
  const fallback = SYNC_PULL_DEFAULT_MAX_PAGES;
  return Math.min(SYNC_PULL_MAX_PAGES, Math.max(1, Number.isFinite(number) ? Math.floor(number) : fallback));
}

function createSyncPullStats() {
  return {
    total: {
      read: 0,
      written: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errorCount: 0
    },
    datasets: {}
  };
}

function ensureDatasetStats(stats, dataset) {
  if (!stats.datasets[dataset]) {
    stats.datasets[dataset] = {
      read: 0,
      written: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errorCount: 0,
      pages: 0,
      errors: []
    };
  }
  return stats.datasets[dataset];
}

function mergeSyncImportStats(stats, dataset, imported) {
  const target = ensureDatasetStats(stats, dataset);
  target.pages += 1;
  for (const key of ['read', 'written', 'inserted', 'updated', 'skipped', 'errorCount']) {
    const value = Number(imported && imported[key] || 0);
    target[key] += value;
    stats.total[key] += value;
  }
  for (const error of imported && imported.errors || []) {
    if (target.errors.length < 10) target.errors.push(error);
  }
}

function redactSecretText(value) {
  return String(value || '').replace(/Bearer\s+[^,\s)]+/gi, 'Bearer <redacted>');
}

function buildSourceExportUrl(sourceUrl, dataset, cursor, limit) {
  const url = new URL(sourceUrl);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/sync/export`;
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', String(cursor));
  return url;
}

async function fetchSourceSyncPage(fetcher, { sourceUrl, sourceSecret, dataset, cursor, limit }) {
  const url = buildSourceExportUrl(sourceUrl, dataset, cursor, limit);
  const response = await fetcher(new Request(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${sourceSecret}` }
  }));
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error(body && (body.error || body.message) || `source_http_${response.status}`);
    error.sourceStatus = response.status;
    throw error;
  }
  if (!body || body.version !== SYNC_DATA_VERSION || body.dataset !== dataset || !Array.isArray(body.items)) {
    throw new Error('invalid_source_sync_export');
  }
  return body;
}

function normalizeSyncPullRequest(body, targetSecret) {
  const source = body && typeof body === 'object' ? body : {};
  const sourceUrl = String(source.sourceUrl || '').trim();
  const sourceSecret = String(source.sourceSecret || source.secret || targetSecret || '').trim();
  if (!sourceUrl) return { error: 'invalid_source_url' };
  let parsedUrl = null;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return { error: 'invalid_source_url' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return { error: 'invalid_source_url' };
  if (!sourceSecret) return { error: 'invalid_source_secret' };

  const { datasets, invalid } = normalizeSyncDatasets(source.datasets);
  if (invalid.length) return { error: 'invalid_sync_dataset', invalid };
  const cursors = source.cursors && typeof source.cursors === 'object' && !Array.isArray(source.cursors)
    ? source.cursors
    : {};
  return {
    sourceUrl,
    sourceSecret,
    datasets,
    cursors,
    limit: normalizeSyncLimit(source.limit),
    maxPages: normalizeSyncMaxPages(source.maxPages)
  };
}

async function pullSyncData({ storage, fetcher, request }) {
  const stats = createSyncPullStats();
  const nextCursors = {};
  let pages = 0;

  for (let index = 0; index < request.datasets.length; index += 1) {
    const dataset = request.datasets[index];
    let cursor = String(request.cursors[dataset] || '');

    if (pages >= request.maxPages) {
      for (const pending of request.datasets.slice(index)) {
        nextCursors[pending] = String(request.cursors[pending] || '');
      }
      break;
    }

    while (pages < request.maxPages) {
      let page = null;
      try {
        page = await fetchSourceSyncPage(fetcher, {
          sourceUrl: request.sourceUrl,
          sourceSecret: request.sourceSecret,
          dataset,
          cursor,
          limit: request.limit
        });
      } catch (error) {
        error.dataset = dataset;
        error.cursor = cursor;
        error.stats = stats;
        throw error;
      }

      pages += 1;
      const imported = await storage.importSyncDataset(dataset, page.items);
      mergeSyncImportStats(stats, dataset, imported);

      if (!page.hasMore) {
        cursor = '';
        break;
      }
      cursor = String(page.nextCursor || '');
      if (!cursor) {
        const error = new Error('missing_source_next_cursor');
        error.dataset = dataset;
        error.stats = stats;
        throw error;
      }
    }

    if (cursor) {
      nextCursors[dataset] = cursor;
      for (const pending of request.datasets.slice(index + 1)) {
        nextCursors[pending] = String(request.cursors[pending] || '');
      }
      break;
    }
  }

  const pendingDatasets = Object.keys(nextCursors);
  return {
    ok: true,
    version: SYNC_DATA_VERSION,
    complete: pendingDatasets.length === 0,
    pages,
    limit: request.limit,
    maxPages: request.maxPages,
    datasets: request.datasets,
    stats,
    next: pendingDatasets.length
      ? { datasets: pendingDatasets, cursors: nextCursors, limit: request.limit }
      : null
  };
}

function getUpListOptions(url) {
  return {
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
    includeTotal: shouldIncludeTotal(url),
    q: url.searchParams.get('q') || '',
    status: url.searchParams.get('status') || '',
    sort: url.searchParams.get('sort') || ''
  };
}

function apiErrorResponse(error) {
  const info = compactError(error);
  const type = info.type || error && error.name || 'error';
  const message = info.message || String(error && error.message || error || 'error');
  if (message === 'invalid_mid' || message === 'invalid_video') return { status: 400, body: { error: message } };
  return {
    status: 502,
    body: {
      error: type,
      message,
      code: info.code,
      status: info.status,
      retryable: info.retryable,
      endpoint: info.endpoint,
      hint: info.hint
    }
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
  const env = options.env || {};
  const fetcher = options.fetcher || options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const collectorFactory = options.collectorFactory;
  const llmProviderFactory = options.llmProviderFactory;
  const readCache = new Map();
  let configEnvelopeCache = null;
  if (!storage) throw new Error('storage is required');
  if (!secret) throw new Error('SYNC_SECRET is required');

  function createCollector() {
    if (collectorFactory) return collectorFactory({ storage });
    return new UpCollector({
      storage,
      client: options.biliClient || new BilibiliClient({
        fetcher,
        timeoutMs: env.BILI_TIMEOUT_MS
      })
    });
  }

  function createPortraitProvider() {
    if (options.llmProvider) return options.llmProvider;
    if (llmProviderFactory) return llmProviderFactory({ storage });
    return createLlmProvider({ env, fetcher });
  }

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
      if (url.pathname === '/up-profiles') {
        return text(adminPage('up-profiles'), 200, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/sync') {
        return text(adminPage('sync'), 200, 'text/html; charset=utf-8');
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true });
      }
      if (!(await requireAuth(request, url))) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/api/auth/check' && request.method === 'POST') {
        return json({ ok: true });
      }

      if (url.pathname === '/api/sync/export' && request.method === 'GET') {
        if (typeof storage.exportSyncDataset !== 'function') return json({ error: 'sync_export_not_supported' }, 501);
        const dataset = url.searchParams.get('dataset') || '';
        if (!dataset) {
          return json({
            version: SYNC_DATA_VERSION,
            datasets: SYNC_DATASET_NAMES,
            defaultLimit: 200,
            maxLimit: 1000
          });
        }
        const { invalid } = normalizeSyncDatasets([dataset]);
        if (invalid.length) return json({ error: 'invalid_sync_dataset', invalid }, 400);
        return json(await storage.exportSyncDataset({
          dataset,
          cursor: url.searchParams.get('cursor') || '',
          limit: url.searchParams.get('limit') || ''
        }));
      }

      if (url.pathname === '/api/sync/pull' && request.method === 'POST') {
        if (typeof storage.importSyncDataset !== 'function') return json({ error: 'sync_import_not_supported' }, 501);
        if (typeof fetcher !== 'function') return json({ error: 'fetch_not_supported' }, 501);
        const normalized = normalizeSyncPullRequest(await readJson(request), secret);
        if (normalized.error) return json(normalized, 400);
        try {
          const result = await pullSyncData({ storage, fetcher, request: normalized });
          if (result.stats.total.written > 0) {
            configEnvelopeCache = null;
            invalidateReadCache();
          }
          return json(result);
        } catch (error) {
          if (error.stats && error.stats.total.written > 0) {
            configEnvelopeCache = null;
            invalidateReadCache();
          }
          return json({
            error: 'sync_pull_failed',
            message: redactSecretText(error && error.message || error),
            dataset: error && error.dataset || '',
            cursor: error && error.cursor || '',
            sourceStatus: error && error.sourceStatus,
            stats: error && error.stats
          }, 502);
        }
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

      if (url.pathname === '/api/up-targets/import' && request.method === 'POST') {
        const body = await readJson(request);
        const mids = normalizeMidList(body);
        if (!mids.length) return json({ error: 'invalid_mids' }, 400);
        const result = await storage.importUpTargets(mids, {
          source: body && (body.source || body.seedSource) || 'manual',
          seedBvid: body && (body.seedBvid || body.bvid) || '',
          note: body && body.note || '',
          priority: body && body.priority || 0
        });
        invalidateReadCache();
        return json({ ok: true, ...result });
      }

      if (url.pathname === '/api/up-targets' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('up-targets', url), () => storage.listUpTargets(getUpListOptions(url)));
      }

      const collectMatch = url.pathname.match(/^\/api\/up-targets\/(\d+)\/collect$/);
      if (collectMatch && request.method === 'POST') {
        const body = await readJson(request);
        const mid = collectMatch[1];
        await storage.importUpTargets([mid], { source: 'manual' });
        try {
          const result = await createCollector().collectMid(mid, {
            ...getCollectorOptions(body),
            createRun: true
          });
          invalidateReadCache();
          return json(result);
        } catch (error) {
          invalidateReadCache();
          const response = apiErrorResponse(error);
          return json(response.body, response.status);
        }
      }

      if (url.pathname === '/api/collector/run' && request.method === 'POST') {
        const body = await readJson(request);
        try {
          const result = await createCollector().runBatch(getCollectorOptions(body));
          invalidateReadCache();
          return json(result);
        } catch (error) {
          invalidateReadCache();
          const response = apiErrorResponse(error);
          return json(response.body, response.status);
        }
      }

      const portraitGenerateMatch = url.pathname.match(/^\/api\/up-profiles\/(\d+)\/portrait\/generate$/);
      if (portraitGenerateMatch && request.method === 'POST') {
        const mid = portraitGenerateMatch[1];
        await storage.importUpTargets([mid], { source: 'manual' });
        const result = await generateUpPortrait({
          storage,
          mid,
          llmProvider: createPortraitProvider()
        });
        invalidateReadCache();
        return json(result, result.ok ? 200 : 502);
      }

      const profileMatch = url.pathname.match(/^\/api\/up-profiles\/(\d+)$/);
      if (profileMatch && request.method === 'GET') {
        const mid = profileMatch[1];
        return cachedJson(getReadCacheKey(`up-profile:${mid}`, url), async () => {
          const profile = await storage.getUpProfile(mid);
          const storedRule = profile && profile.portrait && profile.portrait.rulePortrait;
          const hasStoredRule = storedRule && Object.keys(storedRule).length > 0;
          const rulePortrait = hasStoredRule
            ? storedRule
            : buildRulePortrait({
              profile: profile && profile.profile,
              videos: (await storage.listUpVideos({ mid, limit: 100, includeTotal: false, sort: 'pubdate' })).items || []
            });
          return {
            ...profile,
            rulePortrait,
            llmPortrait: profile && profile.portrait ? profile.portrait.llmPortrait : null
          };
        });
      }

      if (url.pathname === '/api/up-profiles' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('up-profiles', url), () => storage.listUpProfiles(getUpListOptions(url)));
      }

      if (url.pathname === '/api/up-videos' && request.method === 'GET') {
        return cachedJson(getReadCacheKey('up-videos', url), () => storage.listUpVideos({
          mid: url.searchParams.get('mid') || '',
          q: url.searchParams.get('q') || '',
          sort: url.searchParams.get('sort') || '',
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
          includeTotal: shouldIncludeTotal(url)
        }));
      }

      return json({ error: 'not_found' }, 404);
    }
  };
}

export { createApp };
