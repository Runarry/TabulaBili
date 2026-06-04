import { getSampleId, mergeAggregate, toEventRow } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  eventMatchesAnalyticsOptions,
  eventMatchesReportEventOptions,
  filterSamples,
  getDailyMetricDelta,
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
    this.dailyMetrics = new Map();
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
      this.incrementDailyMetrics(eventRow);
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
    const includeTotal = options.includeTotal !== false;
    const rows = [...this.batches.values()]
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(offset, offset + limit + (includeTotal ? 0 : 1))
      .map(({ raw, ...item }) => item);
    const items = rows.slice(0, limit);
    if (!includeTotal) return { items, hasMore: rows.length > limit };
    return { items, total: this.batches.size };
  }

  async listReportSamples(options = {}) {
    const query = normalizeSampleListOptions(options);
    const includeTotal = options.includeTotal !== false;
    const filtered = sortSamples(filterSamples([...this.samples.values()], query, [...this.events.values()]), query.sort);
    const rows = filtered.slice(query.offset, query.offset + query.limit + (includeTotal ? 0 : 1));
    const items = rows.slice(0, query.limit);
    if (!includeTotal) return { items, hasMore: rows.length > query.limit };
    return { items, total: filtered.length };
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

  async cleanupReports(options = {}) {
    const before = String(options.before || '');
    const dryRun = options.dryRun !== false;
    const plan = this.getCleanupPlan(before);
    const matched = {
      events: plan.eventIds.length,
      batches: plan.batchIds.length,
      orphanSamples: plan.orphanSampleIds.length
    };
    if (dryRun) return { before, dryRun, matched, deleted: { events: 0, batches: 0, orphanSamples: 0 } };

    for (const id of plan.eventIds) this.events.delete(id);
    for (const id of plan.batchIds) this.batches.delete(id);
    for (const id of plan.orphanSampleIds) this.samples.delete(id);
    return { before, dryRun, matched, deleted: { ...matched } };
  }

  getCleanupPlan(before) {
    const eventIds = [];
    const batchIds = [];
    const remainingSampleIds = new Set();

    for (const [id, event] of this.events.entries()) {
      if (String(event.capturedAt || '') < before) eventIds.push(id);
      else if (event.sampleId) remainingSampleIds.add(event.sampleId);
    }
    for (const [id, batch] of this.batches.entries()) {
      if (String(batch.receivedAt || '') < before) batchIds.push(id);
    }

    const orphanSampleIds = [...this.samples.keys()].filter((id) => !remainingSampleIds.has(id));
    return { eventIds, batchIds, orphanSampleIds };
  }

  incrementDailyMetrics(eventRow) {
    const delta = getDailyMetricDelta(eventRow);
    if (!delta) return;
    const key = JSON.stringify([delta.date, delta.clientId, delta.mode, delta.source, delta.category]);
    const current = this.dailyMetrics.get(key) || {
      date: delta.date,
      clientId: delta.clientId,
      mode: delta.mode,
      source: delta.source,
      category: delta.category,
      impressions: 0,
      clicks: 0,
      feedbacks: 0,
      negativeFeedbacks: 0
    };
    current.impressions += delta.impressions;
    current.clicks += delta.clicks;
    current.feedbacks += delta.feedbacks;
    current.negativeFeedbacks += delta.negativeFeedbacks;
    this.dailyMetrics.set(key, current);
  }
}

export { MemoryStorage };
