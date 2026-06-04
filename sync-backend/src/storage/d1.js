import { getSampleId, mergeAggregate, toEventRow, toSampleRow } from '../report-aggregate.js';
import {
  addDailyMetricEvent,
  getReportEventWhere,
  getSampleOrderBy,
  getSampleWhere,
  normalizeEventListOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent
} from './helpers.js';
import { buildAnalyticsQuerySpecs, executeAnalyticsQueries } from './sql-analytics.js';

const MAX_D1_BATCH_STATEMENTS = 100;
const LATEST_SCHEMA_VERSION = 6;

async function allRows(statement) {
  const result = await statement.all();
  return result.results || [];
}

async function firstRow(statement) {
  return statement.first();
}

function changesOf(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function summarizeBulkResults(results) {
  let duplicateBatchCount = 0;
  let duplicateEventCount = 0;

  for (const result of results) {
    if (!result) continue;
    if (result.duplicateBatch) duplicateBatchCount += 1;
    duplicateEventCount += Number(result.duplicateEventCount || 0);
  }

  return { duplicateBatchCount, duplicateEventCount, results };
}

function isMissingTableError(error, tableNames = []) {
  const message = String(error && error.message || error || '').toLowerCase();
  if (!message.includes('no such table')) return false;
  return !tableNames.length || tableNames.some((tableName) => message.includes(String(tableName).toLowerCase()));
}

class D1Storage {
  constructor(db) {
    if (!db) throw new Error('TABULABILI_SYNC_DB D1 binding is required');
    this.db = db;
    this.schemaReady = null;
  }

  getReadDb() {
    return this.db;
  }

  async hasCurrentSchema() {
    try {
      const row = await firstRow(this.db.prepare('select max(version) as version from schema_migrations'));
      return Number(row && row.version || 0) >= LATEST_SCHEMA_VERSION;
    } catch {
      return false;
    }
  }

  async ensureSchema() {
    if (await this.hasCurrentSchema()) return;

    const baseStatements = [
      `create table if not exists config_store (
        id integer primary key check (id = 1),
        json text not null
      )`,
      `create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      )`,
      `create table if not exists batches (
        batch_id text primary key,
        client_id text not null,
        captured_at text not null,
        received_at text not null,
        event_count integer not null,
        duplicate_event_count integer not null default 0,
        raw_json text not null
      )`,
      `create table if not exists events (
        event_id text primary key,
        batch_id text not null,
        client_id text not null,
        sample_id text,
        captured_at text not null,
        received_at text not null,
        event_kind text not null default 'impression',
        mode text not null default '',
        source text not null default '',
        category text not null default '',
        feedback text not null default '',
        position integer not null default 0,
        bvid text not null default '',
        up_name text not null default '',
        up_mid text not null default '',
        raw_json text not null
      )`,
      `create table if not exists samples (
        sample_id text primary key,
        bvid text not null default '',
        title text not null default '',
        up_name text not null default '',
        up_mid text not null default '',
        category text not null default '',
        first_seen_at text not null default '',
        last_seen_at text not null,
        seen_count integer not null,
        click_count integer not null default 0,
        feedback text not null default 'unset',
        last_clicked_at text not null default '',
        feedback_updated_at text not null default '',
        json text not null
      )`,
      `create table if not exists daily_metrics (
        date text not null,
        client_id text not null default '',
        mode text not null default '',
        source text not null default '',
        category text not null default '',
        impressions integer not null default 0,
        clicks integer not null default 0,
        feedbacks integer not null default 0,
        negative_feedbacks integer not null default 0,
        primary key (date, client_id, mode, source, category)
      )`,
    ];
    const indexStatements = [
      'create index if not exists idx_d1_batches_received_at on batches(received_at desc)',
      'create index if not exists idx_d1_events_captured_at on events(captured_at)',
      'create index if not exists idx_d1_events_kind_captured_at on events(event_kind, captured_at)',
      'create index if not exists idx_d1_events_mode_captured_at on events(mode, captured_at)',
      'create index if not exists idx_d1_events_source_captured_at on events(source, captured_at)',
      'create index if not exists idx_d1_events_category_captured_at on events(category, captured_at)',
      'create index if not exists idx_d1_events_client_captured_at on events(client_id, captured_at)',
      'create index if not exists idx_d1_events_feedback_captured_at on events(feedback, captured_at)',
      'create index if not exists idx_d1_events_sample_captured_at on events(sample_id, captured_at)',
      'create index if not exists idx_d1_events_sample_kind_captured_at on events(sample_id, event_kind, captured_at)',
      'create index if not exists idx_d1_events_up_mid_captured_at on events(up_mid, captured_at)',
      'create index if not exists idx_d1_samples_last_seen_at on samples(last_seen_at desc)',
      'create index if not exists idx_d1_samples_first_seen_at on samples(first_seen_at)',
      'create index if not exists idx_d1_samples_up_mid on samples(up_mid)',
      'create index if not exists idx_d1_samples_category on samples(category)',
      'create index if not exists idx_d1_samples_seen_count on samples(seen_count desc)',
      'create index if not exists idx_d1_samples_click_count on samples(click_count desc)',
      'create index if not exists idx_d1_samples_feedback on samples(feedback)',
      'create index if not exists idx_d1_daily_metrics_date on daily_metrics(date desc)'
    ];
    for (const sql of baseStatements) {
      await this.db.prepare(sql).run();
    }
    await this.ensureColumns([
      ['batches', 'duplicate_event_count', 'integer not null default 0'],
      ['events', 'event_kind', "text not null default 'impression'"],
      ['events', 'mode', "text not null default ''"],
      ['events', 'source', "text not null default ''"],
      ['events', 'category', "text not null default ''"],
      ['events', 'feedback', "text not null default ''"],
      ['events', 'position', 'integer not null default 0'],
      ['events', 'bvid', "text not null default ''"],
      ['events', 'up_name', "text not null default ''"],
      ['events', 'up_mid', "text not null default ''"],
      ['samples', 'bvid', "text not null default ''"],
      ['samples', 'title', "text not null default ''"],
      ['samples', 'up_name', "text not null default ''"],
      ['samples', 'up_mid', "text not null default ''"],
      ['samples', 'category', "text not null default ''"],
      ['samples', 'first_seen_at', "text not null default ''"],
      ['samples', 'click_count', 'integer not null default 0'],
      ['samples', 'feedback', "text not null default 'unset'"],
      ['samples', 'last_clicked_at', "text not null default ''"],
      ['samples', 'feedback_updated_at', "text not null default ''"]
    ]);
    for (const sql of indexStatements) {
      await this.db.prepare(sql).run();
    }
    await this.db.prepare('drop index if exists idx_d1_events_up_name_captured_at').run();
    await this.recordMigrations([
      [1, 'base_tables'],
      [2, 'structured_event_columns'],
      [3, 'sample_timestamps'],
      [4, 'daily_metrics'],
      [5, 'analytics_indexes'],
      [6, 'drop_events_up_name_index']
    ]);
  }

  ensureReady() {
    if (!this.schemaReady) {
      this.schemaReady = this.ensureSchema().catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  async ensureColumns(columns) {
    for (const [table, column, definition] of columns) {
      await this.ensureColumn(table, column, definition);
    }
  }

  async ensureColumn(table, column, definition) {
    const columns = await allRows(this.db.prepare(`pragma table_info(${table})`));
    if (!columns.some((item) => item.name === column)) {
      await this.db.prepare(`alter table ${table} add column ${column} ${definition}`).run();
    }
  }

  async recordMigrations(migrations) {
    const appliedAt = new Date().toISOString();
    for (const [version, name] of migrations) {
      await this.db.prepare(`
        insert or ignore into schema_migrations (version, name, applied_at)
        values (?, ?, ?)
      `).bind(version, name, appliedAt).run();
    }
  }

  async getConfig() {
    try {
      const row = await firstRow(this.db.prepare('select json from config_store where id = 1'));
      return row ? JSON.parse(row.json) : null;
    } catch (error) {
      if (!isMissingTableError(error, ['config_store'])) throw error;
      return null;
    }
  }

  async saveConfig(config) {
    await this.ensureReady();
    await this.db.prepare(`
      insert into config_store (id, json) values (1, ?)
      on conflict(id) do update set json = excluded.json
    `).bind(JSON.stringify(config)).run();
  }

  async runStatements(statements) {
    const results = [];
    for (let index = 0; index < statements.length; index += MAX_D1_BATCH_STATEMENTS) {
      const group = statements.slice(index, index + MAX_D1_BATCH_STATEMENTS);
      if (!group.length) continue;
      if (typeof this.db.batch === 'function') {
        results.push(...await this.db.batch(group));
      } else {
        for (const statement of group) {
          results.push(await statement.run());
        }
      }
    }
    return results;
  }

  async getSampleAggregates(sampleIds) {
    const ids = [...new Set(sampleIds.filter(Boolean))];
    const aggregates = new Map();
    for (let index = 0; index < ids.length; index += 50) {
      const chunk = ids.slice(index, index + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await allRows(this.db.prepare(`
        select sample_id as sampleId, json
        from samples
        where sample_id in (${placeholders})
      `).bind(...chunk));
      for (const row of rows) {
        aggregates.set(row.sampleId, JSON.parse(row.json));
      }
    }
    return aggregates;
  }

  async getExistingBatches(batchIds) {
    const ids = [...new Set(batchIds.filter(Boolean))];
    const batches = new Map();
    for (let index = 0; index < ids.length; index += 50) {
      const chunk = ids.slice(index, index + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await allRows(this.db.prepare(`
        select batch_id as batchId, event_count as eventCount, duplicate_event_count as duplicateEventCount
        from batches
        where batch_id in (${placeholders})
      `).bind(...chunk));
      for (const row of rows) {
        batches.set(row.batchId, row);
      }
    }
    return batches;
  }

  createInsertBatchStatement(batch, receivedAt) {
    return this.db.prepare(`
      insert or ignore into batches (batch_id, client_id, captured_at, received_at, event_count, duplicate_event_count, raw_json)
      values (?, ?, ?, ?, ?, 0, ?)
    `).bind(batch.batchId, batch.clientId, batch.capturedAt, receivedAt, batch.events.length, JSON.stringify(batch));
  }

  createUpdateBatchDuplicateStatement(batchId, duplicateEventCount) {
    return this.db.prepare('update batches set duplicate_event_count = ? where batch_id = ?')
      .bind(duplicateEventCount, batchId);
  }

  buildEventEntries(batch, receivedAt, existingAggregates) {
    const previewAggregates = new Map(existingAggregates);
    return batch.events.map((event) => {
      const sampleId = getSampleId(event);
      const existingAggregate = sampleId ? (previewAggregates.get(sampleId) || null) : null;
      const eventRow = toEventRow(event, batch, receivedAt, existingAggregate);
      if (sampleId) {
        previewAggregates.set(sampleId, mergeAggregate(existingAggregate, event));
      }
      return { event, eventRow, sampleId };
    });
  }

  createInsertEventStatement(eventRow) {
    return this.db.prepare(`
      insert or ignore into events (
        event_id, batch_id, client_id, sample_id, captured_at, received_at,
        event_kind, mode, source, category, feedback, position, bvid, up_name, up_mid, raw_json
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventRow.eventId,
      eventRow.batchId,
      eventRow.clientId,
      eventRow.sampleId,
      eventRow.capturedAt,
      eventRow.receivedAt,
      eventRow.eventKind,
      eventRow.mode,
      eventRow.source,
      eventRow.category,
      eventRow.feedback,
      eventRow.position,
      eventRow.bvid,
      eventRow.upName,
      eventRow.upMid,
      eventRow.rawJson
    );
  }

  createUpsertSampleStatement(sampleId, aggregate, receivedAt) {
    const row = toSampleRow(sampleId, aggregate, receivedAt);
    return this.db.prepare(`
      insert into samples (
        sample_id, bvid, title, up_name, up_mid, category, first_seen_at, last_seen_at,
        seen_count, click_count, feedback, last_clicked_at, feedback_updated_at, json
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(sample_id) do update set
        bvid = excluded.bvid,
        title = excluded.title,
        up_name = excluded.up_name,
        up_mid = excluded.up_mid,
        category = excluded.category,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        seen_count = excluded.seen_count,
        click_count = excluded.click_count,
        feedback = excluded.feedback,
        last_clicked_at = excluded.last_clicked_at,
        feedback_updated_at = excluded.feedback_updated_at,
        json = excluded.json
    `).bind(
      row.sampleId,
      row.bvid,
      row.title,
      row.upName,
      row.upMid,
      row.category,
      row.firstSeenAt,
      row.lastSeenAt,
      row.seenCount,
      row.clickCount,
      row.feedback,
      row.lastClickedAt,
      row.feedbackUpdatedAt,
      row.json
    );
  }

  createUpsertDailyMetricStatement(delta) {
    return this.db.prepare(`
      insert into daily_metrics (
        date, client_id, mode, source, category,
        impressions, clicks, feedbacks, negative_feedbacks
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(date, client_id, mode, source, category) do update set
        impressions = impressions + excluded.impressions,
        clicks = clicks + excluded.clicks,
        feedbacks = feedbacks + excluded.feedbacks,
        negative_feedbacks = negative_feedbacks + excluded.negative_feedbacks
    `).bind(
      delta.date,
      delta.clientId,
      delta.mode,
      delta.source,
      delta.category,
      delta.impressions,
      delta.clicks,
      delta.feedbacks,
      delta.negativeFeedbacks
    );
  }

  async saveBulkReportBatches(batches) {
    await this.ensureReady();
    const payloads = Array.isArray(batches) ? batches : [];
    const existingBatches = await this.getExistingBatches(payloads.map((batch) => batch.batchId));
    const results = new Array(payloads.length);
    const newBatchInfos = [];

    for (let index = 0; index < payloads.length; index += 1) {
      const batch = payloads[index];
      const existing = existingBatches.get(batch.batchId);
      if (existing) {
        results[index] = {
          batchId: batch.batchId,
          duplicateBatch: true,
          eventCount: Number(existing.eventCount || batch.events.length),
          duplicateEventCount: Number(existing.eventCount || batch.events.length)
        };
        continue;
      }

      newBatchInfos.push({
        index,
        batch,
        receivedAt: new Date().toISOString(),
        duplicateEventCount: 0
      });
    }

    if (!newBatchInfos.length) return summarizeBulkResults(results);

    const insertBatchResults = await this.runStatements(newBatchInfos.map((info) =>
      this.createInsertBatchStatement(info.batch, info.receivedAt)));
    const activeBatchInfos = [];

    for (let index = 0; index < newBatchInfos.length; index += 1) {
      const info = newBatchInfos[index];
      if (changesOf(insertBatchResults[index]) === 0) {
        results[info.index] = {
          batchId: info.batch.batchId,
          duplicateBatch: true,
          eventCount: info.batch.events.length,
          duplicateEventCount: info.batch.events.length
        };
        continue;
      }
      activeBatchInfos.push(info);
    }

    if (!activeBatchInfos.length) return summarizeBulkResults(results);

    const existingAggregates = await this.getSampleAggregates(
      activeBatchInfos.flatMap((info) => info.batch.events.map(getSampleId))
    );
    const previewAggregates = new Map(existingAggregates);
    const eventEntries = [];

    for (const info of activeBatchInfos) {
      for (const event of info.batch.events) {
        const sampleId = getSampleId(event);
        const existingAggregate = sampleId ? (previewAggregates.get(sampleId) || null) : null;
        const eventRow = toEventRow(event, info.batch, info.receivedAt, existingAggregate);
        if (sampleId) previewAggregates.set(sampleId, mergeAggregate(existingAggregate, event));
        eventEntries.push({ info, event, eventRow, sampleId });
      }
    }

    const insertResults = await this.runStatements(
      eventEntries.map(({ eventRow }) => this.createInsertEventStatement(eventRow))
    );
    const currentAggregates = new Map(existingAggregates);
    const changedSampleIds = new Set();
    const changedSampleReceivedAt = new Map();
    const dailyMetrics = new Map();

    for (let index = 0; index < eventEntries.length; index += 1) {
      const { info, event, eventRow, sampleId } = eventEntries[index];
      if (changesOf(insertResults[index]) === 0) {
        info.duplicateEventCount += 1;
        continue;
      }
      addDailyMetricEvent(dailyMetrics, eventRow);

      if (!sampleId) continue;
      const aggregate = mergeAggregate(currentAggregates.get(sampleId) || null, event);
      currentAggregates.set(sampleId, aggregate);
      changedSampleIds.add(sampleId);
      changedSampleReceivedAt.set(sampleId, info.receivedAt);
    }

    const sampleStatements = [...changedSampleIds].map((sampleId) =>
      this.createUpsertSampleStatement(sampleId, currentAggregates.get(sampleId), changedSampleReceivedAt.get(sampleId)));
    const metricStatements = [...dailyMetrics.values()].map((delta) =>
      this.createUpsertDailyMetricStatement(delta));
    const batchUpdateStatements = activeBatchInfos
      .filter((info) => info.duplicateEventCount > 0)
      .map((info) =>
      this.createUpdateBatchDuplicateStatement(info.batch.batchId, info.duplicateEventCount));
    await this.runStatements([...sampleStatements, ...metricStatements, ...batchUpdateStatements]);

    for (const info of activeBatchInfos) {
      results[info.index] = {
        batchId: info.batch.batchId,
        duplicateBatch: false,
        eventCount: info.batch.events.length,
        duplicateEventCount: info.duplicateEventCount
      };
    }

    return summarizeBulkResults(results);
  }

  async saveReportBatch(batch) {
    const result = await this.saveBulkReportBatches([batch]);
    return result.results[0];
  }

  async getReportSummary() {
    const db = this.getReadDb();
    try {
      const row = await firstRow(db.prepare(`
        select
          (select count(*) from batches) as batchCount,
          (select count(*) from events) as eventCount,
          (select coalesce(sum(duplicate_event_count), 0) from batches) as duplicateEventCount,
          (select count(*) from samples) as sampleCount
      `));
      return row;
    } catch (error) {
      if (!isMissingTableError(error, ['batches', 'events', 'samples'])) throw error;
      return { batchCount: 0, eventCount: 0, duplicateEventCount: 0, sampleCount: 0 };
    }
  }

  async listReportBatches(options = {}) {
    const db = this.getReadDb();
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const fetchLimit = limit + (includeTotal ? 0 : 1);
    try {
      const rows = await allRows(db.prepare(`
        select batch_id as batchId, client_id as clientId, captured_at as capturedAt, received_at as receivedAt,
          event_count as eventCount, duplicate_event_count as duplicateEventCount
        from batches order by received_at desc limit ? offset ?
      `).bind(fetchLimit, offset));
      const items = rows.slice(0, limit);
      if (!includeTotal) return { items, hasMore: rows.length > limit };
      const total = await firstRow(db.prepare('select count(*) as count from batches'));
      return { items, total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['batches'])) throw error;
      return includeTotal ? { items: [], total: 0 } : { items: [], hasMore: false };
    }
  }

  async listReportSamples(options = {}) {
    const db = this.getReadDb();
    const query = normalizeSampleListOptions(options);
    const includeTotal = options.includeTotal !== false;
    const fetchLimit = query.limit + (includeTotal ? 0 : 1);
    const { whereSql, args } = getSampleWhere(query);
    const orderBy = getSampleOrderBy(query.sort);
    try {
      const rows = await allRows(db.prepare(`select json from samples ${whereSql} order by ${orderBy} limit ? offset ?`).bind(...args, fetchLimit, query.offset));
      const items = rows.slice(0, query.limit).map((row) => JSON.parse(row.json));
      if (!includeTotal) return { items, hasMore: rows.length > query.limit };
      const total = await firstRow(db.prepare(`select count(*) as count from samples ${whereSql}`).bind(...args));
      return { items, total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['samples', 'events'])) throw error;
      return includeTotal ? { items: [], total: 0 } : { items: [], hasMore: false };
    }
  }

  async listReportEvents(options = {}) {
    const db = this.getReadDb();
    const query = normalizeEventListOptions(options);
    const { whereSql, args } = getReportEventWhere(query);
    try {
      const total = await firstRow(db.prepare(`select count(*) as count from events ${whereSql}`).bind(...args));
      const rows = await allRows(db.prepare(`
        select event_id as eventId, batch_id as batchId, client_id as clientId, sample_id as sampleId,
          captured_at as capturedAt, received_at as receivedAt, event_kind as eventKind, mode, source,
          category, feedback, position, bvid, up_name as upName, up_mid as upMid, raw_json as json
        from events ${whereSql}
        order by captured_at desc
        limit ? offset ?
      `).bind(...args, query.limit, query.offset));
      return { items: rows.map(normalizeStoredEvent), total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['events'])) throw error;
      return { items: [], total: 0 };
    }
  }

  async getReportAnalytics(options = {}) {
    const db = this.getReadDb();
    const specs = buildAnalyticsQuerySpecs(options);
    const emptyRunner = {
      first: () => null,
      all: () => []
    };
    try {
      return await executeAnalyticsQueries(specs, {
        first: ({ sql, args }) => firstRow(db.prepare(sql).bind(...args)),
        all: ({ sql, args }) => allRows(db.prepare(sql).bind(...args)),
        canIgnoreOptionalError: (error) => isMissingTableError(error, ['daily_metrics'])
      });
    } catch (error) {
      if (!isMissingTableError(error, ['events'])) throw error;
      return executeAnalyticsQueries(specs, emptyRunner);
    }
  }

  async cleanupReports(options = {}) {
    await this.ensureReady();
    const before = String(options.before || '');
    const dryRun = options.dryRun !== false;
    const matched = await this.getCleanupCounts(before);
    if (dryRun) return { before, dryRun, matched, deleted: { events: 0, batches: 0, orphanSamples: 0 } };

    const events = changesOf(await this.db.prepare('delete from events where captured_at < ?').bind(before).run());
    const batches = changesOf(await this.db.prepare('delete from batches where received_at < ?').bind(before).run());
    const orphanSamples = changesOf(await this.db.prepare(`
      delete from samples
      where not exists (select 1 from events where events.sample_id = samples.sample_id)
    `).run());
    return { before, dryRun, matched, deleted: { events, batches, orphanSamples } };
  }

  async getCleanupCounts(before) {
    const events = await firstRow(this.db.prepare('select count(*) as count from events where captured_at < ?').bind(before));
    const batches = await firstRow(this.db.prepare('select count(*) as count from batches where received_at < ?').bind(before));
    const orphanSamples = await firstRow(this.db.prepare(`
      select count(*) as count from samples
      where not exists (
        select 1 from events
        where events.sample_id = samples.sample_id
          and events.captured_at >= ?
      )
    `).bind(before));
    return { events: events.count, batches: batches.count, orphanSamples: orphanSamples.count };
  }
}

export { D1Storage };
