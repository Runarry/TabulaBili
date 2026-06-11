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
import {
  UP_COLUMNS,
  UP_INDEX_STATEMENTS,
  UP_SCHEMA_MIGRATION,
  UP_TABLE_STATEMENTS
} from './up-schema.js';

const MAX_D1_BATCH_STATEMENTS = 100;
const LATEST_SCHEMA_VERSION = 8;

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

function parseJson(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonString(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

function createRunId(kind = 'run') {
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMid(value) {
  const mid = String(value || '').trim();
  return /^\d+$/.test(mid) ? mid : '';
}

function normalizeUpTargetRow(row) {
  if (!row) return null;
  return {
    mid: String(row.mid || ''),
    name: String(row.name || ''),
    seedSource: String(row.seed_source || row.seedSource || ''),
    seedBvid: String(row.seed_bvid || row.seedBvid || ''),
    note: String(row.note || ''),
    status: String(row.status || 'pending'),
    priority: Number(row.priority || 0),
    createdAt: String(row.created_at || row.createdAt || ''),
    updatedAt: String(row.updated_at || row.updatedAt || ''),
    lastCollectedAt: String(row.last_collected_at || row.lastCollectedAt || ''),
    nextCollectAfter: String(row.next_collect_after || row.nextCollectAfter || ''),
    lastErrorType: String(row.last_error_type || row.lastErrorType || ''),
    lastErrorMessage: String(row.last_error_message || row.lastErrorMessage || ''),
    failureCount: Number(row.failure_count || row.failureCount || 0)
  };
}

function normalizeProfileSnapshotRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    mid: String(row.mid || ''),
    name: String(row.name || ''),
    face: String(row.face || ''),
    sign: String(row.sign || ''),
    level: Number(row.level || 0),
    officialType: Number(row.official_type || row.officialType || 0),
    officialTitle: String(row.official_title || row.officialTitle || ''),
    vipType: Number(row.vip_type || row.vipType || 0),
    vipStatus: Number(row.vip_status || row.vipStatus || 0),
    followerCount: Number(row.follower_count || row.followerCount || 0),
    followingCount: Number(row.following_count || row.followingCount || 0),
    archiveCount: Number(row.archive_count || row.archiveCount || 0),
    articleCount: Number(row.article_count || row.articleCount || 0),
    albumCount: Number(row.album_count || row.albumCount || 0),
    favoriteCount: Number(row.favorite_count || row.favoriteCount || 0),
    likeCount: Number(row.like_count || row.likeCount || 0),
    cardJson: parseJson(row.card_json || row.cardJson, {}),
    relationJson: parseJson(row.relation_json || row.relationJson, {}),
    navJson: parseJson(row.nav_json || row.navJson, {}),
    capturedAt: String(row.captured_at || row.capturedAt || '')
  };
}

function normalizeUpVideoRow(row) {
  if (!row) return null;
  return {
    bvid: String(row.bvid || ''),
    aid: String(row.aid || ''),
    mid: String(row.mid || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    coverUrl: String(row.cover_url || row.coverUrl || ''),
    tname: String(row.tname || ''),
    tid: Number(row.tid || 0),
    duration: Number(row.duration || 0),
    pubdate: Number(row.pubdate || 0),
    publishedAt: String(row.published_at || row.publishedAt || ''),
    ownerName: String(row.owner_name || row.ownerName || ''),
    copyright: Number(row.copyright || 0),
    videos: Number(row.videos || 0),
    viewCount: Number(row.view_count || row.viewCount || 0),
    danmakuCount: Number(row.danmaku_count || row.danmakuCount || 0),
    replyCount: Number(row.reply_count || row.replyCount || 0),
    favoriteCount: Number(row.favorite_count || row.favoriteCount || 0),
    coinCount: Number(row.coin_count || row.coinCount || 0),
    shareCount: Number(row.share_count || row.shareCount || 0),
    likeCount: Number(row.like_count || row.likeCount || 0),
    tags: parseJson(row.tags_json || row.tagsJson, []),
    tagsJson: row.tags_json || row.tagsJson || '[]',
    pages: parseJson(row.pages_json || row.pagesJson, []),
    rawJson: parseJson(row.raw_json || row.rawJson, {}),
    firstSeenAt: String(row.first_seen_at || row.firstSeenAt || ''),
    lastSeenAt: String(row.last_seen_at || row.lastSeenAt || '')
  };
}

function normalizeCollectorRunRow(row) {
  if (!row) return null;
  return {
    runId: String(row.run_id || row.runId || ''),
    kind: String(row.kind || ''),
    mid: String(row.mid || ''),
    status: String(row.status || ''),
    startedAt: String(row.started_at || row.startedAt || ''),
    finishedAt: String(row.finished_at || row.finishedAt || ''),
    targetCount: Number(row.target_count || row.targetCount || 0),
    collectedCount: Number(row.collected_count || row.collectedCount || 0),
    videoCount: Number(row.video_count || row.videoCount || 0),
    errorType: String(row.error_type || row.errorType || ''),
    errorMessage: String(row.error_message || row.errorMessage || ''),
    options: parseJson(row.options_json || row.optionsJson, {})
  };
}

function normalizePortraitRow(row) {
  if (!row) return null;
  return {
    mid: String(row.mid || ''),
    rulePortrait: parseJson(row.rule_json || row.ruleJson, {}),
    llmPortrait: parseJson(row.llm_json || row.llmJson, {}),
    summary: String(row.summary || ''),
    contentPositioning: String(row.content_positioning || row.contentPositioning || ''),
    audienceHypothesis: String(row.audience_hypothesis || row.audienceHypothesis || ''),
    contentStyle: String(row.content_style || row.contentStyle || ''),
    commercialFit: String(row.commercial_fit || row.commercialFit || ''),
    risks: parseJson(row.risks_json || row.risksJson, []),
    evidence: parseJson(row.evidence_json || row.evidenceJson, []),
    provider: String(row.provider || ''),
    model: String(row.model || ''),
    promptVersion: String(row.prompt_version || row.promptVersion || ''),
    generatedAt: String(row.generated_at || row.generatedAt || ''),
    llmErrorType: String(row.llm_error_type || row.llmErrorType || ''),
    llmErrorMessage: String(row.llm_error_message || row.llmErrorMessage || ''),
    updatedAt: String(row.updated_at || row.updatedAt || '')
  };
}

function getUpProfileOrderBy(sort) {
  switch (sort) {
    case 'followers':
      return 'coalesce(latest.follower_count, 0) desc, target.updated_at desc';
    case 'videos':
      return 'video_count desc, target.updated_at desc';
    case 'collected':
      return 'target.last_collected_at desc, target.updated_at desc';
    case 'name':
      return 'coalesce(nullif(latest.name, \'\'), target.name) asc';
    default:
      return 'target.updated_at desc';
  }
}

function getVideoOrderBy(sort) {
  switch (sort) {
    case 'views':
      return 'view_count desc, pubdate desc';
    case 'likes':
      return 'like_count desc, pubdate desc';
    default:
      return 'pubdate desc, last_seen_at desc';
  }
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
      `create table if not exists report_totals (
        id integer primary key check (id = 1),
        batch_count integer not null default 0,
        event_count integer not null default 0,
        duplicate_event_count integer not null default 0,
        sample_count integer not null default 0,
        updated_at text not null
      )`,
      ...UP_TABLE_STATEMENTS
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
      'create index if not exists idx_d1_daily_metrics_date on daily_metrics(date desc)',
      ...UP_INDEX_STATEMENTS
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
      ['samples', 'feedback_updated_at', "text not null default ''"],
      ...UP_COLUMNS
    ]);
    for (const sql of indexStatements) {
      await this.db.prepare(sql).run();
    }
    await this.db.prepare('drop index if exists idx_d1_events_up_name_captured_at').run();
    await this.refreshReportTotals();
    await this.recordMigrations([
      [1, 'base_tables'],
      [2, 'structured_event_columns'],
      [3, 'sample_timestamps'],
      [4, 'daily_metrics'],
      [5, 'analytics_indexes'],
      [6, 'drop_events_up_name_index'],
      [7, 'report_totals'],
      UP_SCHEMA_MIGRATION
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

  async refreshReportTotals() {
    await this.db.prepare(`
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
    `).bind(new Date().toISOString()).run();
  }

  async incrementReportTotals(delta) {
    const batchCount = Number(delta.batchCount || 0);
    const eventCount = Number(delta.eventCount || 0);
    const duplicateEventCount = Number(delta.duplicateEventCount || 0);
    const sampleCount = Number(delta.sampleCount || 0);
    if (!batchCount && !eventCount && !duplicateEventCount && !sampleCount) return;
    await this.db.prepare(`
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
    `).bind(batchCount, eventCount, duplicateEventCount, sampleCount, new Date().toISOString()).run();
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
    const newSampleIds = new Set();
    const dailyMetrics = new Map();
    let insertedEventCount = 0;

    for (let index = 0; index < eventEntries.length; index += 1) {
      const { info, event, eventRow, sampleId } = eventEntries[index];
      if (changesOf(insertResults[index]) === 0) {
        info.duplicateEventCount += 1;
        continue;
      }
      insertedEventCount += 1;
      addDailyMetricEvent(dailyMetrics, eventRow);

      if (!sampleId) continue;
      if (!existingAggregates.has(sampleId)) newSampleIds.add(sampleId);
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
    await this.incrementReportTotals({
      batchCount: activeBatchInfos.length,
      eventCount: insertedEventCount,
      duplicateEventCount: activeBatchInfos.reduce((sum, info) => sum + info.duplicateEventCount, 0),
      sampleCount: newSampleIds.size
    });

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
      const totals = await firstRow(db.prepare(`
        select
          batch_count as batchCount,
          event_count as eventCount,
          duplicate_event_count as duplicateEventCount,
          sample_count as sampleCount
        from report_totals
        where id = 1
      `));
      if (totals) return totals;
    } catch (error) {
      if (!isMissingTableError(error, ['report_totals'])) throw error;
    }

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
    await this.refreshReportTotals();
    return { before, dryRun, matched, deleted: { events, batches, orphanSamples } };
  }

  async importUpTargets(mids, options = {}) {
    await this.ensureReady();
    const now = new Date().toISOString();
    const source = String(options.source || options.seedSource || 'manual');
    const seedBvid = String(options.seedBvid || options.bvid || '');
    const note = String(options.note || '');
    const priority = Number(options.priority || 0);
    const normalized = [...new Set((Array.isArray(mids) ? mids : []).map(normalizeMid).filter(Boolean))];
    const items = [];
    let imported = 0;
    let existing = 0;
    for (const mid of normalized) {
      const before = await firstRow(this.db.prepare('select mid from up_targets where mid = ?').bind(mid));
      await this.db.prepare(`
        insert into up_targets (
          mid, seed_source, seed_bvid, note, status, priority, created_at, updated_at
        )
        values (?, ?, ?, ?, 'pending', ?, ?, ?)
        on conflict(mid) do update set
          seed_source = case when excluded.seed_source <> '' then excluded.seed_source else up_targets.seed_source end,
          seed_bvid = case when excluded.seed_bvid <> '' then excluded.seed_bvid else up_targets.seed_bvid end,
          note = case when excluded.note <> '' then excluded.note else up_targets.note end,
          priority = max(up_targets.priority, excluded.priority),
          updated_at = excluded.updated_at
      `).bind(mid, source, seedBvid, note, priority, now, now).run();
      if (before) existing += 1;
      else imported += 1;
      items.push(await this.getUpTarget(mid));
    }
    return {
      items,
      imported,
      existing,
      skipped: (Array.isArray(mids) ? mids.length : 0) - normalized.length
    };
  }

  async getUpTarget(mid) {
    try {
      const row = await firstRow(this.getReadDb().prepare('select * from up_targets where mid = ?').bind(String(mid)));
      return normalizeUpTargetRow(row);
    } catch (error) {
      if (!isMissingTableError(error, ['up_targets'])) throw error;
      return null;
    }
  }

  async listUpTargets(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const where = [];
    const args = [];
    const q = String(options.q || '').trim();
    const status = String(options.status || '').trim();
    if (q) {
      where.push('(target.mid like ? or target.name like ? or latest.name like ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status && status !== 'all') {
      where.push('target.status = ?');
      args.push(status);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const fetchLimit = limit + (includeTotal ? 0 : 1);
    try {
      const rows = await allRows(this.getReadDb().prepare(`
        select target.*,
          coalesce(nullif(target.name, ''), latest.name, '') as name
        from up_targets target
        left join (
          select s.*
          from up_profile_snapshots s
          join (
            select mid, max(captured_at) as captured_at
            from up_profile_snapshots
            group by mid
          ) latest_key on latest_key.mid = s.mid and latest_key.captured_at = s.captured_at
        ) latest on latest.mid = target.mid
        ${whereSql}
        order by target.priority desc, target.updated_at desc
        limit ? offset ?
      `).bind(...args, fetchLimit, offset));
      const items = rows.slice(0, limit).map(normalizeUpTargetRow);
      if (!includeTotal) return { items, hasMore: rows.length > limit };
      const total = await firstRow(this.getReadDb().prepare(`
        select count(*) as count
        from up_targets target
        left join (
          select mid, name, max(captured_at) as captured_at
          from up_profile_snapshots
          group by mid
        ) latest on latest.mid = target.mid
        ${whereSql}
      `).bind(...args));
      return { items, total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['up_targets'])) throw error;
      return includeTotal ? { items: [], total: 0 } : { items: [], hasMore: false };
    }
  }

  async listDueUpTargets(options = {}) {
    const limit = normalizeLimit(options.limit, 50, 1);
    const now = String(options.now || new Date().toISOString());
    try {
      const rows = await allRows(this.getReadDb().prepare(`
        select *
        from up_targets
        where status <> 'running'
          and (next_collect_after = '' or next_collect_after <= ?)
        order by priority desc,
          case when last_collected_at = '' then 0 else 1 end asc,
          last_collected_at asc,
          updated_at asc
        limit ?
      `).bind(now, limit));
      return { items: rows.map(normalizeUpTargetRow), total: rows.length };
    } catch (error) {
      if (!isMissingTableError(error, ['up_targets'])) throw error;
      return { items: [], total: 0 };
    }
  }

  async updateUpTargetStatus(mid, fields = {}) {
    await this.ensureReady();
    const targetMid = normalizeMid(mid);
    if (!targetMid) throw new Error('invalid_mid');
    const now = fields.updatedAt || new Date().toISOString();
    await this.db.prepare(`
      insert or ignore into up_targets (mid, status, created_at, updated_at)
      values (?, 'pending', ?, ?)
    `).bind(targetMid, now, now).run();
    const allowed = [
      ['name', 'name'],
      ['status', 'status'],
      ['lastCollectedAt', 'last_collected_at'],
      ['nextCollectAfter', 'next_collect_after'],
      ['lastErrorType', 'last_error_type'],
      ['lastErrorMessage', 'last_error_message'],
      ['failureCount', 'failure_count'],
      ['updatedAt', 'updated_at']
    ];
    const sets = [];
    const args = [];
    for (const [key, column] of allowed) {
      if (!Object.hasOwn(fields, key)) continue;
      sets.push(`${column} = ?`);
      args.push(fields[key] == null ? '' : fields[key]);
    }
    if (!sets.includes('updated_at = ?')) {
      sets.push('updated_at = ?');
      args.push(now);
    }
    args.push(targetMid);
    await this.db.prepare(`update up_targets set ${sets.join(', ')} where mid = ?`).bind(...args).run();
    return this.getUpTarget(targetMid);
  }

  async saveUpProfileSnapshot(profile = {}) {
    await this.ensureReady();
    const capturedAt = profile.capturedAt || new Date().toISOString();
    await this.db.prepare(`
      insert into up_profile_snapshots (
        mid, name, face, sign, level, official_type, official_title, vip_type, vip_status,
        follower_count, following_count, archive_count, article_count, album_count,
        favorite_count, like_count, card_json, relation_json, nav_json, captured_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(profile.mid || ''),
      String(profile.name || ''),
      String(profile.face || ''),
      String(profile.sign || ''),
      Number(profile.level || 0),
      Number(profile.officialType || 0),
      String(profile.officialTitle || ''),
      Number(profile.vipType || 0),
      Number(profile.vipStatus || 0),
      Number(profile.followerCount || 0),
      Number(profile.followingCount || 0),
      Number(profile.archiveCount || 0),
      Number(profile.articleCount || 0),
      Number(profile.albumCount || 0),
      Number(profile.favoriteCount || 0),
      Number(profile.likeCount || 0),
      jsonString(profile.cardJson),
      jsonString(profile.relationJson),
      jsonString(profile.navJson),
      capturedAt
    ).run();
    await this.updateUpTargetStatus(profile.mid, { name: profile.name || '', updatedAt: capturedAt });
    return this.getLatestUpProfileSnapshot(profile.mid);
  }

  async getLatestUpProfileSnapshot(mid) {
    try {
      const row = await firstRow(this.getReadDb().prepare(`
        select *
        from up_profile_snapshots
        where mid = ?
        order by captured_at desc, id desc
        limit 1
      `).bind(String(mid)));
      return normalizeProfileSnapshotRow(row);
    } catch (error) {
      if (!isMissingTableError(error, ['up_profile_snapshots'])) throw error;
      return null;
    }
  }

  async upsertUpVideo(video = {}) {
    await this.ensureReady();
    const now = new Date().toISOString();
    const row = {
      bvid: String(video.bvid || ''),
      aid: String(video.aid || ''),
      mid: String(video.mid || ''),
      title: String(video.title || ''),
      description: String(video.description || video.desc || ''),
      coverUrl: String(video.coverUrl || video.cover_url || ''),
      tname: String(video.tname || ''),
      tid: Number(video.tid || 0),
      duration: Number(video.duration || 0),
      pubdate: Number(video.pubdate || 0),
      publishedAt: String(video.publishedAt || ''),
      ownerName: String(video.ownerName || video.owner_name || ''),
      copyright: Number(video.copyright || 0),
      videos: Number(video.videos || 0),
      viewCount: Number(video.viewCount || 0),
      danmakuCount: Number(video.danmakuCount || 0),
      replyCount: Number(video.replyCount || 0),
      favoriteCount: Number(video.favoriteCount || 0),
      coinCount: Number(video.coinCount || 0),
      shareCount: Number(video.shareCount || 0),
      likeCount: Number(video.likeCount || 0),
      tagsJson: jsonString(video.tags || video.tagsJson, []),
      pagesJson: jsonString(video.pages || video.pagesJson, []),
      rawJson: jsonString(video.rawJson || video.raw_json, {})
    };
    if (!row.bvid || !row.mid) throw new Error('invalid_video');
    await this.db.prepare(`
      insert into up_videos (
        bvid, aid, mid, title, description, cover_url, tname, tid, duration, pubdate,
        published_at, owner_name, copyright, videos, view_count, danmaku_count, reply_count,
        favorite_count, coin_count, share_count, like_count, tags_json, pages_json, raw_json,
        first_seen_at, last_seen_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(bvid) do update set
        aid = coalesce(nullif(excluded.aid, ''), up_videos.aid),
        mid = excluded.mid,
        title = coalesce(nullif(excluded.title, ''), up_videos.title),
        description = coalesce(nullif(excluded.description, ''), up_videos.description),
        cover_url = coalesce(nullif(excluded.cover_url, ''), up_videos.cover_url),
        tname = coalesce(nullif(excluded.tname, ''), up_videos.tname),
        tid = case when excluded.tid > 0 then excluded.tid else up_videos.tid end,
        duration = case when excluded.duration > 0 then excluded.duration else up_videos.duration end,
        pubdate = case when excluded.pubdate > 0 then excluded.pubdate else up_videos.pubdate end,
        published_at = coalesce(nullif(excluded.published_at, ''), up_videos.published_at),
        owner_name = coalesce(nullif(excluded.owner_name, ''), up_videos.owner_name),
        copyright = case when excluded.copyright > 0 then excluded.copyright else up_videos.copyright end,
        videos = case when excluded.videos > 0 then excluded.videos else up_videos.videos end,
        view_count = max(up_videos.view_count, excluded.view_count),
        danmaku_count = max(up_videos.danmaku_count, excluded.danmaku_count),
        reply_count = max(up_videos.reply_count, excluded.reply_count),
        favorite_count = max(up_videos.favorite_count, excluded.favorite_count),
        coin_count = max(up_videos.coin_count, excluded.coin_count),
        share_count = max(up_videos.share_count, excluded.share_count),
        like_count = max(up_videos.like_count, excluded.like_count),
        tags_json = case when excluded.tags_json <> '[]' then excluded.tags_json else up_videos.tags_json end,
        pages_json = case when excluded.pages_json <> '[]' then excluded.pages_json else up_videos.pages_json end,
        raw_json = case when excluded.raw_json <> '{}' then excluded.raw_json else up_videos.raw_json end,
        last_seen_at = excluded.last_seen_at
    `).bind(
      row.bvid, row.aid, row.mid, row.title, row.description, row.coverUrl, row.tname,
      row.tid, row.duration, row.pubdate, row.publishedAt, row.ownerName, row.copyright,
      row.videos, row.viewCount, row.danmakuCount, row.replyCount, row.favoriteCount,
      row.coinCount, row.shareCount, row.likeCount, row.tagsJson, row.pagesJson, row.rawJson,
      now, now
    ).run();
    return normalizeUpVideoRow(await firstRow(this.db.prepare('select * from up_videos where bvid = ?').bind(row.bvid)));
  }

  async saveVideoMetricSnapshot(video = {}) {
    await this.ensureReady();
    const capturedAt = video.capturedAt || new Date().toISOString();
    await this.db.prepare(`
      insert into video_metric_snapshots (
        bvid, mid, captured_at, view_count, danmaku_count, reply_count,
        favorite_count, coin_count, share_count, like_count
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(video.bvid || ''),
      String(video.mid || ''),
      capturedAt,
      Number(video.viewCount || 0),
      Number(video.danmakuCount || 0),
      Number(video.replyCount || 0),
      Number(video.favoriteCount || 0),
      Number(video.coinCount || 0),
      Number(video.shareCount || 0),
      Number(video.likeCount || 0)
    ).run();
  }

  async listUpVideos(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const mid = String(options.mid || '').trim();
    const q = String(options.q || '').trim();
    const where = [];
    const args = [];
    if (mid) {
      where.push('mid = ?');
      args.push(mid);
    }
    if (q) {
      where.push('(bvid like ? or title like ? or tname like ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const fetchLimit = limit + (includeTotal ? 0 : 1);
    try {
      const rows = await allRows(this.getReadDb().prepare(`
        select *
        from up_videos
        ${whereSql}
        order by ${getVideoOrderBy(options.sort)}
        limit ? offset ?
      `).bind(...args, fetchLimit, offset));
      const items = rows.slice(0, limit).map(normalizeUpVideoRow);
      if (!includeTotal) return { items, hasMore: rows.length > limit };
      const total = await firstRow(this.getReadDb().prepare(`select count(*) as count from up_videos ${whereSql}`).bind(...args));
      return { items, total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['up_videos'])) throw error;
      return includeTotal ? { items: [], total: 0 } : { items: [], hasMore: false };
    }
  }

  async listKnownUpBvids(mid, options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    try {
      const rows = await allRows(this.getReadDb().prepare(`
        select bvid, max(lastSeenAt) as lastSeenAt
        from (
          select bvid, last_seen_at as lastSeenAt
          from samples
          where up_mid = ? and bvid <> ''
          union all
          select bvid, last_seen_at as lastSeenAt
          from up_videos
          where mid = ? and bvid <> ''
        )
        group by bvid
        order by lastSeenAt desc
        limit ?
      `).bind(String(mid), String(mid), limit));
      return {
        items: rows.map((row) => ({
          bvid: String(row.bvid || ''),
          lastSeenAt: String(row.lastSeenAt || '')
        })),
        total: rows.length
      };
    } catch (error) {
      if (!isMissingTableError(error, ['samples', 'up_videos'])) throw error;
      return { items: [], total: 0 };
    }
  }

  async createCollectorRun(run = {}) {
    await this.ensureReady();
    const startedAt = run.startedAt || new Date().toISOString();
    const runId = run.runId || createRunId(run.kind || 'collector');
    await this.db.prepare(`
      insert into collector_runs (
        run_id, kind, mid, status, started_at, finished_at,
        target_count, collected_count, video_count, error_type, error_message, options_json
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      String(run.kind || ''),
      String(run.mid || ''),
      String(run.status || 'pending'),
      startedAt,
      String(run.finishedAt || ''),
      Number(run.targetCount || 0),
      Number(run.collectedCount || 0),
      Number(run.videoCount || 0),
      String(run.error && run.error.type || run.errorType || ''),
      String(run.error && run.error.message || run.errorMessage || ''),
      jsonString(run.options)
    ).run();
    return this.getCollectorRun(runId);
  }

  async updateCollectorRun(runId, fields = {}) {
    await this.ensureReady();
    const allowed = [
      ['status', 'status'],
      ['finishedAt', 'finished_at'],
      ['targetCount', 'target_count'],
      ['collectedCount', 'collected_count'],
      ['videoCount', 'video_count']
    ];
    const sets = [];
    const args = [];
    for (const [key, column] of allowed) {
      if (!Object.hasOwn(fields, key)) continue;
      sets.push(`${column} = ?`);
      args.push(fields[key] == null ? '' : fields[key]);
    }
    if (Object.hasOwn(fields, 'error')) {
      sets.push('error_type = ?', 'error_message = ?');
      args.push(fields.error && fields.error.type || '', fields.error && fields.error.message || '');
    }
    if (Object.hasOwn(fields, 'options')) {
      sets.push('options_json = ?');
      args.push(jsonString(fields.options));
    }
    if (!sets.length) return this.getCollectorRun(runId);
    args.push(String(runId));
    await this.db.prepare(`update collector_runs set ${sets.join(', ')} where run_id = ?`).bind(...args).run();
    return this.getCollectorRun(runId);
  }

  async getCollectorRun(runId) {
    try {
      const row = await firstRow(this.getReadDb().prepare('select * from collector_runs where run_id = ?').bind(String(runId)));
      return normalizeCollectorRunRow(row);
    } catch (error) {
      if (!isMissingTableError(error, ['collector_runs'])) throw error;
      return null;
    }
  }

  async saveUpPortrait(portrait = {}) {
    await this.ensureReady();
    const now = new Date().toISOString();
    const llm = portrait.llmPortrait || {};
    const error = portrait.llmError || {};
    const mid = String(portrait.mid || '');
    await this.db.prepare(`
      insert into up_portraits (
        mid, rule_json, llm_json, summary, content_positioning, audience_hypothesis,
        content_style, commercial_fit, risks_json, evidence_json, provider, model,
        prompt_version, generated_at, llm_error_type, llm_error_message, updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(mid) do update set
        rule_json = excluded.rule_json,
        llm_json = excluded.llm_json,
        summary = excluded.summary,
        content_positioning = excluded.content_positioning,
        audience_hypothesis = excluded.audience_hypothesis,
        content_style = excluded.content_style,
        commercial_fit = excluded.commercial_fit,
        risks_json = excluded.risks_json,
        evidence_json = excluded.evidence_json,
        provider = excluded.provider,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        generated_at = excluded.generated_at,
        llm_error_type = excluded.llm_error_type,
        llm_error_message = excluded.llm_error_message,
        updated_at = excluded.updated_at
    `).bind(
      mid,
      jsonString(portrait.rulePortrait),
      jsonString(llm),
      String(llm.summary || ''),
      String(llm.contentPositioning || ''),
      String(llm.audienceHypothesis || ''),
      String(llm.contentStyle || ''),
      String(llm.commercialFit || ''),
      jsonString(llm.risks || []),
      jsonString(llm.evidence || []),
      String(llm.provider || ''),
      String(llm.model || ''),
      String(llm.promptVersion || ''),
      String(llm.generatedAt || ''),
      String(error.type || ''),
      String(error.message || ''),
      now
    ).run();
    return this.getUpPortrait(mid);
  }

  async getUpPortrait(mid) {
    try {
      const row = await firstRow(this.getReadDb().prepare('select * from up_portraits where mid = ?').bind(String(mid)));
      return normalizePortraitRow(row);
    } catch (error) {
      if (!isMissingTableError(error, ['up_portraits'])) throw error;
      return null;
    }
  }

  async getUpProfile(mid) {
    const target = await this.getUpTarget(mid);
    const profile = await this.getLatestUpProfileSnapshot(mid);
    const portrait = await this.getUpPortrait(mid);
    let videoStats = { videoCount: 0, averageView: 0, maxView: 0, totalView: 0 };
    try {
      const row = await firstRow(this.getReadDb().prepare(`
        select
          count(*) as videoCount,
          coalesce(avg(view_count), 0) as averageView,
          coalesce(max(view_count), 0) as maxView,
          coalesce(sum(view_count), 0) as totalView
        from up_videos
        where mid = ?
      `).bind(String(mid)));
      videoStats = {
        videoCount: Number(row && row.videoCount || 0),
        averageView: Number(row && row.averageView || 0),
        maxView: Number(row && row.maxView || 0),
        totalView: Number(row && row.totalView || 0)
      };
    } catch (error) {
      if (!isMissingTableError(error, ['up_videos'])) throw error;
    }
    return { target, profile, videoStats, portrait };
  }

  async listUpProfiles(options = {}) {
    const limit = normalizeLimit(options.limit, 500, 50);
    const offset = normalizeOffset(options.offset);
    const includeTotal = options.includeTotal !== false;
    const q = String(options.q || '').trim();
    const where = [];
    const args = [];
    if (q) {
      where.push('(target.mid like ? or target.name like ? or latest.name like ? or portrait.summary like ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const fetchLimit = limit + (includeTotal ? 0 : 1);
    try {
      const rows = await allRows(this.getReadDb().prepare(`
        select target.*,
          coalesce(nullif(latest.name, ''), target.name, '') as profile_name,
          latest.face as face,
          latest.follower_count as follower_count,
          latest.archive_count as archive_count,
          portrait.summary as summary,
          portrait.updated_at as portrait_updated_at,
          count(video.bvid) as video_count,
          coalesce(avg(video.view_count), 0) as average_view,
          coalesce(max(video.view_count), 0) as max_view
        from up_targets target
        left join (
          select s.*
          from up_profile_snapshots s
          join (
            select mid, max(captured_at) as captured_at
            from up_profile_snapshots
            group by mid
          ) latest_key on latest_key.mid = s.mid and latest_key.captured_at = s.captured_at
        ) latest on latest.mid = target.mid
        left join up_portraits portrait on portrait.mid = target.mid
        left join up_videos video on video.mid = target.mid
        ${whereSql}
        group by target.mid
        order by ${getUpProfileOrderBy(options.sort)}
        limit ? offset ?
      `).bind(...args, fetchLimit, offset));
      const items = rows.slice(0, limit).map((row) => ({
        target: normalizeUpTargetRow({
          ...row,
          name: row.profile_name || row.name || ''
        }),
        mid: String(row.mid || ''),
        name: String(row.profile_name || row.name || ''),
        face: String(row.face || ''),
        followerCount: Number(row.follower_count || 0),
        archiveCount: Number(row.archive_count || 0),
        videoCount: Number(row.video_count || 0),
        averageView: Number(row.average_view || 0),
        maxView: Number(row.max_view || 0),
        summary: String(row.summary || ''),
        portraitUpdatedAt: String(row.portrait_updated_at || '')
      }));
      if (!includeTotal) return { items, hasMore: rows.length > limit };
      const total = await firstRow(this.getReadDb().prepare(`
        select count(*) as count from (
          select target.mid
          from up_targets target
          left join (
            select mid, name, max(captured_at) as captured_at
            from up_profile_snapshots
            group by mid
          ) latest on latest.mid = target.mid
          left join up_portraits portrait on portrait.mid = target.mid
          ${whereSql}
        )
      `).bind(...args));
      return { items, total: total.count };
    } catch (error) {
      if (!isMissingTableError(error, ['up_targets', 'up_profile_snapshots', 'up_videos', 'up_portraits'])) throw error;
      return includeTotal ? { items: [], total: 0 } : { items: [], hasMore: false };
    }
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
