import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/router.js';
import { MemoryStorage } from '../src/storage/memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

test('api routes require bearer secret', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
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

test('admin routes render data and analytics pages', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const data = await app.fetch(new Request('http://local/'));
  assert.equal(data.status, 200);
  const dataHtml = await data.text();
  assert.match(dataHtml, /聚合样本/);
  assert.doesNotMatch(dataHtml, /auth=/);

  const analytics = await app.fetch(new Request('http://local/analytics'));
  assert.equal(analytics.status, 200);
  const analyticsHtml = await analytics.text();
  assert.match(analyticsHtml, /分析概览/);
  assert.match(analyticsHtml, /维度对比/);
  assert.match(analyticsHtml, /重复推荐视频/);
  assert.doesNotMatch(analyticsHtml, /auth=/);
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
