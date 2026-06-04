import { getSampleId, mergeAggregate } from '../report-aggregate.js';

const CONFIG_KEY = 'config:current';
const INDEX_BATCHES = 'index:batches';
const INDEX_SAMPLES = 'index:samples';
const SUMMARY_KEY = 'summary';

async function getJson(kv, key, fallback = null) {
  const value = await kv.get(key, 'json');
  return value == null ? fallback : value;
}

async function putJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

class KvStorage {
  constructor(kv) {
    this.kv = kv;
  }

  async getConfig() {
    return getJson(this.kv, CONFIG_KEY, null);
  }

  async saveConfig(config) {
    await putJson(this.kv, CONFIG_KEY, config);
  }

  async saveReportBatch(batch) {
    const batchKey = `batch:${batch.batchId}`;
    const existingBatch = await getJson(this.kv, batchKey, null);
    if (existingBatch) {
      return { duplicateBatch: true, eventCount: existingBatch.eventCount, duplicateEventCount: existingBatch.eventCount };
    }

    const receivedAt = new Date().toISOString();
    let duplicateEventCount = 0;
    await putJson(this.kv, batchKey, {
      batchId: batch.batchId,
      clientId: batch.clientId,
      capturedAt: batch.capturedAt,
      receivedAt,
      eventCount: batch.events.length,
      raw: batch
    });

    for (const event of batch.events) {
      const eventKey = `event:${event.eventId}`;
      const existingEvent = await getJson(this.kv, eventKey, null);
      if (existingEvent) {
        duplicateEventCount += 1;
        continue;
      }
      await putJson(this.kv, eventKey, { ...event, receivedAt });
      const sampleId = getSampleId(event);
      if (!sampleId) continue;
      const sampleKey = `sample:${sampleId}`;
      const aggregate = mergeAggregate(await getJson(this.kv, sampleKey, null), event);
      await putJson(this.kv, sampleKey, aggregate);
      await this.addIndexItem(INDEX_SAMPLES, sampleId, 10000);
    }

    await this.addIndexItem(INDEX_BATCHES, batch.batchId, 2000);
    const summary = await getJson(this.kv, SUMMARY_KEY, {
      batchCount: 0,
      eventCount: 0,
      duplicateEventCount: 0,
      sampleCount: 0
    });
    summary.batchCount += 1;
    summary.eventCount += batch.events.length - duplicateEventCount;
    summary.duplicateEventCount += duplicateEventCount;
    summary.sampleCount = (await getJson(this.kv, INDEX_SAMPLES, [])).length;
    await putJson(this.kv, SUMMARY_KEY, summary);

    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async addIndexItem(key, id, maxItems) {
    const items = await getJson(this.kv, key, []);
    const next = [id, ...items.filter((item) => item !== id)].slice(0, maxItems);
    await putJson(this.kv, key, next);
  }

  async getReportSummary() {
    return getJson(this.kv, SUMMARY_KEY, {
      batchCount: 0,
      eventCount: 0,
      duplicateEventCount: 0,
      sampleCount: 0
    });
  }

  async listReportBatches(options = {}) {
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const includeTotal = options.includeTotal !== false;
    const allIds = await getJson(this.kv, INDEX_BATCHES, []);
    const ids = allIds.slice(offset, offset + limit + (includeTotal ? 0 : 1));
    const items = [];
    for (const id of ids.slice(0, limit)) {
      const batch = await getJson(this.kv, `batch:${id}`, null);
      if (batch) {
        const { raw, ...summary } = batch;
        items.push(summary);
      }
    }
    if (!includeTotal) return { items, hasMore: ids.length > limit };
    return { items, total: allIds.length };
  }

  async listReportSamples(options = {}) {
    const limit = Math.min(10000, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const includeTotal = options.includeTotal !== false;
    const q = String(options.q || '').toLowerCase();
    const ids = await getJson(this.kv, INDEX_SAMPLES, []);
    const items = [];
    for (const id of ids) {
      const sample = await getJson(this.kv, `sample:${id}`, null);
      if (!sample) continue;
      if (q && ![sample.id, sample.bvid, sample.title, sample.upName].some((value) => String(value || '').toLowerCase().includes(q))) continue;
      items.push(sample);
      if (!includeTotal && items.length > offset + limit) break;
    }
    const rows = items.slice(offset, offset + limit + (includeTotal ? 0 : 1));
    if (!includeTotal) return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    return { items: rows, total: items.length };
  }
}

export { KvStorage };
