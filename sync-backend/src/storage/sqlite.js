import Database from 'better-sqlite3';
import { getSampleId, mergeAggregate, toSampleRow } from '../report-aggregate.js';
import {
  buildReportAnalytics,
  getSampleOrderBy,
  getSampleWhere,
  normalizeAnalyticsOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions
} from './helpers.js';

class SqliteStorage {
  constructor(filename) {
    this.db = new Database(filename || './data/tabulabili-sync.db');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists config_store (
        id integer primary key check (id = 1),
        json text not null
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
        raw_json text not null
      );
      create table if not exists samples (
        sample_id text primary key,
        bvid text not null default '',
        title text not null default '',
        up_name text not null default '',
        up_mid text not null default '',
        category text not null default '',
        last_seen_at text not null,
        seen_count integer not null,
        click_count integer not null default 0,
        feedback text not null default 'unset',
        json text not null
      );
      create index if not exists idx_batches_received_at on batches(received_at desc);
      create index if not exists idx_events_captured_at on events(captured_at);
      create index if not exists idx_events_kind on events(raw_json);
      create index if not exists idx_samples_last_seen_at on samples(last_seen_at desc);
      create index if not exists idx_samples_seen_count on samples(seen_count desc);
      create index if not exists idx_samples_click_count on samples(click_count desc);
      create index if not exists idx_samples_feedback on samples(feedback);
    `);
    this.ensureColumn('batches', 'duplicate_event_count', 'integer not null default 0');
    this.ensureColumn('samples', 'bvid', "text not null default ''");
    this.ensureColumn('samples', 'title', "text not null default ''");
    this.ensureColumn('samples', 'up_name', "text not null default ''");
    this.ensureColumn('samples', 'up_mid', "text not null default ''");
    this.ensureColumn('samples', 'category', "text not null default ''");
    this.ensureColumn('samples', 'click_count', 'integer not null default 0');
    this.ensureColumn('samples', 'feedback', "text not null default 'unset'");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`alter table ${table} add column ${column} ${definition}`).run();
    }
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
      this.db.prepare(`
        insert into batches (batch_id, client_id, captured_at, received_at, event_count, duplicate_event_count, raw_json)
        values (?, ?, ?, ?, ?, 0, ?)
      `).run(batch.batchId, batch.clientId, batch.capturedAt, receivedAt, batch.events.length, JSON.stringify(batch));

      const insertEvent = this.db.prepare(`
        insert or ignore into events (event_id, batch_id, client_id, sample_id, captured_at, received_at, raw_json)
        values (?, ?, ?, ?, ?, ?, ?)
      `);
      const getSample = this.db.prepare('select json from samples where sample_id = ?');
      const upsertSample = this.db.prepare(`
        insert into samples (sample_id, bvid, title, up_name, up_mid, category, last_seen_at, seen_count, click_count, feedback, json)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(sample_id) do update set
          bvid = excluded.bvid,
          title = excluded.title,
          up_name = excluded.up_name,
          up_mid = excluded.up_mid,
          category = excluded.category,
          last_seen_at = excluded.last_seen_at,
          seen_count = excluded.seen_count,
          click_count = excluded.click_count,
          feedback = excluded.feedback,
          json = excluded.json
      `);

      for (const event of batch.events) {
        const sampleId = getSampleId(event);
        const result = insertEvent.run(event.eventId, batch.batchId, batch.clientId, sampleId, event.capturedAt, receivedAt, JSON.stringify(event));
        if (result.changes === 0) {
          duplicateEventCount += 1;
          continue;
        }

        if (!sampleId) continue;
        const existingSample = getSample.get(sampleId);
        const aggregate = mergeAggregate(existingSample ? JSON.parse(existingSample.json) : null, event);
        const row = toSampleRow(sampleId, aggregate, receivedAt);
        upsertSample.run(
          row.sampleId,
          row.bvid,
          row.title,
          row.upName,
          row.upMid,
          row.category,
          row.lastSeenAt,
          row.seenCount,
          row.clickCount,
          row.feedback,
          row.json
        );
      }

      this.db.prepare('update batches set duplicate_event_count = ? where batch_id = ?').run(duplicateEventCount, batch.batchId);
      return duplicateEventCount;
    });

    const duplicateEventCount = tx();
    return { duplicateBatch: false, eventCount: batch.events.length, duplicateEventCount };
  }

  async getReportSummary() {
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
    const rows = this.db.prepare(`
      select batch_id as batchId, client_id as clientId, captured_at as capturedAt, received_at as receivedAt,
        event_count as eventCount, duplicate_event_count as duplicateEventCount
      from batches order by received_at desc limit ? offset ?
    `).all(limit, offset);
    const total = this.db.prepare('select count(*) as count from batches').get().count;
    return { items: rows, total };
  }

  async listReportSamples(options = {}) {
    const query = normalizeSampleListOptions(options);
    const { whereSql, args } = getSampleWhere(query);
    const orderBy = getSampleOrderBy(query.sort);
    const total = this.db.prepare(`select count(*) as count from samples ${whereSql}`).get(...args).count;
    const rows = this.db.prepare(`select json from samples ${whereSql} order by ${orderBy} limit ? offset ?`).all(...args, query.limit, query.offset);
    return { items: rows.map((row) => JSON.parse(row.json)), total };
  }

  async getReportAnalytics(options = {}) {
    const { sinceIso, tzOffsetMinutes } = normalizeAnalyticsOptions(options);
    const samples = this.db.prepare('select json from samples').all().map((row) => JSON.parse(row.json));
    const events = this.db.prepare('select raw_json as json from events where captured_at >= ?').all(sinceIso).map((row) => JSON.parse(row.json));
    return buildReportAnalytics({
      samples,
      events,
      metrics: {
        batchCount: this.db.prepare('select count(*) as count from batches').get().count,
        eventCount: this.db.prepare('select count(*) as count from events').get().count
      },
      tzOffsetMinutes
    });
  }
}

export { SqliteStorage };
