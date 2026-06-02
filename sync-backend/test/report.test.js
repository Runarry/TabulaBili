import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/memory.js';

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
