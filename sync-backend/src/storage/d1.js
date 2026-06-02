import { getSampleId, mergeAggregate, toEventRow, toSampleRow } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  getAnalyticsEventWhere,
  getReportEventWhere,
  getSampleOrderBy,
  getSampleWhere,
  normalizeAnalyticsOptions,
  normalizeEventListOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent
} from './helpers.js';

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

class D1Storage {
  constructor(db) {
    if (!db) throw new Error('TABULABILI_SYNC_DB D1 binding is required');
    this.db = db;
    this.ready = this.ensureSchema();
  }

  async ensureSchema() {
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
    ];
    const indexStatements = [
      'create index if not exists idx_d1_batches_received_at on batches(received_at desc)',
      'create index if not exists idx_d1_events_captured_at on events(captured_at)',
      'create index if not exists idx_d1_events_kind_captured_at on events(event_kind, captured_at)',
      'create index if not exists idx_d1_events_mode_captured_at on events(mode, captured_at)',
      'create index if not exists idx_d1_events_source_captured_at on events(source, captured_at)',
      'create index if not exists idx_d1_events_category_captured_at on events(category, captured_at)',
      'create index if not exists idx_d1_events_client_captured_at on events(client_id, captured_at)',
      'create index if not exists idx_d1_events_sample_captured_at on events(sample_id, captured_at)',
      'create index if not exists idx_d1_samples_last_seen_at on samples(last_seen_at desc)',
      'create index if not exists idx_d1_samples_first_seen_at on samples(first_seen_at)',
      'create index if not exists idx_d1_samples_up_mid on samples(up_mid)',
      'create index if not exists idx_d1_samples_category on samples(category)',
      'create index if not exists idx_d1_samples_seen_count on samples(seen_count desc)',
      'create index if not exists idx_d1_samples_click_count on samples(click_count desc)',
      'create index if not exists idx_d1_samples_feedback on samples(feedback)'
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
    await this.recordMigrations([
      [1, 'base_tables'],
      [2, 'structured_event_columns'],
      [3, 'sample_timestamps']
    ]);
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
    await this.ready;
    const row = await firstRow(this.db.prepare('select json from config_store where id = 1'));
    return row ? JSON.parse(row.json) : null;
  }

  async saveConfig(config) {
    await this.ready;
    await this.db.prepare(`
      insert into config_store (id, json) values (1, ?)
      on conflict(id) do update set json = excluded.json
    `).bind(JSON.stringify(config)).run();
  }

  async saveReportBatch(batch) {
    await this.ready;
    const existing = await firstRow(this.db.prepare('select event_count as eventCount, duplicate_event_count as duplicateEventCount from batches where batch_id = ?').bind(batch.batchId));
    if (existing) {
      return {
        duplicateBatch: true,
        eventCount: existing.eventCount,
        duplicateEventCount: existing.duplicateEventCount
      };
    }

    const receivedAt = new Date().toISOString();
    let duplicateEventCount = 0;
    await this.db.prepare(`
      insert into batches (batch_id, client_id, captured_at, received_at, event_count, duplicate_event_count, raw_json)
      values (?, ?, ?, ?, ?, 0, ?)
    `).bind(batch.batchId, batch.clientId, batch.capturedAt, receivedAt, batch.events.length, JSON.stringify(batch)).run();

    for (const event of batch.events) {
      const sampleId = getSampleId(event);
      const existingSample = sampleId
        ? await firstRow(this.db.prepare('select json from samples where sample_id = ?').bind(sampleId))
        : null;
      const existingAggregate = existingSample ? JSON.parse(existingSample.json) : null;
      const eventRow = toEventRow(event, batch, receivedAt, existingAggregate);
      const inserted = await this.db.prepare(`
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
      ).run();
      if (changesOf(inserted) === 0) {
        duplicateEventCount += 1;
        continue;
      }

      if (!sampleId) continue;
      const aggregate = mergeAggregate(existingAggregate, event);
      const row = toSampleRow(sampleId, aggregate, receivedAt);
      await this.db.prepare(`
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
      ).run();
    }

    await this.db.prepare('update batches set duplicate_event_count = ? where batch_id = ?').bind(duplicateEventCount, batch.batchId).run();
    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
    await this.ready;
    const row = await firstRow(this.db.prepare(`
      select
        (select count(*) from batches) as batchCount,
        (select count(*) from events) as eventCount,
        (select coalesce(sum(duplicate_event_count), 0) from batches) as duplicateEventCount,
        (select count(*) from samples) as sampleCount
    `));
    return row;
  }

  async listReportBatches(options = {}) {
    await this.ready;
    const limit = normalizeLimit(options.limit, 200);
    const offset = normalizeOffset(options.offset);
    const items = await allRows(this.db.prepare(`
      select batch_id as batchId, client_id as clientId, captured_at as capturedAt, received_at as receivedAt,
        event_count as eventCount, duplicate_event_count as duplicateEventCount
      from batches order by received_at desc limit ? offset ?
    `).bind(limit, offset));
    const total = await firstRow(this.db.prepare('select count(*) as count from batches'));
    return { items, total: total.count };
  }

  async listReportSamples(options = {}) {
    await this.ready;
    const query = normalizeSampleListOptions(options);
    const { whereSql, args } = getSampleWhere(query);
    const orderBy = getSampleOrderBy(query.sort);
    const total = await firstRow(this.db.prepare(`select count(*) as count from samples ${whereSql}`).bind(...args));
    const rows = await allRows(this.db.prepare(`select json from samples ${whereSql} order by ${orderBy} limit ? offset ?`).bind(...args, query.limit, query.offset));
    return { items: rows.map((row) => JSON.parse(row.json)), total: total.count };
  }

  async listReportEvents(options = {}) {
    await this.ready;
    const query = normalizeEventListOptions(options);
    const { whereSql, args } = getReportEventWhere(query);
    const total = await firstRow(this.db.prepare(`select count(*) as count from events ${whereSql}`).bind(...args));
    const rows = await allRows(this.db.prepare(`
      select event_id as eventId, batch_id as batchId, client_id as clientId, sample_id as sampleId,
        captured_at as capturedAt, received_at as receivedAt, event_kind as eventKind, mode, source,
        category, feedback, position, bvid, up_name as upName, up_mid as upMid, raw_json as json
      from events ${whereSql}
      order by captured_at desc
      limit ? offset ?
    `).bind(...args, query.limit, query.offset));
    return { items: rows.map(normalizeStoredEvent), total: total.count };
  }

  async getReportAnalytics(options = {}) {
    await this.ready;
    const query = normalizeAnalyticsOptions(options);
    const { whereSql, args } = getAnalyticsEventWhere(query);
    const events = await allRows(this.db.prepare(`
      select event_id as eventId, batch_id as batchId, client_id as clientId, sample_id as sampleId,
        captured_at as capturedAt, received_at as receivedAt, event_kind as eventKind, mode, source,
        category, feedback, position, bvid, up_name as upName, up_mid as upMid, raw_json as json
      from events ${whereSql}
      order by captured_at asc
    `).bind(...args));
    return buildReportAnalytics({ events, range: query });
  }

  async cleanupReports(options = {}) {
    await this.ready;
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
