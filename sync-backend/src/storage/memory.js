import { getSampleId, mergeAggregate, toEventRow } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  eventMatchesAnalyticsOptions,
  eventMatchesReportEventOptions,
  filterSamples,
  normalizeAnalyticsOptions,
  normalizeEventListOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent,
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
      const sampleId = getSampleId(event);
      const existingAggregate = sampleId ? this.samples.get(sampleId) : null;
      const eventRow = toEventRow(event, batch, receivedAt, existingAggregate);
      this.events.set(event.eventId, eventRow);
      if (!sampleId) continue;
      this.samples.set(sampleId, mergeAggregate(existingAggregate, event));
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
    const filtered = sortSamples(filterSamples([...this.samples.values()], query, [...this.events.values()]), query.sort);
    return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }

  async listReportEvents(options = {}) {
    const query = normalizeEventListOptions(options);
    const filtered = [...this.events.values()]
      .map(normalizeStoredEvent)
      .filter((event) => eventMatchesReportEventOptions(event, query))
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }

  async getReportAnalytics(options = {}) {
    const query = normalizeAnalyticsOptions(options);
    const events = [...this.events.values()].filter((event) => eventMatchesAnalyticsOptions(event, query));
    return buildReportAnalytics({
      events,
      range: query
    });
  }
}

export { MemoryStorage };
