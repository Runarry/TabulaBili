import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/router.js';
import { MemoryStorage } from '../src/storage/memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function makeBatch(batchId, eventId, extra = {}) {
  return {
    batchId,
    clientId: extra.clientId || 'c1',
    capturedAt: extra.capturedAt || '2026-06-01T00:00:00.000Z',
    events: extra.events || [
      {
        eventId,
        id: extra.sampleId || eventId,
        bvid: extra.sampleId || eventId,
        title: extra.title || eventId,
        capturedAt: extra.capturedAt || '2026-06-01T00:00:00.000Z',
        mode: 'pure',
        source: 'feed',
        position: 1
      }
    ]
  };
}

class CountingStorage extends MemoryStorage {
  constructor() {
    super();
    this.configCalls = 0;
    this.summaryCalls = 0;
    this.analyticsCalls = 0;
    this.saveConfigCalls = 0;
    this.batchListCalls = [];
    this.sampleListCalls = [];
  }

  async saveConfig(config) {
    this.saveConfigCalls += 1;
    return super.saveConfig(config);
  }

  async getConfig() {
    this.configCalls += 1;
    return super.getConfig();
  }

  async getReportSummary() {
    this.summaryCalls += 1;
    return super.getReportSummary();
  }

  async getReportAnalytics(options = {}) {
    this.analyticsCalls += 1;
    return super.getReportAnalytics(options);
  }

  async listReportBatches(options = {}) {
    this.batchListCalls.push(options);
    return super.listReportBatches(options);
  }

  async listReportSamples(options = {}) {
    this.sampleListCalls.push(options);
    return super.listReportSamples(options);
  }
}

test('api routes require bearer secret', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const health = await app.fetch(new Request('http://local/api/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const rejected = await app.fetch(new Request('http://local/api/config'));
  assert.equal(rejected.status, 401);

  const accepted = await app.fetch(new Request('http://local/api/auth/check', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' }
  }));
  assert.equal(accepted.status, 200);
});

test('config sync returns merged materialized config', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const response = await app.fetch(new Request('http://local/api/config/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        fields: {
          bili_mode: { value: 'fusion', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'c1' }
        },
        rules: { items: [] }
      }
    })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.materialized.bili_mode, 'fusion');
});

test('config sync skips storage writes when config is unchanged', async () => {
  const storage = new CountingStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const config = {
    fields: {
      bili_mode: { value: 'fusion', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'c1' }
    },
    rules: {
      items: [
        { id: 'r1', type: 'up_name_exact', pattern: 'UP', enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'c1' }
      ]
    }
  };

  const first = await app.fetch(new Request('http://local/api/config/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({ config })
  }));
  assert.equal(first.status, 200);
  assert.equal(storage.saveConfigCalls, 1);
  assert.equal(storage.configCalls, 1);

  const second = await app.fetch(new Request('http://local/api/config/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({ config })
  }));
  assert.equal(second.status, 200);
  assert.equal(storage.saveConfigCalls, 1);
  assert.equal(storage.configCalls, 1);
  assert.equal((await second.json()).materialized.bili_mode, 'fusion');

  const changed = await app.fetch(new Request('http://local/api/config/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      config: {
        fields: {
          bili_mode: { value: 'origin', updatedAt: '2026-01-02T00:00:00.000Z', clientId: 'c1' }
        },
        rules: config.rules
      }
    })
  }));
  assert.equal(changed.status, 200);
  assert.equal(storage.saveConfigCalls, 2);
  assert.equal(storage.configCalls, 1);
  assert.equal((await changed.json()).materialized.bili_mode, 'origin');

  const configResponse = await app.fetch(new Request('http://local/api/config', { headers }));
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).materialized.bili_mode, 'origin');
  assert.equal(storage.configCalls, 1);
});

test('admin routes render data and analytics pages', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const data = await app.fetch(new Request('http://local/'));
  assert.equal(data.status, 200);
  const dataHtml = await data.text();
  assert.match(dataHtml, /聚合样本/);
  assert.match(dataHtml, /查看配置/);
  assert.match(dataHtml, /加载最近批次/);
  assert.match(dataHtml, /加载聚合样本/);
  assert.match(dataHtml, /return loadSummary\(\)/);
  assert.match(dataHtml, /id="loginScreen"/);
  assert.match(dataHtml, /id="appShell" hidden/);
  assert.match(dataHtml, /id="appNav" hidden/);
  assert.match(dataHtml, /const AUTH_SESSION_KEY = 'tabulabili_sync_authenticated'/);
  assert.match(dataHtml, /initAdmin\(\)/);
  assert.doesNotMatch(dataHtml, /refresh\(\)\.catch\(\(\) => setMessage\('请输入服务密钥。'\)\)/);
  assert.doesNotMatch(dataHtml, /auth=/);

  const analytics = await app.fetch(new Request('http://local/analytics'));
  assert.equal(analytics.status, 200);
  const analyticsHtml = await analytics.text();
  assert.match(analyticsHtml, /分析概览/);
  assert.match(analyticsHtml, /生成分析/);
  assert.match(analyticsHtml, /加载维度对比/);
  assert.match(analyticsHtml, /加载 Top\/重复推荐/);
  assert.match(analyticsHtml, /点击“生成分析”后读取实时分析数据/);
  assert.match(analyticsHtml, /维度对比/);
  assert.match(analyticsHtml, /重复推荐视频/);
  assert.match(analyticsHtml, /params\.set\('section', section\)/);
  assert.match(analyticsHtml, /loadAnalyticsSection\('overview'/);
  assert.match(analyticsHtml, /loadAnalyticsSection\('dimensions'/);
  assert.match(analyticsHtml, /loadAnalyticsSection\('top'/);
  assert.match(analyticsHtml, /id="loginScreen"/);
  assert.match(analyticsHtml, /id="appShell" hidden/);
  assert.doesNotMatch(analyticsHtml, /auth=/);

  const upProfiles = await app.fetch(new Request('http://local/up-profiles'));
  assert.equal(upProfiles.status, 200);
  const upHtml = await upProfiles.text();
  assert.match(upHtml, /UP画像采集/);
  assert.match(upHtml, /导入 UID/);
  assert.match(upHtml, /运行一批采集/);
  assert.match(upHtml, /LLM 分析/);
  assert.match(upHtml, /id="loginScreen"/);
  assert.match(upHtml, /id="appShell" hidden/);
  assert.doesNotMatch(upHtml, /auth=/);

  const sync = await app.fetch(new Request('http://local/sync'));
  assert.equal(sync.status, 200);
  const syncHtml = await sync.text();
  assert.match(syncHtml, /数据同步/);
  assert.match(syncHtml, /读取源端/);
  assert.match(syncHtml, /开始拉取/);
  assert.match(syncHtml, /继续拉取/);
  assert.match(syncHtml, /syncSourceUrl/);
  assert.match(syncHtml, /syncSourceSecret/);
  assert.match(syncHtml, /syncDatasetList/);
  assert.match(syncHtml, /api\/sync\/pull/);
  assert.match(syncHtml, /api\/sync\/export/);
  assert.match(syncHtml, /id="loginScreen"/);
  assert.match(syncHtml, /id="appShell" hidden/);
  assert.doesNotMatch(syncHtml, /auth=/);
});

test('bulk report endpoint saves multiple batches idempotently and preserves batch ids', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const batches = [
    makeBatch('bulk-b1', 'bulk-e1', { sampleId: 'BV_BULK_1', title: 'bulk one' }),
    makeBatch('bulk-b2', 'bulk-e2', {
      sampleId: 'BV_BULK_2',
      title: 'bulk two',
      events: [
        { eventId: 'bulk-e2', id: 'BV_BULK_2', bvid: 'BV_BULK_2', title: 'bulk two', capturedAt: '2026-06-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 2 },
        { eventId: 'bulk-e3', id: 'BV_BULK_2', bvid: 'BV_BULK_2', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z' }
      ]
    })
  ];

  const response = await app.fetch(new Request('http://local/api/reports/bulk', {
    method: 'POST',
    headers,
    body: JSON.stringify({ batches })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.batchCount, 2);
  assert.equal(body.eventCount, 3);
  assert.equal(body.duplicateBatchCount, 0);
  assert.deepEqual(body.results.map((item) => item.batchId), ['bulk-b1', 'bulk-b2']);

  const duplicateResponse = await app.fetch(new Request('http://local/api/reports/bulk', {
    method: 'POST',
    headers,
    body: JSON.stringify({ batches })
  }));
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicateBatchCount, 2);
  assert.equal(duplicate.duplicateEventCount, 3);

  const summaryResponse = await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  const summary = await summaryResponse.json();
  assert.equal(summary.batchCount, 2);
  assert.equal(summary.eventCount, 3);

  const batchesResponse = await app.fetch(new Request('http://local/api/reports/batches', { headers }));
  const listed = await batchesResponse.json();
  assert.equal(listed.total, 2);
  assert.deepEqual(new Set(listed.items.map((item) => item.batchId)), new Set(['bulk-b1', 'bulk-b2']));
});

test('bulk report endpoint validates payload before saving', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const tooManyBatches = Array.from({ length: 51 }, (_, index) => makeBatch(`limit-b${index}`, `limit-e${index}`));
  const tooManyEvents = Array.from({ length: 2001 }, (_, index) => ({
    eventId: `limit-event-${index}`,
    id: `BV_LIMIT_${index}`,
    capturedAt: '2026-06-01T00:00:00.000Z'
  }));
  const cases = [
    [{ batches: [] }, 'invalid_batches'],
    [{ batches: [makeBatch('', 'missing-batch-id')] }, 'invalid_batch'],
    [{ batches: [{ ...makeBatch('missing-client', 'missing-client-event'), clientId: '' }] }, 'invalid_batch'],
    [{ batches: [{ batchId: 'missing-events', clientId: 'c1' }] }, 'invalid_batch'],
    [{ batches: tooManyBatches }, 'too_many_batches'],
    [{ batches: [makeBatch('too-many-events', 'unused', { events: tooManyEvents })] }, 'too_many_events'],
    [{ batches: [makeBatch('partial-valid', 'partial-valid-event'), { batchId: 'partial-invalid', events: [] }] }, 'invalid_batch']
  ];

  for (const [payload, error] of cases) {
    const response = await app.fetch(new Request('http://local/api/reports/bulk', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, error);
  }

  const summaryResponse = await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  const summary = await summaryResponse.json();
  assert.equal(summary.batchCount, 0);
  assert.equal(summary.eventCount, 0);
});

test('report list endpoints can skip totals for on-demand admin reads', async () => {
  const storage = new CountingStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  await app.fetch(new Request('http://local/api/reports/bulk', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batches: [
        makeBatch('skip-total-b1', 'skip-total-e1', { sampleId: 'BV_SKIP_1' }),
        makeBatch('skip-total-b2', 'skip-total-e2', { sampleId: 'BV_SKIP_2' })
      ]
    })
  }));

  const batchesResponse = await app.fetch(new Request('http://local/api/reports/batches?limit=1&includeTotal=0', { headers }));
  const batches = await batchesResponse.json();
  assert.equal(batches.items.length, 1);
  assert.equal(batches.hasMore, true);
  assert.equal(Object.hasOwn(batches, 'total'), false);
  assert.equal(storage.batchListCalls.at(-1).includeTotal, false);

  const samplesResponse = await app.fetch(new Request('http://local/api/reports/samples?limit=1&includeTotal=0', { headers }));
  const samples = await samplesResponse.json();
  assert.equal(samples.items.length, 1);
  assert.equal(samples.hasMore, true);
  assert.equal(Object.hasOwn(samples, 'total'), false);
  assert.equal(storage.sampleListCalls.at(-1).includeTotal, false);

  const defaultResponse = await app.fetch(new Request('http://local/api/reports/batches?limit=1', { headers }));
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.total, 2);
  assert.equal(storage.batchListCalls.at(-1).includeTotal, true);
});

test('read endpoints use short ttl cache and are invalidated after writes', async () => {
  const storage = new CountingStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  await app.fetch(new Request('http://local/api/config', { headers }));
  await app.fetch(new Request('http://local/api/config', { headers }));
  assert.equal(storage.configCalls, 1);

  await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  assert.equal(storage.summaryCalls, 1);

  await app.fetch(new Request('http://local/api/reports/batches?limit=1&includeTotal=0', { headers }));
  await app.fetch(new Request('http://local/api/reports/batches?includeTotal=0&limit=1', { headers }));
  assert.equal(storage.batchListCalls.length, 1);

  await app.fetch(new Request('http://local/api/reports/samples?limit=1&includeTotal=0', { headers }));
  await app.fetch(new Request('http://local/api/reports/samples?includeTotal=0&limit=1', { headers }));
  assert.equal(storage.sampleListCalls.length, 1);

  await app.fetch(new Request('http://local/api/reports/analytics?days=90&tzOffsetMinutes=0', { headers }));
  await app.fetch(new Request('http://local/api/reports/analytics?tzOffsetMinutes=0&days=90', { headers }));
  assert.equal(storage.analyticsCalls, 1);

  const response = await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify(makeBatch('cache-b1', 'cache-e1', { sampleId: 'BV_CACHE', title: 'cache' }))
  }));
  assert.equal(response.status, 200);

  await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  await app.fetch(new Request('http://local/api/reports/batches?limit=1&includeTotal=0', { headers }));
  await app.fetch(new Request('http://local/api/reports/samples?limit=1&includeTotal=0', { headers }));
  await app.fetch(new Request('http://local/api/reports/analytics?days=90&tzOffsetMinutes=0', { headers }));
  assert.equal(storage.summaryCalls, 2);
  assert.equal(storage.batchListCalls.length, 2);
  assert.equal(storage.sampleListCalls.length, 2);
  assert.equal(storage.analyticsCalls, 2);
});

test('bulk report endpoint accepts documented maximum payload size', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const batches = Array.from({ length: 50 }, (_, batchIndex) => ({
    batchId: `max-b${batchIndex}`,
    clientId: 'c1',
    capturedAt: '2026-06-01T00:00:00.000Z',
    events: Array.from({ length: 40 }, (_, eventIndex) => ({
      eventId: `max-e${batchIndex}-${eventIndex}`,
      id: `BV_MAX_${batchIndex}_${eventIndex}`,
      capturedAt: '2026-06-01T00:00:00.000Z',
      mode: 'pure',
      source: 'feed',
      position: eventIndex + 1
    }))
  }));

  const response = await app.fetch(new Request('http://local/api/reports/bulk', {
    method: 'POST',
    headers,
    body: JSON.stringify({ batches })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.batchCount, 50);
  assert.equal(body.eventCount, 2000);

  const summaryResponse = await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  const summary = await summaryResponse.json();
  assert.equal(summary.batchCount, 50);
  assert.equal(summary.eventCount, 2000);
});

test('report cleanup supports dry run and actual deletion', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId: 'cleanup-b1',
      clientId: 'c1',
      capturedAt: daysAgo(40),
      events: [
        { eventId: 'cleanup-e1', id: 'BV_OLD', bvid: 'BV_OLD', title: 'old', capturedAt: daysAgo(40), mode: 'pure', source: 'feed', position: 1 }
      ]
    })
  }));

  const dryRunResponse = await app.fetch(new Request('http://local/api/reports/cleanup', {
    method: 'POST',
    headers,
    body: JSON.stringify({ before: daysAgo(10), dryRun: true })
  }));
  const dryRun = await dryRunResponse.json();
  assert.equal(dryRun.matched.events, 1);
  assert.equal(dryRun.matched.orphanSamples, 1);
  assert.equal(dryRun.deleted.events, 0);

  const cleanupResponse = await app.fetch(new Request('http://local/api/reports/cleanup', {
    method: 'POST',
    headers,
    body: JSON.stringify({ before: daysAgo(10), dryRun: false })
  }));
  const cleanup = await cleanupResponse.json();
  assert.equal(cleanup.deleted.events, 1);
  assert.equal(cleanup.deleted.orphanSamples, 1);

  const summary = await app.fetch(new Request('http://local/api/reports/summary', { headers }));
  const body = await summary.json();
  assert.equal(body.eventCount, 0);
  assert.equal(body.sampleCount, 0);
});

test('sync export endpoint requires auth and paginates datasets', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  const unauthorized = await app.fetch(new Request('http://local/api/sync/export?dataset=report_events'));
  assert.equal(unauthorized.status, 401);

  const manifest = await app.fetch(new Request('http://local/api/sync/export', { headers }));
  assert.equal(manifest.status, 200);
  const manifestBody = await manifest.json();
  assert.equal(manifestBody.version, 1);
  assert.equal(manifestBody.datasets.includes('report_events'), true);
  assert.equal(manifestBody.datasets.includes('up_portraits'), true);

  await storage.saveReportBatch(makeBatch('sync-page-b1', 'sync-page-e1', {
    sampleId: 'BV_SYNC_PAGE',
    events: [
      { eventId: 'sync-page-e1', id: 'BV_SYNC_PAGE', bvid: 'BV_SYNC_PAGE', title: 'page', capturedAt: '2026-06-01T00:00:00.000Z' },
      { eventId: 'sync-page-e2', id: 'BV_SYNC_PAGE', bvid: 'BV_SYNC_PAGE', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z' }
    ]
  }));

  const first = await app.fetch(new Request('http://local/api/sync/export?dataset=report_events&limit=1', { headers }));
  assert.equal(first.status, 200);
  const firstPage = await first.json();
  assert.equal(firstPage.version, 1);
  assert.equal(firstPage.dataset, 'report_events');
  assert.equal(firstPage.count, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextCursor, '1');
  assert.equal(firstPage.items[0].eventId, 'sync-page-e1');

  const second = await app.fetch(new Request(`http://local/api/sync/export?dataset=report_events&limit=1&cursor=${firstPage.nextCursor}`, { headers }));
  const secondPage = await second.json();
  assert.equal(secondPage.count, 1);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.items[0].eventId, 'sync-page-e2');

  const invalid = await app.fetch(new Request('http://local/api/sync/export?dataset=read_cache', { headers }));
  assert.equal(invalid.status, 400);
});

async function seedSyncSource(storage) {
  await storage.saveConfig({
    fields: {
      bili_mode: { value: 'fusion', updatedAt: '2026-06-01T00:00:00.000Z', clientId: 'sync-source' }
    },
    rules: { items: [] }
  });
  await storage.saveReportBatch({
    batchId: 'sync-b1',
    clientId: 'sync-client',
    capturedAt: '2026-06-01T00:00:00.000Z',
    events: [
      {
        eventId: 'sync-e1',
        id: 'BV_SYNC_1',
        bvid: 'BV_SYNC_1',
        title: 'sync video',
        upName: 'Sync UP',
        upMid: '12345',
        category: 'tech',
        capturedAt: '2026-06-01T00:00:00.000Z',
        mode: 'fusion',
        source: 'feed',
        position: 1
      },
      {
        eventId: 'sync-e2',
        id: 'BV_SYNC_1',
        bvid: 'BV_SYNC_1',
        eventKind: 'click',
        upMid: '12345',
        category: 'tech',
        capturedAt: '2026-06-01T00:01:00.000Z',
        mode: 'fusion',
        source: 'feed'
      },
      {
        eventId: 'sync-e3',
        id: 'BV_SYNC_1',
        bvid: 'BV_SYNC_1',
        eventKind: 'feedback',
        feedback: 'like',
        upMid: '12345',
        category: 'tech',
        capturedAt: '2026-06-01T00:02:00.000Z',
        mode: 'fusion',
        source: 'feed'
      }
    ]
  });
  await storage.importUpTargets(['12345'], {
    source: 'manual',
    seedBvid: 'BV_SYNC_1',
    note: 'sync seed',
    priority: 5
  });
  await storage.updateUpTargetStatus('12345', {
    name: 'Sync UP',
    status: 'success',
    lastCollectedAt: '2026-06-01T01:00:00.000Z',
    nextCollectAfter: '2026-06-02T01:00:00.000Z',
    lastErrorType: '',
    lastErrorMessage: '',
    failureCount: 0,
    updatedAt: '2026-06-01T01:00:00.000Z'
  });
  await storage.saveUpProfileSnapshot({
    mid: '12345',
    name: 'Sync UP',
    face: 'https://example.invalid/face.jpg',
    sign: 'sync sign',
    level: 6,
    officialType: 0,
    officialTitle: '',
    vipType: 2,
    vipStatus: 1,
    followerCount: 1000,
    followingCount: 10,
    archiveCount: 20,
    articleCount: 3,
    albumCount: 4,
    favoriteCount: 5,
    likeCount: 600,
    cardJson: { mid: '12345' },
    relationJson: { following: 10 },
    navJson: { video: 20 },
    capturedAt: '2026-06-01T01:00:00.000Z'
  });
  await storage.upsertUpVideo({
    bvid: 'BV_SYNC_1',
    aid: '1001',
    mid: '12345',
    title: 'sync video',
    description: 'desc',
    coverUrl: 'https://example.invalid/cover.jpg',
    tname: 'tech',
    tid: 1,
    duration: 120,
    pubdate: 1780275600,
    publishedAt: '2026-06-01T00:00:00.000Z',
    ownerName: 'Sync UP',
    copyright: 1,
    videos: 1,
    viewCount: 100,
    danmakuCount: 2,
    replyCount: 3,
    favoriteCount: 4,
    coinCount: 5,
    shareCount: 6,
    likeCount: 7,
    tags: ['sync'],
    pages: [{ page: 1 }],
    rawJson: { bvid: 'BV_SYNC_1' }
  });
  await storage.saveVideoMetricSnapshot({
    bvid: 'BV_SYNC_1',
    mid: '12345',
    capturedAt: '2026-06-01T01:05:00.000Z',
    viewCount: 100,
    danmakuCount: 2,
    replyCount: 3,
    favoriteCount: 4,
    coinCount: 5,
    shareCount: 6,
    likeCount: 7
  });
  await storage.createCollectorRun({
    runId: 'sync-run-1',
    kind: 'manual',
    mid: '12345',
    status: 'success',
    startedAt: '2026-06-01T01:00:00.000Z',
    finishedAt: '2026-06-01T01:06:00.000Z',
    targetCount: 1,
    collectedCount: 1,
    videoCount: 1,
    options: { maxTargets: 1 }
  });
  await storage.saveUpPortrait({
    mid: '12345',
    rulePortrait: { primaryCategory: 'tech' },
    llmPortrait: {
      summary: 'sync summary',
      contentPositioning: 'positioning',
      audienceHypothesis: 'audience',
      contentStyle: 'style',
      commercialFit: 'fit',
      risks: ['risk'],
      evidence: ['evidence'],
      provider: 'test',
      model: 'model',
      promptVersion: 'v1',
      generatedAt: '2026-06-01T01:10:00.000Z'
    }
  });
}

test('sync pull copies business datasets and is idempotent', async () => {
  const sourceStorage = new MemoryStorage();
  const targetStorage = new MemoryStorage();
  await seedSyncSource(sourceStorage);

  const sourceApp = createApp({ secret: 'source-secret', storage: sourceStorage });
  const targetApp = createApp({
    secret: 'target-secret',
    storage: targetStorage,
    fetcher: (request) => sourceApp.fetch(request)
  });
  const headers = { authorization: 'Bearer target-secret', 'content-type': 'application/json' };
  const requestBody = {
    sourceUrl: 'http://source.local',
    sourceSecret: 'source-secret',
    limit: 1,
    maxPages: 50
  };

  const unauthorized = await targetApp.fetch(new Request('http://target.local/api/sync/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  }));
  assert.equal(unauthorized.status, 401);

  const pulled = await targetApp.fetch(new Request('http://target.local/api/sync/pull', {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  }));
  assert.equal(pulled.status, 200);
  const first = await pulled.json();
  assert.equal(first.ok, true);
  assert.equal(first.complete, true);
  assert.equal(first.stats.datasets.config.read, 1);
  assert.equal(first.stats.datasets.report_events.read, 3);
  assert.equal(first.stats.datasets.up_portraits.read, 1);
  assert.equal(first.stats.total.errorCount, 0);

  const config = await targetStorage.getConfig();
  assert.equal(config.fields.bili_mode.value, 'fusion');

  const summary = await targetStorage.getReportSummary();
  assert.deepEqual(summary, {
    batchCount: 1,
    eventCount: 3,
    duplicateEventCount: 0,
    sampleCount: 1
  });

  const dailyMetrics = await targetStorage.exportSyncDataset({ dataset: 'daily_metrics' });
  assert.equal(dailyMetrics.items.length, 1);
  assert.deepEqual({
    impressions: dailyMetrics.items[0].impressions,
    clicks: dailyMetrics.items[0].clicks,
    feedbacks: dailyMetrics.items[0].feedbacks
  }, { impressions: 1, clicks: 1, feedbacks: 1 });

  const profile = await targetStorage.getUpProfile('12345');
  assert.equal(profile.target.name, 'Sync UP');
  assert.equal(profile.profile.followerCount, 1000);
  assert.equal(profile.videoStats.videoCount, 1);
  assert.equal(profile.portrait.summary, 'sync summary');

  const videos = await targetStorage.listUpVideos({ mid: '12345' });
  assert.equal(videos.total, 1);
  assert.equal(videos.items[0].viewCount, 100);

  const metrics = await targetStorage.exportSyncDataset({ dataset: 'video_metric_snapshots' });
  assert.equal(metrics.items.length, 1);
  assert.equal(metrics.items[0].bvid, 'BV_SYNC_1');

  const run = await targetStorage.getCollectorRun('sync-run-1');
  assert.equal(run.status, 'success');
  assert.equal(run.videoCount, 1);

  const repeated = await targetApp.fetch(new Request('http://target.local/api/sync/pull', {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  }));
  assert.equal(repeated.status, 200);
  const second = await repeated.json();
  assert.equal(second.complete, true);
  assert.equal(second.stats.total.inserted, 0);
  assert.equal(second.stats.total.updated, 0);
  assert.equal(second.stats.total.errorCount, 0);
  assert.ok(second.stats.total.skipped >= first.stats.total.read);

  const repeatedSummary = await targetStorage.getReportSummary();
  assert.deepEqual(repeatedSummary, summary);
  const repeatedMetrics = await targetStorage.exportSyncDataset({ dataset: 'video_metric_snapshots' });
  assert.equal(repeatedMetrics.items.length, 1);
});

test('report APIs expose paginated samples and analytics', async () => {
  const storage = new MemoryStorage();
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId: 'b1',
      clientId: 'c1',
      capturedAt: '2026-06-01T00:00:00.000Z',
      events: [
        { eventId: 'e1', id: 'BV1', bvid: 'BV1', title: 'alpha', upName: 'up', capturedAt: '2026-06-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 1 },
        { eventId: 'e2', id: 'BV1', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z' }
      ]
    })
  }));

  const samplesResponse = await app.fetch(new Request('http://local/api/reports/samples?limit=1&q=alpha&sort=clickCount', { headers }));
  assert.equal(samplesResponse.status, 200);
  const samples = await samplesResponse.json();
  assert.equal(samples.total, 1);
  assert.equal(samples.items[0].clickCount, 1);

  const filteredSamplesResponse = await app.fetch(new Request('http://local/api/reports/samples?mode=pure&source=feed&minSeenCount=1', { headers }));
  const filteredSamples = await filteredSamplesResponse.json();
  assert.equal(filteredSamples.total, 1);

  const analyticsResponse = await app.fetch(new Request('http://local/api/reports/analytics?days=90&tzOffsetMinutes=0', { headers }));
  assert.equal(analyticsResponse.status, 200);
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.metrics.clickCount, 1);

  const eventResponse = await app.fetch(new Request('http://local/api/reports/samples/BV1/events?days=90', { headers }));
  assert.equal(eventResponse.status, 200);
  const events = await eventResponse.json();
  assert.equal(events.total, 2);
  assert.equal(events.items[0].eventKind, 'click');
});
