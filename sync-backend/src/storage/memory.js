import { getSampleId, mergeAggregate } from '../report-aggregate.js';

class MemoryStorage {
  constructor() {
    this.config = null;
    this.batches = new Map();
    this.events = new Map();
    this.samples = new Map();
  }

  async getConfig() {
    return this.config;
  }

  async saveConfig(config) {
    this.config = config;
  }

  async saveReportBatch(batch) {
    if (this.batches.has(batch.batchId)) {
      return { duplicateBatch: true, eventCount: batch.events.length, duplicateEventCount: batch.events.length };
    }

    let duplicateEventCount = 0;
    const receivedAt = new Date().toISOString();
    this.batches.set(batch.batchId, {
      batchId: batch.batchId,
      clientId: batch.clientId,
      capturedAt: batch.capturedAt,
      receivedAt,
      eventCount: batch.events.length,
      raw: batch
    });

    for (const event of batch.events) {
      if (this.events.has(event.eventId)) {
        duplicateEventCount += 1;
        continue;
      }
      this.events.set(event.eventId, { ...event, receivedAt });
      const sampleId = getSampleId(event);
      if (!sampleId) continue;
      this.samples.set(sampleId, mergeAggregate(this.samples.get(sampleId), event));
    }

    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
    return {
      batchCount: this.batches.size,
      eventCount: this.events.size,
      duplicateEventCount: [...this.batches.values()].reduce((sum) => sum + 0, 0),
      sampleCount: this.samples.size
    };
  }

  async listReportBatches(options = {}) {
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const items = [...this.batches.values()]
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(offset, offset + limit)
      .map(({ raw, ...item }) => item);
    return { items, total: this.batches.size };
  }

  async listReportSamples(options = {}) {
    const limit = Math.min(10000, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const q = String(options.q || '').toLowerCase();
    const filtered = [...this.samples.values()]
      .filter((item) => !q || [item.id, item.bvid, item.title, item.upName].some((value) => String(value || '').toLowerCase().includes(q)))
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }
}

export { MemoryStorage };
