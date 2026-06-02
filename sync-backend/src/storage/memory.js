import { getSampleId, mergeAggregate } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  filterSamples,
  normalizeAnalyticsOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  sortSamples
} from './helpers.js';

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
      duplicateEventCount: 0,
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
    const storedBatch = this.batches.get(batch.batchId);
    if (storedBatch) storedBatch.duplicateEventCount = duplicateEventCount;

    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
    return {
      batchCount: this.batches.size,
      eventCount: this.events.size,
      duplicateEventCount: [...this.batches.values()].reduce((sum, batch) => sum + Number(batch.duplicateEventCount || 0), 0),
      sampleCount: this.samples.size
    };
  }

  async listReportBatches(options = {}) {
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);
    const items = [...this.batches.values()]
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(offset, offset + limit)
      .map(({ raw, ...item }) => item);
    return { items, total: this.batches.size };
  }

  async listReportSamples(options = {}) {
    const query = normalizeSampleListOptions(options);
    const filtered = sortSamples(filterSamples([...this.samples.values()], query), query.sort);
    return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }

  async getReportAnalytics(options = {}) {
    const { sinceMs, tzOffsetMinutes } = normalizeAnalyticsOptions(options);
    const samples = [...this.samples.values()];
    const events = [...this.events.values()];
    return buildReportAnalytics({
      samples,
      events: events.filter((event) => Date.parse(event.capturedAt || event.receivedAt || '') >= sinceMs),
      metrics: {
        batchCount: this.batches.size,
        eventCount: this.events.size
      },
      tzOffsetMinutes
    });
  }
}

export { MemoryStorage };
