const SYNC_DATA_VERSION = 1;
const SYNC_EXPORT_DEFAULT_LIMIT = 200;
const SYNC_EXPORT_MAX_LIMIT = 1000;

const SYNC_DATASET_NAMES = [
  'config',
  'report_batches',
  'report_events',
  'report_samples',
  'daily_metrics',
  'up_targets',
  'up_profile_snapshots',
  'up_videos',
  'video_metric_snapshots',
  'collector_runs',
  'up_portraits'
];

const REPORT_TOTAL_REFRESH_DATASETS = new Set([
  'report_batches',
  'report_events',
  'report_samples'
]);

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonText(value, fallback) {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(fallback);
    }
  }
  return JSON.stringify(value == null ? fallback : value);
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function textValue(value, fallback = '') {
  return value == null ? fallback : String(value);
}

function normalizeSyncLimit(value, fallback = SYNC_EXPORT_DEFAULT_LIMIT) {
  return Math.min(SYNC_EXPORT_MAX_LIMIT, Math.max(1, numberValue(value || fallback, fallback)));
}

function normalizeSyncCursor(value) {
  return Math.max(0, Math.floor(numberValue(value || 0, 0)));
}

function field(column, name, type = 'text', fallback = '', options = {}) {
  return { column, name, type, fallback, ...options };
}

function getItemField(item, definition) {
  if (item && Object.hasOwn(item, definition.name)) return item[definition.name];
  for (const alias of definition.aliases || []) {
    if (item && Object.hasOwn(item, alias)) return item[alias];
  }
  return undefined;
}

function valueToItem(value, definition) {
  if (definition.type === 'number') return numberValue(value, definition.fallback || 0);
  if (definition.type === 'json') return parseJson(value, definition.fallback);
  return textValue(value, definition.fallback || '');
}

function valueToRow(value, definition) {
  if (definition.type === 'number') return numberValue(value, definition.fallback || 0);
  if (definition.type === 'json') return jsonText(value, definition.fallback);
  return textValue(value, definition.fallback || '');
}

function makeSpec(options) {
  const fields = options.fields;
  const columns = fields.map((item) => item.column);
  const insertColumns = fields
    .filter((item) => item.insert !== false)
    .map((item) => item.column);
  const fieldByColumn = new Map(fields.map((item) => [item.column, item]));
  const primaryKey = options.primaryKey || [];
  const identityColumns = options.identityColumns || [];
  const updateColumns = options.updateColumns || insertColumns.filter((column) => !primaryKey.includes(column));
  const compareColumns = options.compareColumns || insertColumns;

  return {
    ...options,
    columns,
    insertColumns,
    updateColumns,
    compareColumns,
    toItem(row = {}) {
      const item = {};
      for (const definition of fields) {
        item[definition.name] = valueToItem(row[definition.column], definition);
      }
      return item;
    },
    toRow(item = {}) {
      const row = {};
      for (const column of insertColumns) {
        const definition = fieldByColumn.get(column);
        row[column] = valueToRow(getItemField(item, definition), definition);
      }
      return row;
    },
    primaryKey,
    identityColumns
  };
}

const SYNC_DATASET_SPECS = {
  config: makeSpec({
    table: 'config_store',
    orderBy: 'id asc',
    fields: [
      field('id', 'id', 'number', 1),
      field('json', 'config', 'json', null, { aliases: ['json'] })
    ],
    primaryKey: ['id'],
    required: ['json']
  }),
  report_batches: makeSpec({
    table: 'batches',
    orderBy: 'batch_id asc',
    fields: [
      field('batch_id', 'batchId'),
      field('client_id', 'clientId'),
      field('captured_at', 'capturedAt'),
      field('received_at', 'receivedAt'),
      field('event_count', 'eventCount', 'number'),
      field('duplicate_event_count', 'duplicateEventCount', 'number'),
      field('raw_json', 'rawJson', 'json', {}, { aliases: ['raw', 'raw_json'] })
    ],
    primaryKey: ['batch_id'],
    required: ['batch_id']
  }),
  report_events: makeSpec({
    table: 'events',
    orderBy: 'event_id asc',
    fields: [
      field('event_id', 'eventId'),
      field('batch_id', 'batchId'),
      field('client_id', 'clientId'),
      field('sample_id', 'sampleId'),
      field('captured_at', 'capturedAt'),
      field('received_at', 'receivedAt'),
      field('event_kind', 'eventKind', 'text', 'impression'),
      field('mode', 'mode'),
      field('source', 'source'),
      field('category', 'category'),
      field('feedback', 'feedback'),
      field('position', 'position', 'number'),
      field('bvid', 'bvid'),
      field('up_name', 'upName'),
      field('up_mid', 'upMid'),
      field('raw_json', 'rawJson', 'json', {}, { aliases: ['raw', 'raw_json'] })
    ],
    primaryKey: ['event_id'],
    required: ['event_id']
  }),
  report_samples: makeSpec({
    table: 'samples',
    orderBy: 'sample_id asc',
    fields: [
      field('sample_id', 'sampleId', 'text', '', { aliases: ['id'] }),
      field('bvid', 'bvid'),
      field('title', 'title'),
      field('up_name', 'upName'),
      field('up_mid', 'upMid'),
      field('category', 'category'),
      field('first_seen_at', 'firstSeenAt'),
      field('last_seen_at', 'lastSeenAt'),
      field('seen_count', 'seenCount', 'number'),
      field('click_count', 'clickCount', 'number'),
      field('feedback', 'feedback', 'text', 'unset'),
      field('last_clicked_at', 'lastClickedAt'),
      field('feedback_updated_at', 'feedbackUpdatedAt'),
      field('json', 'json', 'json', {})
    ],
    primaryKey: ['sample_id'],
    required: ['sample_id']
  }),
  daily_metrics: makeSpec({
    table: 'daily_metrics',
    orderBy: 'date asc, client_id asc, mode asc, source asc, category asc',
    fields: [
      field('date', 'date'),
      field('client_id', 'clientId'),
      field('mode', 'mode'),
      field('source', 'source'),
      field('category', 'category'),
      field('impressions', 'impressions', 'number'),
      field('clicks', 'clicks', 'number'),
      field('feedbacks', 'feedbacks', 'number'),
      field('negative_feedbacks', 'negativeFeedbacks', 'number')
    ],
    primaryKey: ['date', 'client_id', 'mode', 'source', 'category'],
    required: ['date']
  }),
  up_targets: makeSpec({
    table: 'up_targets',
    orderBy: 'mid asc',
    fields: [
      field('mid', 'mid'),
      field('name', 'name'),
      field('seed_source', 'seedSource'),
      field('seed_bvid', 'seedBvid'),
      field('note', 'note'),
      field('status', 'status', 'text', 'pending'),
      field('priority', 'priority', 'number'),
      field('created_at', 'createdAt'),
      field('updated_at', 'updatedAt'),
      field('last_collected_at', 'lastCollectedAt'),
      field('next_collect_after', 'nextCollectAfter'),
      field('last_error_type', 'lastErrorType'),
      field('last_error_message', 'lastErrorMessage'),
      field('failure_count', 'failureCount', 'number')
    ],
    primaryKey: ['mid'],
    required: ['mid']
  }),
  up_profile_snapshots: makeSpec({
    table: 'up_profile_snapshots',
    orderBy: 'id asc',
    fields: [
      field('id', 'id', 'number', 0, { insert: false }),
      field('mid', 'mid'),
      field('name', 'name'),
      field('face', 'face'),
      field('sign', 'sign'),
      field('level', 'level', 'number'),
      field('official_type', 'officialType', 'number'),
      field('official_title', 'officialTitle'),
      field('vip_type', 'vipType', 'number'),
      field('vip_status', 'vipStatus', 'number'),
      field('follower_count', 'followerCount', 'number'),
      field('following_count', 'followingCount', 'number'),
      field('archive_count', 'archiveCount', 'number'),
      field('article_count', 'articleCount', 'number'),
      field('album_count', 'albumCount', 'number'),
      field('favorite_count', 'favoriteCount', 'number'),
      field('like_count', 'likeCount', 'number'),
      field('card_json', 'cardJson', 'json', {}),
      field('relation_json', 'relationJson', 'json', {}),
      field('nav_json', 'navJson', 'json', {}),
      field('captured_at', 'capturedAt')
    ],
    identityColumns: [
      'mid', 'name', 'face', 'sign', 'level', 'official_type', 'official_title',
      'vip_type', 'vip_status', 'follower_count', 'following_count', 'archive_count',
      'article_count', 'album_count', 'favorite_count', 'like_count', 'card_json',
      'relation_json', 'nav_json', 'captured_at'
    ],
    required: ['mid', 'captured_at']
  }),
  up_videos: makeSpec({
    table: 'up_videos',
    orderBy: 'bvid asc',
    fields: [
      field('bvid', 'bvid'),
      field('aid', 'aid'),
      field('mid', 'mid'),
      field('title', 'title'),
      field('description', 'description', 'text', '', { aliases: ['desc'] }),
      field('cover_url', 'coverUrl', 'text', '', { aliases: ['cover_url'] }),
      field('tname', 'tname'),
      field('tid', 'tid', 'number'),
      field('duration', 'duration', 'number'),
      field('pubdate', 'pubdate', 'number'),
      field('published_at', 'publishedAt'),
      field('owner_name', 'ownerName', 'text', '', { aliases: ['owner_name'] }),
      field('copyright', 'copyright', 'number'),
      field('videos', 'videos', 'number'),
      field('view_count', 'viewCount', 'number'),
      field('danmaku_count', 'danmakuCount', 'number'),
      field('reply_count', 'replyCount', 'number'),
      field('favorite_count', 'favoriteCount', 'number'),
      field('coin_count', 'coinCount', 'number'),
      field('share_count', 'shareCount', 'number'),
      field('like_count', 'likeCount', 'number'),
      field('tags_json', 'tags', 'json', [], { aliases: ['tagsJson', 'tags_json'] }),
      field('pages_json', 'pages', 'json', [], { aliases: ['pagesJson', 'pages_json'] }),
      field('raw_json', 'rawJson', 'json', {}, { aliases: ['raw_json'] }),
      field('first_seen_at', 'firstSeenAt'),
      field('last_seen_at', 'lastSeenAt')
    ],
    primaryKey: ['bvid'],
    required: ['bvid', 'mid']
  }),
  video_metric_snapshots: makeSpec({
    table: 'video_metric_snapshots',
    orderBy: 'id asc',
    fields: [
      field('id', 'id', 'number', 0, { insert: false }),
      field('bvid', 'bvid'),
      field('mid', 'mid'),
      field('captured_at', 'capturedAt'),
      field('view_count', 'viewCount', 'number'),
      field('danmaku_count', 'danmakuCount', 'number'),
      field('reply_count', 'replyCount', 'number'),
      field('favorite_count', 'favoriteCount', 'number'),
      field('coin_count', 'coinCount', 'number'),
      field('share_count', 'shareCount', 'number'),
      field('like_count', 'likeCount', 'number')
    ],
    identityColumns: [
      'bvid', 'mid', 'captured_at', 'view_count', 'danmaku_count', 'reply_count',
      'favorite_count', 'coin_count', 'share_count', 'like_count'
    ],
    required: ['bvid', 'mid', 'captured_at']
  }),
  collector_runs: makeSpec({
    table: 'collector_runs',
    orderBy: 'run_id asc',
    fields: [
      field('run_id', 'runId'),
      field('kind', 'kind'),
      field('mid', 'mid'),
      field('status', 'status', 'text', 'pending'),
      field('started_at', 'startedAt'),
      field('finished_at', 'finishedAt'),
      field('target_count', 'targetCount', 'number'),
      field('collected_count', 'collectedCount', 'number'),
      field('video_count', 'videoCount', 'number'),
      field('error_type', 'errorType'),
      field('error_message', 'errorMessage'),
      field('options_json', 'options', 'json', {})
    ],
    primaryKey: ['run_id'],
    required: ['run_id']
  }),
  up_portraits: makeSpec({
    table: 'up_portraits',
    orderBy: 'mid asc',
    fields: [
      field('mid', 'mid'),
      field('rule_json', 'rulePortrait', 'json', {}),
      field('llm_json', 'llmPortrait', 'json', {}),
      field('summary', 'summary'),
      field('content_positioning', 'contentPositioning'),
      field('audience_hypothesis', 'audienceHypothesis'),
      field('content_style', 'contentStyle'),
      field('commercial_fit', 'commercialFit'),
      field('risks_json', 'risks', 'json', []),
      field('evidence_json', 'evidence', 'json', []),
      field('provider', 'provider'),
      field('model', 'model'),
      field('prompt_version', 'promptVersion'),
      field('generated_at', 'generatedAt'),
      field('llm_error_type', 'llmErrorType'),
      field('llm_error_message', 'llmErrorMessage'),
      field('updated_at', 'updatedAt')
    ],
    primaryKey: ['mid'],
    required: ['mid']
  })
};

function getSyncDatasetSpec(dataset) {
  return SYNC_DATASET_SPECS[String(dataset || '')] || null;
}

function assertSyncDataset(dataset) {
  const spec = getSyncDatasetSpec(dataset);
  if (!spec) throw new Error('invalid_sync_dataset');
  return spec;
}

function isMissingSyncTableError(error, tableName) {
  const message = String(error && error.message || error || '').toLowerCase();
  return message.includes('no such table') && message.includes(String(tableName).toLowerCase());
}

function emptySyncExportPage(dataset, cursor, limit) {
  const offset = normalizeSyncCursor(cursor);
  const normalizedLimit = normalizeSyncLimit(limit);
  return {
    version: SYNC_DATA_VERSION,
    dataset,
    cursor: String(offset),
    nextCursor: '',
    limit: normalizedLimit,
    count: 0,
    hasMore: false,
    items: []
  };
}

function buildSyncExportPage(dataset, allItems, options = {}) {
  assertSyncDataset(dataset);
  const offset = normalizeSyncCursor(options.cursor);
  const limit = normalizeSyncLimit(options.limit);
  const rows = (Array.isArray(allItems) ? allItems : []).slice(offset, offset + limit + 1);
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    version: SYNC_DATA_VERSION,
    dataset,
    cursor: String(offset),
    nextCursor: hasMore ? String(offset + limit) : '',
    limit,
    count: items.length,
    hasMore,
    items
  };
}

async function exportSqlSyncDataset(adapter, options = {}) {
  const dataset = String(options.dataset || '');
  const spec = assertSyncDataset(dataset);
  const offset = normalizeSyncCursor(options.cursor);
  const limit = normalizeSyncLimit(options.limit);
  const sql = `
    select ${spec.columns.join(', ')}
    from ${spec.table}
    order by ${spec.orderBy}
    limit ? offset ?
  `;
  try {
    const rows = await adapter.all(sql, [limit + 1, offset]);
    const items = rows.slice(0, limit).map((row) => spec.toItem(row));
    const hasMore = rows.length > limit;
    return {
      version: SYNC_DATA_VERSION,
      dataset,
      cursor: String(offset),
      nextCursor: hasMore ? String(offset + limit) : '',
      limit,
      count: items.length,
      hasMore,
      items
    };
  } catch (error) {
    if (isMissingSyncTableError(error, spec.table)) return emptySyncExportPage(dataset, offset, limit);
    throw error;
  }
}

function buildWhereSql(columns) {
  return columns.map((column) => `${column} = ?`).join(' and ');
}

function valuesForColumns(row, columns) {
  return columns.map((column) => row[column]);
}

function compareValue(value) {
  return value == null ? '' : String(value);
}

function rowsEqual(existing, row, columns) {
  return columns.every((column) => compareValue(existing[column]) === compareValue(row[column]));
}

function createSyncImportStats(dataset, read = 0) {
  return {
    dataset,
    read: Number(read || 0),
    written: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errorCount: 0,
    errors: []
  };
}

function addSyncImportError(stats, index, error) {
  stats.errorCount += 1;
  if (stats.errors.length < 10) {
    stats.errors.push({
      index,
      message: String(error && error.message || error || 'error')
    });
  }
}

function finalizeSyncImportStats(stats) {
  stats.written = stats.inserted + stats.updated;
  return stats;
}

function validateImportRow(spec, row) {
  for (const column of spec.required || []) {
    if (compareValue(row[column]) === '') return false;
  }
  return true;
}

function buildInsertSql(spec) {
  const placeholders = spec.insertColumns.map(() => '?').join(', ');
  if (spec.primaryKey.length) {
    const updateSql = spec.updateColumns.map((column) => `${column} = excluded.${column}`).join(', ');
    return `
      insert into ${spec.table} (${spec.insertColumns.join(', ')})
      values (${placeholders})
      on conflict(${spec.primaryKey.join(', ')}) do update set ${updateSql}
    `;
  }
  return `
    insert into ${spec.table} (${spec.insertColumns.join(', ')})
    values (${placeholders})
  `;
}

async function findExistingSqlRow(adapter, spec, row) {
  if (spec.primaryKey.length) {
    const sql = `
      select ${spec.compareColumns.join(', ')}
      from ${spec.table}
      where ${buildWhereSql(spec.primaryKey)}
      limit 1
    `;
    return adapter.first(sql, valuesForColumns(row, spec.primaryKey));
  }

  if (spec.identityColumns.length) {
    const sql = `
      select ${spec.identityColumns.join(', ')}
      from ${spec.table}
      where ${buildWhereSql(spec.identityColumns)}
      limit 1
    `;
    return adapter.first(sql, valuesForColumns(row, spec.identityColumns));
  }

  return null;
}

async function importSqlSyncDataset(adapter, dataset, items = []) {
  const spec = assertSyncDataset(dataset);
  const rows = Array.isArray(items) ? items : [];
  const stats = createSyncImportStats(dataset, rows.length);
  const insertSql = buildInsertSql(spec);

  for (let index = 0; index < rows.length; index += 1) {
    try {
      const row = spec.toRow(rows[index]);
      if (!validateImportRow(spec, row)) {
        addSyncImportError(stats, index, new Error('invalid_sync_item'));
        continue;
      }

      const existing = await findExistingSqlRow(adapter, spec, row);
      if (existing && rowsEqual(existing, row, spec.primaryKey.length ? spec.compareColumns : spec.identityColumns)) {
        stats.skipped += 1;
        continue;
      }

      await adapter.run(insertSql, valuesForColumns(row, spec.insertColumns));
      if (existing) stats.updated += 1;
      else stats.inserted += 1;
    } catch (error) {
      addSyncImportError(stats, index, error);
    }
  }

  return finalizeSyncImportStats(stats);
}

function canonicalizeSyncItem(dataset, item) {
  const spec = assertSyncDataset(dataset);
  return spec.toItem(spec.toRow(item));
}

function getSyncItemKey(dataset, item) {
  const spec = assertSyncDataset(dataset);
  const row = spec.toRow(item);
  const columns = spec.primaryKey.length ? spec.primaryKey : spec.identityColumns;
  return valuesForColumns(row, columns).map(compareValue).join('\u0001');
}

function syncItemsEqual(dataset, left, right) {
  const spec = assertSyncDataset(dataset);
  const leftRow = spec.toRow(left);
  const rightRow = spec.toRow(right);
  return rowsEqual(leftRow, rightRow, spec.compareColumns);
}

export {
  REPORT_TOTAL_REFRESH_DATASETS,
  SYNC_DATASET_NAMES,
  SYNC_DATA_VERSION,
  SYNC_EXPORT_DEFAULT_LIMIT,
  SYNC_EXPORT_MAX_LIMIT,
  buildSyncExportPage,
  canonicalizeSyncItem,
  createSyncImportStats,
  exportSqlSyncDataset,
  finalizeSyncImportStats,
  getSyncDatasetSpec,
  getSyncItemKey,
  importSqlSyncDataset,
  normalizeSyncLimit,
  syncItemsEqual
};
