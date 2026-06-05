import Database from 'better-sqlite3';
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

class SqliteStorage {
  constructor(filename) {
    this.db = new Database(filename || './data/tabulabili-sync.db');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists config_store (
        id integer primary key check (id = 1),
        json text not null
      );
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      create table if not exists batches (
        batch_id text primary key,
        client_id text not null,
        captured_at text not null,
        received_at text not null,
        event_count integer not null,
        duplicate_event_count integer not null default 0,
        raw_json text not null
      );
      create table if not exists events (
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
      );
      create table if not exists samples (
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
      );
      create table if not exists daily_metrics (
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
      );
      create table if not exists report_totals (
        id integer primary key check (id = 1),
        batch_count integer not null default 0,
        event_count integer not null default 0,
        duplicate_event_count integer not null default 0,
        sample_count integer not null default 0,
        updated_at text not null
      );
    `);
    this.ensureColumns([
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
    this.db.exec(`
      create index if not exists idx_batches_received_at on batches(received_at desc);
      create index if not exists idx_events_captured_at on events(captured_at);
      create index if not exists idx_events_kind_captured_at on events(event_kind, captured_at);
      create index if not exists idx_events_mode_captured_at on events(mode, captured_at);
      create index if not exists idx_events_source_captured_at on events(source, captured_at);
      create index if not exists idx_events_category_captured_at on events(category, captured_at);
      create index if not exists idx_events_client_captured_at on events(client_id, captured_at);
      create index if not exists idx_events_feedback_captured_at on events(feedback, captured_at);
      create index if not exists idx_events_sample_captured_at on events(sample_id, captured_at);
      create index if not exists idx_events_sample_kind_captured_at on events(sample_id, event_kind, captured_at);
      create index if not exists idx_events_up_mid_captured_at on events(up_mid, captured_at);
      create index if not exists idx_samples_last_seen_at on samples(last_seen_at desc);
      create index if not exists idx_samples_first_seen_at on samples(first_seen_at);
      create index if not exists idx_samples_up_mid on samples(up_mid);
      create index if not exists idx_samples_category on samples(category);
      create index if not exists idx_samples_seen_count on samples(seen_count desc);
      create index if not exists idx_samples_click_count on samples(click_count desc);
      create index if not exists idx_samples_feedback on samples(feedback);
      create index if not exists idx_daily_metrics_date on daily_metrics(date desc);
      drop index if exists idx_events_up_name_captured_at;
    `);
    this.recordMigrations([
      [1, 'base_tables'],
      [2, 'structured_event_columns'],
      [3, 'sample_timestamps'],
      [4, 'daily_metrics'],
      [5, 'analytics_indexes'],
      [6, 'drop_events_up_name_index'],
      [7, 'report_totals']
    ]);
    this.refreshReportTotals();
  }

  ensureColumns(columns) {
    for (const [table, column, definition] of columns) {
      this.ensureColumn(table, column, definition);
    }
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`alter table ${table} add column ${column} ${definition}`).run();
    }
  }

  recordMigrations(migrations) {
    const appliedAt = new Date().toISOString();
    const insert = this.db.prepare('insert or ignore into schema_migrations (version, name, applied_at) values (?, ?, ?)');
    for (const [version, name] of migrations) {
      insert.run(version, name, appliedAt);
    }
  }

  refreshReportTotals() {
    this.db.prepare(`
      insert into report_totals (
        id, batch_count, event_count, duplicate_event_count, sample_count, updated_at
      )
      values (
        1,
        (select count(*) from batches),
        (select count(*) from events),
        (select coalesce(sum(duplicate_event_count), 0) from batches),
        (select count(*) from samples),
        ?
      )
      on conflict(id) do update set
        batch_count = excluded.batch_count,
        event_count = excluded.event_count,
        duplicate_event_count = excluded.duplicate_event_count,
        sample_count = excluded.sample_count,
        updated_at = excluded.updated_at
    `).run(new Date().toISOString());
  }

  incrementReportTotals(delta) {
    const batchCount = Number(delta.batchCount || 0);
    const eventCount = Number(delta.eventCount || 0);
    const duplicateEventCount = Number(delta.duplicateEventCount || 0);
    const sampleCount = Number(delta.sampleCount || 0);
    if (!batchCount && !eventCount && !duplicateEventCount && !sampleCount) return;
    this.db.prepare(`
      insert into report_totals (
        id, batch_count, event_count, duplicate_event_count, sample_count, updated_at
      )
      values (1, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        batch_count = report_totals.batch_count + excluded.batch_count,
        event_count = report_totals.event_count + excluded.event_count,
        duplicate_event_count = report_totals.duplicate_event_count + excluded.duplicate_event_count,
        sample_count = report_totals.sample_count + excluded.sample_count,
        updated_at = excluded.updated_at
    `).run(batchCount, eventCount, duplicateEventCount, sampleCount, new Date().toISOString());
  }

  async getConfig() {
    const row = this.db.prepare('select json from config_store where id = 1').get();
    return row ? JSON.parse(row.json) : null;
  }

  async saveConfig(config) {
    this.db.prepare('insert into config_store (id, json) values (1, ?) on conflict(id) do update set json = excluded.json')
      .run(JSON.stringify(config));
  }

  async saveReportBatch(batch) {
    const existing = this.db.prepare('select batch_id, event_count, duplicate_event_count from batches where batch_id = ?').get(batch.batchId);
    if (existing) {
      return {
        duplicateBatch: true,
        eventCount: existing.event_count,
        duplicateEventCount: existing.duplicate_event_count
      };
    }

    const tx = this.db.transaction(() => {
      const receivedAt = new Date().toISOString();
      let duplicateEventCount = 0;
      let insertedEventCount = 0;
      const newSampleIds = new Set();
      this.db.prepare(`
        insert into batches (batch_id, client_id, captured_at, received_at, event_count, duplicate_event_count, raw_json)
        values (?, ?, ?, ?, ?, 0, ?)
      `).run(batch.batchId, batch.clientId, batch.capturedAt, receivedAt, batch.events.length, JSON.stringify(batch));

      const insertEvent = this.db.prepare(`
        insert or ignore into events (
          event_id, batch_id, client_id, sample_id, captured_at, received_at,
          event_kind, mode, source, category, feedback, position, bvid, up_name, up_mid, raw_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const getSample = this.db.prepare('select json from samples where sample_id = ?');
      const upsertSample = this.db.prepare(`
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
      `);
      const upsertDailyMetric = this.db.prepare(`
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
      `);
      const dailyMetrics = new Map();

      for (const event of batch.events) {
        const sampleId = getSampleId(event);
        const existingSample = sampleId ? getSample.get(sampleId) : null;
        const existingAggregate = existingSample ? JSON.parse(existingSample.json) : null;
        const eventRow = toEventRow(event, batch, receivedAt, existingAggregate);
        const result = insertEvent.run(
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
        if (result.changes === 0) {
          duplicateEventCount += 1;
          continue;
        }
        insertedEventCount += 1;
        if (sampleId && !existingSample) newSampleIds.add(sampleId);
        addDailyMetricEvent(dailyMetrics, eventRow);

        if (!sampleId) continue;
        const aggregate = mergeAggregate(existingAggregate, event);
        const row = toSampleRow(sampleId, aggregate, receivedAt);
        upsertSample.run(
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

      for (const delta of dailyMetrics.values()) {
        upsertDailyMetric.run(
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

      if (duplicateEventCount > 0) {
        this.db.prepare('update batches set duplicate_event_count = ? where batch_id = ?').run(duplicateEventCount, batch.batchId);
      }
      this.incrementReportTotals({
        batchCount: 1,
        eventCount: insertedEventCount,
        duplicateEventCount,
        sampleCount: newSampleIds.size
      });
      return duplicateEventCount;
    });

    const duplicateEventCount = tx();
    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
    try {
      const totals = this.db.prepare(`
        select
          batch_count as batchCount,
          event_count as eventCount,
          duplicate_event_count as duplicateEventCount,
          sample_count as sampleCount
        from report_totals
        where id = 1
      `).get();
      if (totals) return totals;
    } catch (error) {
      if (!String(error && error.message || error).toLowerCase().includes('no such table')) throw error;
    }

    const row = this.db.prepare(`
      select
        (select count(*) from batches) as batchCount,
        (select count(*) from events) as eventCount,
        (select coalesce(sum(duplicate_event_count), 0) from batches) as duplicateEventCount,
        (select count(*) from samples) as sampleCount
    `).get();
    return row;
  }

  async listReportBatches(options = {}) {
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const fetchLimit = limit + (includeTotal ? 0 : 1);
    const rows = this.db.prepare(`
      select batch_id as batchId, client_id as clientId, captured_at as capturedAt, received_at as receivedAt,
        event_count as eventCount, duplicate_event_count as duplicateEventCount
      from batches order by received_at desc limit ? offset ?
    `).all(fetchLimit, offset);
    const items = rows.slice(0, limit);
    if (!includeTotal) return { items, hasMore: rows.length > limit };
    const total = this.db.prepare('select count(*) as count from batches').get().count;
    return { items, total };
  }

  async listReportSamples(options = {}) {
    const query = normalizeSampleListOptions(options);
    const includeTotal = options.includeTotal !== false;
    const fetchLimit = query.limit + (includeTotal ? 0 : 1);
    const { whereSql, args } = getSampleWhere(query);
    const orderBy = getSampleOrderBy(query.sort);
    const rows = this.db.prepare(`select json from samples ${whereSql} order by ${orderBy} limit ? offset ?`).all(...args, fetchLimit, query.offset);
    const items = rows.slice(0, query.limit).map((row) => JSON.parse(row.json));
    if (!includeTotal) return { items, hasMore: rows.length > query.limit };
    const total = this.db.prepare(`select count(*) as count from samples ${whereSql}`).get(...args).count;
    return { items, total };
  }

  async listReportEvents(options = {}) {
    const query = normalizeEventListOptions(options);
    const { whereSql, args } = getReportEventWhere(query);
    const total = this.db.prepare(`select count(*) as count from events ${whereSql}`).get(...args).count;
    const rows = this.db.prepare(`
      select event_id as eventId, batch_id as batchId, client_id as clientId, sample_id as sampleId,
        captured_at as capturedAt, received_at as receivedAt, event_kind as eventKind, mode, source,
        category, feedback, position, bvid, up_name as upName, up_mid as upMid, raw_json as json
      from events ${whereSql}
      order by captured_at desc
      limit ? offset ?
    `).all(...args, query.limit, query.offset);
    return { items: rows.map(normalizeStoredEvent), total };
  }

  async getReportAnalytics(options = {}) {
    const specs = buildAnalyticsQuerySpecs(options);
    return executeAnalyticsQueries(specs, {
      first: ({ sql, args }) => this.db.prepare(sql).get(...args),
      all: ({ sql, args }) => this.db.prepare(sql).all(...args)
    });
  }

  async cleanupReports(options = {}) {
    const before = String(options.before || '');
    const dryRun = options.dryRun !== false;
    const matched = this.getCleanupCounts(before);
    if (dryRun) return { before, dryRun, matched, deleted: { events: 0, batches: 0, orphanSamples: 0 } };

    const tx = this.db.transaction(() => {
      const events = this.db.prepare('delete from events where captured_at < ?').run(before).changes;
      const batches = this.db.prepare('delete from batches where received_at < ?').run(before).changes;
      const orphanSamples = this.db.prepare(`
        delete from samples
        where not exists (select 1 from events where events.sample_id = samples.sample_id)
      `).run().changes;
      this.refreshReportTotals();
      return { events, batches, orphanSamples };
    });

    return { before, dryRun, matched, deleted: tx() };
  }

  getCleanupCounts(before) {
    const events = this.db.prepare('select count(*) as count from events where captured_at < ?').get(before).count;
    const batches = this.db.prepare('select count(*) as count from batches where received_at < ?').get(before).count;
    const orphanSamples = this.db.prepare(`
      select count(*) as count from samples
      where not exists (
        select 1 from events
        where events.sample_id = samples.sample_id
          and events.captured_at >= ?
      )
    `).get(before).count;
    return { events, batches, orphanSamples };
  }
}

export { SqliteStorage };
