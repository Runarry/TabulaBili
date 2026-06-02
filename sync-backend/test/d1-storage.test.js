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
        { eventId: 'e2', id: 'BV1', bvid: 'BV1', eventKind: 'click', capturedAt: '2026-06-01T00:01:00.000Z' },
        { eventId: 'e3', id: 'BV1', bvid: 'BV1', eventKind: 'feedback', feedback: 'like', capturedAt: '2026-06-01T00:02:00.000Z' }
      ]
    })
  }));

  assert.equal(response.status, 200);
  const samplesResponse = await app.fetch(new Request('http://local/api/reports/samples?q=alpha&feedback=like', { headers }));
  const samples = await samplesResponse.json();
  assert.equal(samples.total, 1);
  assert.equal(samples.items[0].seenCount, 1);
  assert.equal(samples.items[0].clickCount, 1);

  const analyticsResponse = await app.fetch(new Request('http://local/api/reports/analytics?days=90&tzOffsetMinutes=0', { headers }));
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.metrics.sampleCount, 1);
  assert.equal(analytics.metrics.clickCount, 1);
  assert.equal(analytics.range.days, 90);

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
});
