import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function byKey(rows, key) {
  return rows.find((row) => row.key === key);
}

test('report batches and events are idempotent', async () => {
  const storage = new MemoryStorage();
  const batch = {
    batchId: 'b1',
    clientId: 'c1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    events: [
      { eventId: 'e1', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up', capturedAt: '2026-01-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 1 }
    ]
  };

  assert.equal((await storage.saveReportBatch(batch)).duplicateBatch, false);
  assert.equal((await storage.saveReportBatch(batch)).duplicateBatch, true);

  const second = await storage.saveReportBatch({ ...batch, batchId: 'b2' });
  assert.equal(second.duplicateEventCount, 1);

  const summary = await storage.getReportSummary();
  assert.equal(summary.batchCount, 2);
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.sampleCount, 1);
});

test('click and feedback report events update aggregate without adding impressions', async () => {
  const storage = new MemoryStorage();
  await storage.saveReportBatch({
    batchId: 'b1',
    clientId: 'c1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    events: [
      { eventId: 'e1', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up', capturedAt: '2026-01-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 1 }
    ]
  });
  await storage.saveReportBatch({
    batchId: 'b2',
    clientId: 'c1',
    capturedAt: '2026-01-01T00:01:00.000Z',
    events: [
      { eventId: 'e2', id: 'BV1', bvid: 'BV1', eventKind: 'click', capturedAt: '2026-01-01T00:01:00.000Z' },
      { eventId: 'e3', id: 'BV1', bvid: 'BV1', eventKind: 'feedback', feedback: 'dislike', capturedAt: '2026-01-01T00:02:00.000Z' }
    ]
  });

  const samples = await storage.listReportSamples({ limit: 10 });
  assert.equal(samples.total, 1);
  assert.equal(samples.items[0].seenCount, 1);
  assert.equal(samples.items[0].clickCount, 1);
  assert.equal(samples.items[0].feedback, 'dislike');
});

test('report samples support pagination search feedback filter and analytics', async () => {
  const storage = new MemoryStorage();
  await storage.saveReportBatch({
    batchId: 'b1',
    clientId: 'c1',
    capturedAt: '2026-06-01T00:00:00.000Z',
    events: [
      { eventId: 'e1', id: 'BV1', bvid: 'BV1', title: 'alpha', upName: 'first', category: 'cat-a', capturedAt: '2026-06-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 1 },
      { eventId: 'e2', id: 'BV2', bvid: 'BV2', title: 'beta', upName: 'second', category: 'cat-b', capturedAt: '2026-06-01T00:00:00.000Z', mode: 'fusion', source: 'feed', position: 2 },
      { eventId: 'e3', id: 'BV2', bvid: 'BV2', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z' },
      { eventId: 'e4', id: 'BV2', bvid: 'BV2', eventKind: 'feedback', feedback: 'like', capturedAt: '2026-06-01T00:02:00.000Z' }
    ]
  });

  const firstPage = await storage.listReportSamples({ limit: 1, offset: 0 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.total, 2);
  const searched = await storage.listReportSamples({ q: 'beta', feedback: 'like' });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, 'BV2');

  const analytics = await storage.getReportAnalytics({ days: 90, tzOffsetMinutes: 0 });
  assert.equal(analytics.metrics.sampleCount, 2);
  assert.equal(analytics.metrics.distinctSampleCount, 2);
  assert.equal(analytics.metrics.clickCount, 1);
  assert.equal(analytics.feedback.some((row) => row.key === 'like'), true);
  assert.equal(analytics.trends.some((row) => row.clicks === 1), true);
});

test('analytics metrics only use events inside the requested range', async () => {
  const storage = new MemoryStorage();
  const oldAt = daysAgo(40);
  const recentAt = daysAgo(1);

  await storage.saveReportBatch({
    batchId: 'old-batch',
    clientId: 'c1',
    capturedAt: oldAt,
    events: [
      { eventId: 'old-e1', id: 'BV_OLD', bvid: 'BV_OLD', title: 'old', upName: 'old up', category: 'old-cat', capturedAt: oldAt, mode: 'pure', source: 'feed', position: 1 },
      { eventId: 'old-e2', id: 'BV_OLD', bvid: 'BV_OLD', eventKind: 'click', capturedAt: oldAt },
      { eventId: 'old-e3', id: 'BV_OLD', bvid: 'BV_OLD', eventKind: 'feedback', feedback: 'dislike', capturedAt: oldAt }
    ]
  });
  await storage.saveReportBatch({
    batchId: 'recent-batch',
    clientId: 'c2',
    capturedAt: recentAt,
    events: [
      { eventId: 'recent-e1', id: 'BV_NEW', bvid: 'BV_NEW', title: 'new', upName: 'new up', category: 'new-cat', capturedAt: recentAt, mode: 'fusion', source: 'homepage', position: 2 }
    ]
  });

  const analytics = await storage.getReportAnalytics({ days: 7, tzOffsetMinutes: 0 });
  assert.deepEqual(analytics.range.filters, { clientId: '', mode: '', source: '', category: '', feedback: '' });
  assert.equal(analytics.metrics.eventCount, 1);
  assert.equal(analytics.metrics.sampleCount, 1);
  assert.equal(analytics.metrics.distinctSampleCount, 1);
  assert.equal(analytics.metrics.impressionCount, 1);
  assert.equal(analytics.metrics.clickCount, 0);
  assert.equal(analytics.metrics.feedbackCount, 0);
  assert.equal(analytics.categories.some((row) => row.key === 'old-cat'), false);
  assert.equal(analytics.topUps.some((row) => row.upName === 'old up'), false);

  const filtered = await storage.getReportAnalytics({ days: 7, mode: 'fusion', source: 'homepage' });
  assert.equal(filtered.metrics.impressionCount, 1);
  assert.equal(filtered.sources[0].key, 'homepage');

  const empty = await storage.getReportAnalytics({ days: 7, clientId: 'c1' });
  assert.equal(empty.metrics.eventCount, 0);
});

test('analytics exposes quality ratios dimensions and repeated samples', async () => {
  const storage = new MemoryStorage();
  const capturedAt = daysAgo(1);

  await storage.saveReportBatch({
    batchId: 'quality-batch',
    clientId: 'c1',
    capturedAt,
    events: [
      { eventId: 'q1', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up one', upMid: 'u1', category: 'cat-a', capturedAt, mode: 'pure', source: 'feed', position: 1 },
      { eventId: 'q2', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up one', upMid: 'u1', category: 'cat-a', capturedAt, mode: 'pure', source: 'feed', position: 3 },
      { eventId: 'q3', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up one', upMid: 'u1', category: 'cat-a', eventKind: 'click', capturedAt, mode: 'pure', source: 'feed', position: 3 },
      { eventId: 'q4', id: 'BV1', bvid: 'BV1', title: 'one', upName: 'up one', upMid: 'u1', category: 'cat-a', eventKind: 'feedback', feedback: 'dislike', capturedAt, mode: 'pure', source: 'feed', position: 3 },
      { eventId: 'q5', id: 'BV2', bvid: 'BV2', title: 'two', upName: 'up two', upMid: 'u2', category: 'cat-b', capturedAt, mode: 'fusion', source: 'search', position: 8 },
      { eventId: 'q6', id: 'BV2', bvid: 'BV2', title: 'two', upName: 'up two', upMid: 'u2', category: 'cat-b', eventKind: 'feedback', feedback: 'blocked', capturedAt, mode: 'fusion', source: 'search', position: 8 }
    ]
  });

  const analytics = await storage.getReportAnalytics({ days: 7, tzOffsetMinutes: 0 });
  assert.equal(analytics.metrics.impressionCount, 3);
  assert.equal(analytics.metrics.clickCount, 1);
  assert.equal(analytics.metrics.feedbackCount, 2);
  assert.equal(analytics.metrics.negativeFeedbackCount, 2);
  assert.equal(analytics.metrics.distinctUpCount, 2);
  assert.equal(analytics.metrics.ctr, 1 / 3);
  assert.equal(analytics.metrics.feedbackRate, 2 / 3);
  assert.equal(analytics.metrics.negativeFeedbackRate, 2 / 3);
  assert.equal(analytics.metrics.repeatImpressionCount, 1);
  assert.equal(analytics.metrics.repeatImpressionRate, 1 / 3);

  const pure = byKey(analytics.dimensions.modes, 'pure');
  assert.equal(pure.impressions, 2);
  assert.equal(pure.clicks, 1);
  assert.equal(pure.feedbacks, 1);
  assert.equal(pure.negativeFeedbacks, 1);
  assert.equal(pure.ctr, 1 / 2);
  assert.equal(pure.avgPosition, 2);

  const catB = byKey(analytics.dimensions.categories, 'cat-b');
  assert.equal(catB.impressions, 1);
  assert.equal(catB.negativeFeedbackRate, 1);

  const positionBucket = byKey(analytics.dimensions.positions, '7-10');
  assert.equal(positionBucket.impressions, 1);
  assert.equal(positionBucket.feedbacks, 1);

  assert.equal(analytics.trends[0].ctr, 1 / 3);
  assert.equal(analytics.top.ups[0].ctr, 1 / 2);
  assert.equal(analytics.top.repeatedSamples[0].sampleId, 'BV1');
  assert.equal(analytics.top.repeatedSamples[0].repeatImpressionCount, 1);

  const repeatedSamples = await storage.listReportSamples({ mode: 'pure', source: 'feed', minSeenCount: 2, sort: 'repeatCount' });
  assert.equal(repeatedSamples.total, 1);
  assert.equal(repeatedSamples.items[0].id, 'BV1');

  const negativeFeedback = await storage.listReportSamples({ hasFeedback: 'true', sort: 'negativeFeedback' });
  assert.equal(negativeFeedback.total, 2);
  assert.equal(negativeFeedback.items[0].feedback, 'dislike');

  const byUp = await storage.listReportSamples({ upMid: 'u2', category: 'cat-b' });
  assert.equal(byUp.total, 1);
  assert.equal(byUp.items[0].id, 'BV2');
});
