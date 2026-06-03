import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/router.js';
import { D1Storage } from '../src/storage/d1.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  prepare(sql) {
    const db = this.db;
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async run() {
        const result = db.prepare(sql).run(...this.args);
        return { meta: { changes: Number(result.changes || 0) } };
      },
      async all() {
        return { results: db.prepare(sql).all(...this.args) };
      },
      async first() {
        return db.prepare(sql).get(...this.args) || null;
      }
    };
  }
}

test('D1 storage initializes schema and supports report APIs', { skip: DatabaseSync ? false : 'node:sqlite unavailable' }, async () => {
  const fake = new FakeD1();
  const storage = new D1Storage(fake);
  const app = createApp({ secret: 'secret', storage });
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  const response = await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId: 'b1',
      clientId: 'c1',
      capturedAt: '2026-06-01T00:00:00.000Z',
      events: [
        { eventId: 'e1', id: 'BV1', bvid: 'BV1', title: 'alpha', upName: 'up', upMid: '42', category: 'cat-a', capturedAt: '2026-06-01T00:00:00.000Z', mode: 'pure', source: 'feed', position: 1 },
        { eventId: 'e2', id: 'BV1', bvid: 'BV1', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z', mode: 'pure', source: 'feed', category: 'cat-a' },
        { eventId: 'e3', id: 'BV1', bvid: 'BV1', eventKind: 'feedback', feedback: 'like', capturedAt: '2026-06-01T00:02:00.000Z', mode: 'pure', source: 'feed', category: 'cat-a' }
      ]
    })
  }));

  assert.equal(response.status, 200);
  const samplesResponse = await app.fetch(new Request('http://local/api/reports/samples?q=alpha&feedback=like', { headers }));
  const samples = await samplesResponse.json();
  assert.equal(samples.total, 1);
  assert.equal(samples.items[0].seenCount, 1);
  assert.equal(samples.items[0].clickCount, 1);

  const filteredSamplesResponse = await app.fetch(new Request('http://local/api/reports/samples?mode=pure&source=feed&upMid=42&minSeenCount=1&sort=ctr', { headers }));
  const filteredSamples = await filteredSamplesResponse.json();
  assert.equal(filteredSamples.total, 1);
  assert.equal(filteredSamples.items[0].id, 'BV1');

  const analyticsResponse = await app.fetch(new Request('http://local/api/reports/analytics?days=90&tzOffsetMinutes=0', { headers }));
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.metrics.sampleCount, 1);
  assert.equal(analytics.metrics.clickCount, 1);
  assert.equal(analytics.range.days, 90);

  const clickEventsResponse = await app.fetch(new Request('http://local/api/reports/events?sampleId=BV1&eventKind=click&days=90', { headers }));
  const clickEvents = await clickEventsResponse.json();
  assert.equal(clickEvents.total, 1);
  assert.equal(clickEvents.items[0].eventKind, 'click');

  const timelineResponse = await app.fetch(new Request('http://local/api/reports/samples/BV1/events?days=90', { headers }));
  const timeline = await timelineResponse.json();
  assert.equal(timeline.total, 3);

  const migrations = fake.db.prepare('select version, name from schema_migrations order by version').all();
  assert.deepEqual(migrations.map((row) => ({ ...row })), [
    { version: 1, name: 'base_tables' },
    { version: 2, name: 'structured_event_columns' },
    { version: 3, name: 'sample_timestamps' },
    { version: 4, name: 'daily_metrics' },
    { version: 5, name: 'analytics_indexes' }
  ]);

  const dailyMetrics = fake.db.prepare(`
    select date, client_id, mode, source, category, impressions, clicks, feedbacks, negative_feedbacks
    from daily_metrics
    where date = ?
  `).get('2026-06-01');
  assert.deepEqual({ ...dailyMetrics }, {
    date: '2026-06-01',
    client_id: 'c1',
    mode: 'pure',
    source: 'feed',
    category: 'cat-a',
    impressions: 1,
    clicks: 1,
    feedbacks: 1,
    negative_feedbacks: 0
  });

  const impression = fake.db.prepare('select event_kind, mode, source, category, position, bvid, up_name, up_mid from events where event_id = ?').get('e1');
  assert.deepEqual({ ...impression }, {
    event_kind: 'impression',
    mode: 'pure',
    source: 'feed',
    category: 'cat-a',
    position: 1,
    bvid: 'BV1',
    up_name: 'up',
    up_mid: '42'
  });

  const feedback = fake.db.prepare('select event_kind, feedback, category, up_name, up_mid from events where event_id = ?').get('e3');
  assert.deepEqual({ ...feedback }, {
    event_kind: 'feedback',
    feedback: 'like',
    category: 'cat-a',
    up_name: 'up',
    up_mid: '42'
  });

  const sample = fake.db.prepare('select first_seen_at, last_clicked_at, feedback_updated_at from samples where sample_id = ?').get('BV1');
  assert.equal(sample.first_seen_at, '2026-06-01T00:00:00.000Z');
  assert.equal(sample.last_clicked_at, '2026-06-01T00:01:00.000Z');
  assert.equal(sample.feedback_updated_at, '2026-06-01T00:02:00.000Z');

  const repeatedResponse = await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId: 'b2',
      clientId: 'c1',
      capturedAt: '2026-06-01T00:03:00.000Z',
      events: [
        { eventId: 'e4', id: 'BV1', bvid: 'BV1', title: 'alpha', upName: 'up', upMid: '42', category: 'cat-a', capturedAt: '2026-06-01T00:03:00.000Z', mode: 'pure', source: 'feed', position: 3 },
        { eventId: 'e5', id: 'BV1', bvid: 'BV1', eventKind: 'feedback', feedback: 'dislike', capturedAt: '2026-06-01T00:04:00.000Z', mode: 'pure', source: 'feed', category: 'cat-a' }
      ]
    })
  }));
  assert.equal(repeatedResponse.status, 200);

  const repeatedAnalyticsResponse = await app.fetch(new Request('http://local/api/reports/analytics?days=90&mode=pure&source=feed&tzOffsetMinutes=0', { headers }));
  const repeatedAnalytics = await repeatedAnalyticsResponse.json();
  assert.equal(repeatedAnalytics.metrics.impressionCount, 2);
  assert.equal(repeatedAnalytics.metrics.repeatImpressionCount, 1);
  assert.equal(repeatedAnalytics.top.repeatedSamples[0].sampleId, 'BV1');
  assert.equal(repeatedAnalytics.feedback.some((row) => row.key === 'dislike' && row.count === 1), true);

  const duplicateEventResponse = await app.fetch(new Request('http://local/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId: 'b3',
      clientId: 'c1',
      capturedAt: '2026-06-01T00:05:00.000Z',
      events: [
        { eventId: 'e4', id: 'BV1', bvid: 'BV1', title: 'alpha', capturedAt: '2026-06-01T00:05:00.000Z', mode: 'pure', source: 'feed', position: 4 },
        { eventId: 'e6', id: 'BV1', bvid: 'BV1', eventKind: 'click', capturedAt: '2026-06-01T00:06:00.000Z', mode: 'pure', source: 'feed', category: 'cat-a' }
      ]
    })
  }));
  const duplicateEvent = await duplicateEventResponse.json();
  assert.equal(duplicateEvent.duplicateEventCount, 1);

  const feedbackFilteredResponse = await app.fetch(new Request('http://local/api/reports/analytics?days=90&feedback=dislike&tzOffsetMinutes=0', { headers }));
  const feedbackFiltered = await feedbackFilteredResponse.json();
  assert.equal(feedbackFiltered.metrics.eventCount, 1);
  assert.equal(feedbackFiltered.metrics.feedbackCount, 1);
  assert.equal(feedbackFiltered.metrics.impressionCount, 0);
});
