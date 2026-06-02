import Database from 'better-sqlite3';
import { getSampleId, mergeAggregate } from '../report-aggregate.js';

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
        last_seen_at text not null,
        seen_count integer not null,
        json text not null
      );
    `);
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
        duplicateEventCount: existing.event_count
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
        insert into samples (sample_id, last_seen_at, seen_count, json)
        values (?, ?, ?, ?)
        on conflict(sample_id) do update set
          last_seen_at = excluded.last_seen_at,
          seen_count = excluded.seen_count,
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
        upsertSample.run(sampleId, aggregate.lastSeenAt, aggregate.seenCount, JSON.stringify(aggregate));
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
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const rows = this.db.prepare(`
      select batch_id as batchId, client_id as clientId, captured_at as capturedAt, received_at as receivedAt,
        event_count as eventCount, duplicate_event_count as duplicateEventCount
      from batches order by received_at desc limit ? offset ?
    `).all(limit, offset);
    const total = this.db.prepare('select count(*) as count from batches').get().count;
    return { items: rows, total };
  }

  async listReportSamples(options = {}) {
    const limit = Math.min(10000, Math.max(1, options.limit || 50));
    const offset = Math.max(0, options.offset || 0);
    const q = String(options.q || '').trim();
    const total = q
      ? this.db.prepare('select count(*) as count from samples where json like ?').get(`%${q}%`).count
      : this.db.prepare('select count(*) as count from samples').get().count;
    const rows = q
      ? this.db.prepare('select json from samples where json like ? order by last_seen_at desc limit ? offset ?').all(`%${q}%`, limit, offset)
      : this.db.prepare('select json from samples order by last_seen_at desc limit ? offset ?').all(limit, offset);
    return { items: rows.map((row) => JSON.parse(row.json)), total };
  }
}

export { SqliteStorage };
