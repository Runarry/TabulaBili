import { getSampleId, normalizeEventKind } from '../report-aggregate.js';

const ANALYTICS_FILTERS = [
  ['clientId', 'client_id'],
  ['mode', 'mode'],
  ['source', 'source'],
  ['category', 'category'],
  ['feedback', 'feedback']
];

const NEGATIVE_FEEDBACK = new Set(['dislike', 'blocked']);
const TOP_ANALYTICS_LIMIT = 20;
const ANALYTICS_SECTIONS = new Set(['overview', 'dimensions', 'top', 'all']);

const SAMPLE_SORTS = new Set([
  'lastSeenAt',
  'seenCount',
  'clickCount',
  'ctr',
  'negativeFeedback',
  'repeatCount',
  'firstSeenAt',
  'lastClickedAt'
]);

const SAMPLE_ORDER_BY = {
  seenCount: 'seen_count desc, last_seen_at desc',
  clickCount: 'click_count desc, last_seen_at desc',
  ctr: 'case when seen_count > 0 then cast(click_count as real) / seen_count else 0 end desc, last_seen_at desc',
  negativeFeedback: "case when feedback in ('dislike', 'blocked') then 1 else 0 end desc, seen_count desc, last_seen_at desc",
  repeatCount: 'case when seen_count > 1 then seen_count - 1 else 0 end desc, last_seen_at desc',
  firstSeenAt: 'first_seen_at desc, last_seen_at desc',
  lastClickedAt: 'last_clicked_at desc, last_seen_at desc',
  lastSeenAt: 'last_seen_at desc'
};

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLimit(value, max = 200, fallback = 50) {
  return Math.min(max, Math.max(1, normalizeNumber(value || fallback, fallback)));
}

function normalizeOffset(value) {
  return Math.max(0, normalizeNumber(value || 0, 0));
}

function normalizeSampleListOptions(options = {}, maxLimit = 10000) {
  const sort = SAMPLE_SORTS.has(options.sort) ? options.sort : 'lastSeenAt';
  return {
    limit: normalizeLimit(options.limit, maxLimit),
    offset: normalizeOffset(options.offset),
    q: String(options.q || '').trim(),
    feedback: String(options.feedback || 'all'),
    sort,
    clientId: normalizeFilter(options.clientId),
    mode: normalizeFilter(options.mode),
    source: normalizeFilter(options.source),
    category: normalizeFilter(options.category),
    upMid: normalizeFilter(options.upMid),
    upName: normalizeFilter(options.upName),
    minSeenCount: Math.max(0, normalizeNumber(options.minSeenCount || 0, 0)),
    minClickCount: Math.max(0, normalizeNumber(options.minClickCount || 0, 0)),
    since: normalizeFilter(options.since),
    until: normalizeFilter(options.until),
    hasFeedback: normalizeBooleanFilter(options.hasFeedback)
  };
}

function getSearchText(item) {
  return [item.id, item.bvid, item.aid, item.title, item.upName, item.upMid, item.category]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

function filterSamples(samples, options, events = []) {
  const q = options.q.toLowerCase();
  const eventSampleIds = getSampleIdsMatchingEventFilters(events, options);
  return samples
    .filter((item) => !eventSampleIds || eventSampleIds.has(item.id || item.sampleId))
    .filter((item) => !q || getSearchText(item).includes(q))
    .filter((item) => options.feedback === 'all' || !options.feedback || item.feedback === options.feedback)
    .filter((item) => !options.category || item.category === options.category)
    .filter((item) => !options.upMid || item.upMid === options.upMid)
    .filter((item) => !options.upName || String(item.upName || '').includes(options.upName))
    .filter((item) => Number(item.seenCount || 0) >= options.minSeenCount)
    .filter((item) => Number(item.clickCount || 0) >= options.minClickCount)
    .filter((item) => options.hasFeedback == null || hasSampleFeedback(item) === options.hasFeedback);
}

function sortSamples(samples, sort) {
  return samples.sort((a, b) => {
    switch (sort) {
      case 'seenCount':
        return Number(b.seenCount || 0) - Number(a.seenCount || 0);
      case 'clickCount':
        return Number(b.clickCount || 0) - Number(a.clickCount || 0);
      case 'ctr':
        return ratio(Number(b.clickCount || 0), Number(b.seenCount || 0)) - ratio(Number(a.clickCount || 0), Number(a.seenCount || 0));
      case 'negativeFeedback':
        return Number(hasNegativeSampleFeedback(b)) - Number(hasNegativeSampleFeedback(a)) || Number(b.seenCount || 0) - Number(a.seenCount || 0);
      case 'repeatCount':
        return Math.max(0, Number(b.seenCount || 0) - 1) - Math.max(0, Number(a.seenCount || 0) - 1);
      case 'firstSeenAt':
        return String(b.firstSeenAt).localeCompare(String(a.firstSeenAt));
      case 'lastClickedAt':
        return String(b.lastClickedAt).localeCompare(String(a.lastClickedAt));
      default:
        return String(b.lastSeenAt).localeCompare(String(a.lastSeenAt));
    }
  });
}

function getSampleWhere(options) {
  const where = [];
  const args = [];
  if (options.q) {
    where.push('(sample_id like ? or bvid like ? or title like ? or up_name like ? or up_mid like ? or category like ?)');
    for (let i = 0; i < 6; i += 1) args.push(`%${options.q}%`);
  }
  if (options.feedback && options.feedback !== 'all') {
    where.push('feedback = ?');
    args.push(options.feedback);
  }
  if (options.category) {
    where.push('category = ?');
    args.push(options.category);
  }
  if (options.upMid) {
    where.push('up_mid = ?');
    args.push(options.upMid);
  }
  if (options.upName) {
    where.push('up_name like ?');
    args.push(`%${options.upName}%`);
  }
  if (options.minSeenCount > 0) {
    where.push('seen_count >= ?');
    args.push(options.minSeenCount);
  }
  if (options.minClickCount > 0) {
    where.push('click_count >= ?');
    args.push(options.minClickCount);
  }
  if (options.hasFeedback === true) {
    where.push("feedback <> 'unset'");
  }
  if (options.hasFeedback === false) {
    where.push("feedback = 'unset'");
  }
  const eventFilter = getSampleEventFilterWhere(options);
  if (eventFilter.whereSql) {
    where.push(`exists (select 1 from events where events.sample_id = samples.sample_id and ${eventFilter.whereSql})`);
    args.push(...eventFilter.args);
  }
  return {
    whereSql: where.length ? `where ${where.join(' and ')}` : '',
    args
  };
}

function getSampleOrderBy(sort) {
  return SAMPLE_ORDER_BY[sort] || SAMPLE_ORDER_BY.lastSeenAt;
}

function hasSampleEventFilters(options) {
  return Boolean(options.clientId || options.mode || options.source || options.since || options.until);
}

function getSampleEventFilterWhere(options) {
  const where = [];
  const args = [];
  if (options.clientId) {
    where.push('client_id = ?');
    args.push(options.clientId);
  }
  if (options.mode) {
    where.push('mode = ?');
    args.push(options.mode);
  }
  if (options.source) {
    where.push('source = ?');
    args.push(options.source);
  }
  if (options.since) {
    where.push('captured_at >= ?');
    args.push(options.since);
  }
  if (options.until) {
    where.push('captured_at <= ?');
    args.push(options.until);
  }
  return {
    whereSql: where.join(' and '),
    args
  };
}

function getSampleIdsMatchingEventFilters(events, options) {
  if (!hasSampleEventFilters(options)) return null;
  const ids = new Set();
  for (const event of events) {
    const normalized = normalizeStoredEvent(event);
    if (!eventMatchesSampleFilters(normalized, options)) continue;
    const sampleId = normalized.sampleId || getSampleId(normalized);
    if (sampleId) ids.add(sampleId);
  }
  return ids;
}

function eventMatchesSampleFilters(event, options) {
  if (options.clientId && event.clientId !== options.clientId) return false;
  if (options.mode && event.mode !== options.mode) return false;
  if (options.source && event.source !== options.source) return false;
  if (options.since && String(event.capturedAt || '') < options.since) return false;
  if (options.until && String(event.capturedAt || '') > options.until) return false;
  return true;
}

function normalizeFilter(value) {
  const text = String(value || '').trim();
  return text && text !== 'all' ? text : '';
}

function normalizeBooleanFilter(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes') return true;
  if (text === '0' || text === 'false' || text === 'no') return false;
  return null;
}

function countBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function isNegativeFeedback(event) {
  return NEGATIVE_FEEDBACK.has(event.feedback);
}

function hasSampleFeedback(sample) {
  return Boolean(sample.feedback && sample.feedback !== 'unset');
}

function hasNegativeSampleFeedback(sample) {
  return NEGATIVE_FEEDBACK.has(sample.feedback);
}

function getLocalDateKey(value, tzOffsetMinutes) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time + Number(tzOffsetMinutes || 0) * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeAnalyticsOptions(options = {}) {
  const days = Math.min(90, Math.max(1, normalizeNumber(options.days || 30, 30)));
  const tzOffsetMinutes = normalizeNumber(options.tzOffsetMinutes || 0, 0);
  const sinceMs = Date.now() - (days - 1) * 24 * 60 * 60 * 1000;
  const filters = Object.fromEntries(
    ANALYTICS_FILTERS.map(([key]) => [key, normalizeFilter(options[key])])
  );
  return {
    days,
    tzOffsetMinutes,
    sinceMs,
    sinceIso: new Date(sinceMs).toISOString(),
    ...filters,
    filters
  };
}

function normalizeAnalyticsSection(value) {
  const section = String(value || 'all').trim().toLowerCase();
  return ANALYTICS_SECTIONS.has(section) ? section : 'all';
}

function filterReportAnalyticsSection(analytics, sectionValue) {
  const section = normalizeAnalyticsSection(sectionValue);
  if (section === 'all') return analytics;
  if (section === 'overview') {
    const metrics = { ...(analytics.metrics || {}) };
    delete metrics.repeatSampleCount;
    delete metrics.repeatImpressionCount;
    delete metrics.repeatImpressionRate;
    return {
      range: analytics.range,
      metrics,
      trends: analytics.trends || []
    };
  }
  if (section === 'dimensions') {
    const dimensions = analytics.dimensions || {};
    return {
      range: analytics.range,
      dimensions,
      modes: dimensions.modes || analytics.modes || [],
      sources: dimensions.sources || analytics.sources || [],
      categories: dimensions.categories || analytics.categories || [],
      positions: dimensions.positions || [],
      feedback: dimensions.feedback || analytics.feedback || []
    };
  }

  const top = analytics.top || {};
  return {
    range: analytics.range,
    top,
    topUps: top.ups || analytics.topUps || [],
    samples: top.samples || [],
    repeatedSamples: top.repeatedSamples || []
  };
}

function normalizeEventListOptions(options = {}) {
  const days = Math.min(365, Math.max(1, normalizeNumber(options.days || 30, 30)));
  const sinceMs = Date.now() - (days - 1) * 24 * 60 * 60 * 1000;
  return {
    limit: normalizeLimit(options.limit, 500, 100),
    offset: normalizeOffset(options.offset),
    sampleId: normalizeFilter(options.sampleId),
    eventKind: ['impression', 'click', 'feedback'].includes(options.eventKind) ? options.eventKind : '',
    days,
    sinceMs,
    sinceIso: new Date(sinceMs).toISOString()
  };
}

function getAnalyticsEventWhere(options) {
  const where = ['captured_at >= ?'];
  const args = [options.sinceIso];

  for (const [key, column] of ANALYTICS_FILTERS) {
    if (!options[key]) continue;
    where.push(`${column} = ?`);
    args.push(options[key]);
  }

  return {
    whereSql: `where ${where.join(' and ')}`,
    args
  };
}

function getReportEventWhere(options) {
  const where = ['sample_id = ?', 'captured_at >= ?'];
  const args = [options.sampleId, options.sinceIso];
  if (options.eventKind) {
    where.push('event_kind = ?');
    args.push(options.eventKind);
  }
  return {
    whereSql: `where ${where.join(' and ')}`,
    args
  };
}

function eventMatchesAnalyticsOptions(event, options) {
  const capturedMs = Date.parse(event.capturedAt || event.receivedAt || '');
  if (!Number.isFinite(capturedMs) || capturedMs < options.sinceMs) return false;

  return ANALYTICS_FILTERS.every(([key]) => !options[key] || String(event[key] || '') === options[key]);
}

function eventMatchesReportEventOptions(event, options) {
  const normalized = event && event.sampleId && event.eventKind ? event : normalizeStoredEvent(event);
  const capturedMs = Date.parse(normalized.capturedAt || normalized.receivedAt || '');
  if (!options.sampleId || normalized.sampleId !== options.sampleId) return false;
  if (!Number.isFinite(capturedMs) || capturedMs < options.sinceMs) return false;
  if (options.eventKind && normalized.eventKind !== options.eventKind) return false;
  return true;
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizePosition(...values) {
  for (const value of values) {
    const position = Number(value);
    if (Number.isFinite(position) && position > 0) return position;
  }
  return 0;
}

function normalizeStoredEvent(row) {
  const raw = parseJsonObject(row && (row.json || row.rawJson || row.raw_json));
  const source = row && typeof row === 'object' ? row : {};
  const eventKind = normalizeEventKind(raw.eventKind || source.eventKind || source.event_kind);
  const sampleId = firstText(source.sampleId, source.sample_id, getSampleId(raw));

  return {
    ...raw,
    eventId: firstText(source.eventId, source.event_id, raw.eventId),
    batchId: firstText(source.batchId, source.batch_id, raw.batchId),
    clientId: firstText(source.clientId, source.client_id, raw.clientId),
    sampleId,
    id: raw.id || sampleId,
    capturedAt: firstText(source.capturedAt, source.captured_at, raw.capturedAt),
    receivedAt: firstText(source.receivedAt, source.received_at, raw.receivedAt),
    eventKind,
    mode: firstText(source.mode, raw.mode),
    source: firstText(source.source, raw.source),
    category: firstText(source.category, source.category_name, raw.category),
    feedback: firstText(source.feedback, raw.feedback),
    position: normalizePosition(source.position, raw.position),
    bvid: firstText(source.bvid, raw.bvid),
    upName: firstText(source.upName, source.up_name, raw.upName),
    upMid: firstText(source.upMid, source.up_mid, raw.upMid)
  };
}

function getDailyMetricDelta(event) {
  const capturedMs = Date.parse(event.capturedAt || '');
  if (!Number.isFinite(capturedMs)) return null;
  const date = new Date(capturedMs).toISOString().slice(0, 10);

  return {
    date,
    clientId: event.clientId || '',
    mode: event.mode || '',
    source: event.source || '',
    category: event.category || '',
    impressions: event.eventKind === 'impression' ? 1 : 0,
    clicks: event.eventKind === 'click' ? 1 : 0,
    feedbacks: event.eventKind === 'feedback' ? 1 : 0,
    negativeFeedbacks: event.eventKind === 'feedback' && isNegativeFeedback(event) ? 1 : 0
  };
}

function getDailyMetricKey(delta) {
  return [
    delta.date,
    delta.clientId,
    delta.mode,
    delta.source,
    delta.category
  ].join('\u0001');
}

function addDailyMetricDelta(bucket, delta) {
  bucket.impressions += delta.impressions;
  bucket.clicks += delta.clicks;
  bucket.feedbacks += delta.feedbacks;
  bucket.negativeFeedbacks += delta.negativeFeedbacks;
}

function addDailyMetricEvent(map, event) {
  const delta = getDailyMetricDelta(event);
  if (!delta) return;
  const key = getDailyMetricKey(delta);
  if (!map.has(key)) {
    map.set(key, {
      date: delta.date,
      clientId: delta.clientId,
      mode: delta.mode,
      source: delta.source,
      category: delta.category,
      impressions: 0,
      clicks: 0,
      feedbacks: 0,
      negativeFeedbacks: 0
    });
  }
  addDailyMetricDelta(map.get(key), delta);
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function finalizeSqlMetricRow(row = {}) {
  const impressions = toNumber(row.impressions);
  const clicks = toNumber(row.clicks);
  const feedbacks = toNumber(row.feedbacks);
  const negativeFeedbacks = toNumber(row.negativeFeedbacks);
  const positionCount = toNumber(row.positionCount);

  return {
    key: String(row.key || 'unknown'),
    impressions,
    clicks,
    feedbacks,
    negativeFeedbacks,
    sampleCount: toNumber(row.sampleCount),
    ctr: ratio(clicks, impressions),
    feedbackRate: ratio(feedbacks, impressions),
    negativeFeedbackRate: ratio(negativeFeedbacks, impressions),
    avgPosition: ratio(toNumber(row.positionSum), positionCount),
    count: impressions
  };
}

function finalizeSqlTrendRow(row = {}) {
  const impressions = toNumber(row.impressions);
  const clicks = toNumber(row.clicks);
  const feedbacks = toNumber(row.feedbacks);
  const negativeFeedbacks = toNumber(row.negativeFeedbacks);

  return {
    date: String(row.date || ''),
    impressions,
    clicks,
    feedbacks,
    negativeFeedbacks,
    ctr: ratio(clicks, impressions),
    feedbackRate: ratio(feedbacks, impressions),
    negativeFeedbackRate: ratio(negativeFeedbacks, impressions)
  };
}

function finalizeSqlTopUpRow(row = {}) {
  const metric = finalizeSqlMetricRow(row);
  return {
    ...metric,
    upName: String(row.upName || metric.key),
    seenCount: metric.impressions,
    clickCount: metric.clicks,
    feedbackCount: metric.feedbacks,
    negativeFeedbackCount: metric.negativeFeedbacks
  };
}

function finalizeSqlTopSampleRow(row = {}) {
  const metric = finalizeSqlMetricRow(row);
  const repeatImpressionCount = Math.max(0, metric.impressions - 1);

  return {
    ...metric,
    sampleId: String(row.sampleId || row.key || ''),
    bvid: String(row.bvid || ''),
    title: String(row.title || ''),
    upName: String(row.upName || ''),
    upMid: String(row.upMid || ''),
    category: String(row.category || ''),
    seenCount: metric.impressions,
    clickCount: metric.clicks,
    feedbackCount: metric.feedbacks,
    negativeFeedbackCount: metric.negativeFeedbacks,
    repeatImpressionCount
  };
}

function finalizeSqlFeedbackRows(rows) {
  return rows.map((row) => ({
    key: String(row.key || 'unset'),
    count: toNumber(row.count)
  }));
}

function buildReportAnalyticsFromSqlRows({
  range,
  metricsRow,
  dailyMetricsRow,
  repeatRow,
  trends,
  dimensions,
  top
}) {
  const eventCount = toNumber(metricsRow && metricsRow.eventCount);
  const dailyEventCount = toNumber(dailyMetricsRow && dailyMetricsRow.eventCount);
  const countRow = dailyMetricsRow && dailyEventCount === eventCount
    ? dailyMetricsRow
    : metricsRow;
  const impressionCount = toNumber(countRow && countRow.impressionCount);
  const clickCount = toNumber(countRow && countRow.clickCount);
  const feedbackCount = toNumber(countRow && countRow.feedbackCount);
  const negativeFeedbackCount = toNumber(countRow && countRow.negativeFeedbackCount);
  const repeatImpressionCount = toNumber(repeatRow && repeatRow.repeatImpressionCount);
  const metrics = {
    batchCount: toNumber(metricsRow && metricsRow.batchCount),
    eventCount: toNumber(countRow && countRow.eventCount),
    sampleCount: toNumber(metricsRow && metricsRow.sampleCount),
    distinctSampleCount: toNumber(metricsRow && metricsRow.sampleCount),
    distinctUpCount: toNumber(metricsRow && metricsRow.distinctUpCount),
    impressionCount,
    clickCount,
    feedbackCount,
    negativeFeedbackCount,
    ctr: ratio(clickCount, impressionCount),
    feedbackRate: ratio(feedbackCount, impressionCount),
    negativeFeedbackRate: ratio(negativeFeedbackCount, impressionCount),
    repeatSampleCount: toNumber(repeatRow && repeatRow.repeatSampleCount),
    repeatImpressionCount,
    repeatImpressionRate: ratio(repeatImpressionCount, impressionCount)
  };
  const normalizedDimensions = {
    modes: (dimensions.modes || []).map(finalizeSqlMetricRow),
    sources: (dimensions.sources || []).map(finalizeSqlMetricRow),
    categories: (dimensions.categories || []).map(finalizeSqlMetricRow),
    positions: (dimensions.positions || []).map(finalizeSqlMetricRow),
    feedback: finalizeSqlFeedbackRows(dimensions.feedback || [])
  };
  const normalizedTop = {
    ups: (top.ups || []).map(finalizeSqlTopUpRow),
    samples: (top.samples || []).map(finalizeSqlTopSampleRow),
    repeatedSamples: (top.repeatedSamples || []).map(finalizeSqlTopSampleRow)
  };

  return {
    range: {
      days: range.days,
      sinceIso: range.sinceIso,
      tzOffsetMinutes: range.tzOffsetMinutes,
      filters: range.filters
    },
    metrics,
    trends: (trends || []).map(finalizeSqlTrendRow),
    dimensions: normalizedDimensions,
    top: normalizedTop,
    topUps: normalizedTop.ups,
    categories: normalizedDimensions.categories,
    modes: normalizedDimensions.modes,
    sources: normalizedDimensions.sources,
    feedback: normalizedDimensions.feedback
  };
}

function createMetricBucket(key) {
  return {
    key,
    impressions: 0,
    clicks: 0,
    feedbacks: 0,
    negativeFeedbacks: 0,
    positionSum: 0,
    positionCount: 0,
    sampleIds: new Set()
  };
}

function addEventToBucket(bucket, event) {
  const sampleId = event.sampleId || getSampleId(event);
  if (sampleId) bucket.sampleIds.add(sampleId);
  if (event.eventKind === 'click') {
    bucket.clicks += 1;
    return;
  }
  if (event.eventKind === 'feedback') {
    bucket.feedbacks += 1;
    if (isNegativeFeedback(event)) bucket.negativeFeedbacks += 1;
    return;
  }

  bucket.impressions += 1;
  if (event.position > 0) {
    bucket.positionSum += event.position;
    bucket.positionCount += 1;
  }
}

function finalizeMetricBucket(bucket) {
  return {
    key: bucket.key,
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    feedbacks: bucket.feedbacks,
    negativeFeedbacks: bucket.negativeFeedbacks,
    sampleCount: bucket.sampleIds.size,
    ctr: ratio(bucket.clicks, bucket.impressions),
    feedbackRate: ratio(bucket.feedbacks, bucket.impressions),
    negativeFeedbackRate: ratio(bucket.negativeFeedbacks, bucket.impressions),
    avgPosition: ratio(bucket.positionSum, bucket.positionCount),
    count: bucket.impressions
  };
}

function sortMetricRows(rows) {
  return rows.sort((a, b) =>
    b.impressions - a.impressions ||
    b.clicks - a.clicks ||
    String(a.key).localeCompare(String(b.key))
  );
}

function buildDimension(events, getKey, limit = 20) {
  const buckets = new Map();
  for (const event of events) {
    const key = getKey(event) || 'unknown';
    if (!buckets.has(key)) buckets.set(key, createMetricBucket(key));
    addEventToBucket(buckets.get(key), event);
  }
  return sortMetricRows([...buckets.values()].map(finalizeMetricBucket)).slice(0, limit);
}

function getPositionBucket(position) {
  const value = Number(position || 0);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  if (value === 1) return '1';
  if (value <= 3) return '2-3';
  if (value <= 6) return '4-6';
  if (value <= 10) return '7-10';
  return '11+';
}

function buildTopUps(events) {
  const byUp = new Map();
  for (const event of events) {
    const key = event.upMid || event.upName || 'unknown';
    if (!byUp.has(key)) {
      const bucket = createMetricBucket(key);
      bucket.upName = event.upName || key;
      byUp.set(key, bucket);
    }
    addEventToBucket(byUp.get(key), event);
  }

  return sortMetricRows([...byUp.values()].map((bucket) => {
    const row = finalizeMetricBucket(bucket);
    return {
      ...row,
      upName: bucket.upName,
      seenCount: row.impressions,
      clickCount: row.clicks,
      feedbackCount: row.feedbacks,
      negativeFeedbackCount: row.negativeFeedbacks
    };
  }))
    .slice(0, 20);
}

function fillSampleDetails(bucket, event) {
  bucket.bvid = bucket.bvid || event.bvid || '';
  bucket.title = bucket.title || event.title || '';
  bucket.upName = bucket.upName || event.upName || '';
  bucket.upMid = bucket.upMid || event.upMid || '';
  bucket.category = bucket.category || event.category || '';
}

function buildSampleRows(events) {
  const bySample = new Map();
  for (const event of events) {
    const key = event.sampleId || getSampleId(event);
    if (!key) continue;
    if (!bySample.has(key)) {
      const bucket = createMetricBucket(key);
      bucket.sampleId = key;
      bucket.bvid = '';
      bucket.title = '';
      bucket.upName = '';
      bucket.upMid = '';
      bucket.category = '';
      bySample.set(key, bucket);
    }
    const bucket = bySample.get(key);
    fillSampleDetails(bucket, event);
    addEventToBucket(bucket, event);
  }

  return sortMetricRows([...bySample.values()].map((bucket) => {
    const row = finalizeMetricBucket(bucket);
    return {
      ...row,
      sampleId: bucket.sampleId,
      bvid: bucket.bvid,
      title: bucket.title,
      upName: bucket.upName,
      upMid: bucket.upMid,
      category: bucket.category,
      seenCount: row.impressions,
      clickCount: row.clicks,
      feedbackCount: row.feedbacks,
      negativeFeedbackCount: row.negativeFeedbacks,
      repeatImpressionCount: Math.max(0, row.impressions - 1)
    };
  }));
}

function buildTopSamples(events, limit = 20) {
  return buildSampleRows(events).slice(0, limit);
}

function buildRepeatedSamples(events) {
  return buildSampleRows(events)
    .filter((row) => row.repeatImpressionCount > 0)
    .sort((a, b) =>
      b.repeatImpressionCount - a.repeatImpressionCount ||
      b.impressions - a.impressions ||
      String(a.sampleId).localeCompare(String(b.sampleId))
    )
    .slice(0, 20);
}

function buildTrends(events, tzOffsetMinutes) {
  const trendsByDate = new Map();
  for (const event of events) {
    const date = getLocalDateKey(event.capturedAt || event.receivedAt, tzOffsetMinutes);
    if (!date) continue;
    if (!trendsByDate.has(date)) {
      trendsByDate.set(date, { date, impressions: 0, clicks: 0, feedbacks: 0, negativeFeedbacks: 0 });
    }
    const row = trendsByDate.get(date);
    if (event.eventKind === 'click') row.clicks += 1;
    else if (event.eventKind === 'feedback') {
      row.feedbacks += 1;
      if (isNegativeFeedback(event)) row.negativeFeedbacks += 1;
    }
    else row.impressions += 1;
  }
  return [...trendsByDate.values()]
    .map((row) => ({
      ...row,
      ctr: ratio(row.clicks, row.impressions),
      feedbackRate: ratio(row.feedbacks, row.impressions),
      negativeFeedbackRate: ratio(row.negativeFeedbacks, row.impressions)
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildRepeatMetrics(impressionEvents) {
  const bySample = new Map();
  for (const event of impressionEvents) {
    const sampleId = event.sampleId || getSampleId(event);
    if (!sampleId) continue;
    bySample.set(sampleId, (bySample.get(sampleId) || 0) + 1);
  }
  const repeatedCounts = [...bySample.values()].filter((count) => count > 1);
  const repeatImpressionCount = repeatedCounts.reduce((sum, count) => sum + count - 1, 0);
  return {
    repeatSampleCount: repeatedCounts.length,
    repeatImpressionCount,
    repeatImpressionRate: ratio(repeatImpressionCount, impressionEvents.length)
  };
}

function buildReportAnalytics({ events, range }) {
  const normalizedEvents = events.map(normalizeStoredEvent);
  const impressionEvents = normalizedEvents.filter((event) => event.eventKind === 'impression');
  const clickEvents = normalizedEvents.filter((event) => event.eventKind === 'click');
  const feedbackEvents = normalizedEvents.filter((event) => event.eventKind === 'feedback');
  const sampleIds = new Set(normalizedEvents.map((event) => event.sampleId || getSampleId(event)).filter(Boolean));
  const upIds = new Set(normalizedEvents.map((event) => event.upMid || event.upName).filter(Boolean));
  const batchIds = new Set(normalizedEvents.map((event) => event.batchId).filter(Boolean));
  const negativeFeedbackCount = feedbackEvents.filter(isNegativeFeedback).length;
  const repeatMetrics = buildRepeatMetrics(impressionEvents);
  const metrics = {
    batchCount: batchIds.size,
    eventCount: normalizedEvents.length,
    sampleCount: sampleIds.size,
    distinctSampleCount: sampleIds.size,
    distinctUpCount: upIds.size,
    impressionCount: impressionEvents.length,
    clickCount: clickEvents.length,
    feedbackCount: feedbackEvents.length,
    negativeFeedbackCount,
    ctr: ratio(clickEvents.length, impressionEvents.length),
    feedbackRate: ratio(feedbackEvents.length, impressionEvents.length),
    negativeFeedbackRate: ratio(negativeFeedbackCount, impressionEvents.length),
    ...repeatMetrics
  };
  const dimensions = {
    modes: buildDimension(normalizedEvents, (event) => event.mode),
    sources: buildDimension(normalizedEvents, (event) => event.source),
    categories: buildDimension(normalizedEvents, (event) => event.category),
    positions: buildDimension(normalizedEvents, (event) => getPositionBucket(event.position)),
    feedback: countBy(feedbackEvents, (event) => event.feedback || 'unset')
  };
  const top = {
    ups: buildTopUps(normalizedEvents),
    samples: buildTopSamples(normalizedEvents),
    repeatedSamples: buildRepeatedSamples(normalizedEvents)
  };

  return {
    range: {
      days: range.days,
      sinceIso: range.sinceIso,
      tzOffsetMinutes: range.tzOffsetMinutes,
      filters: range.filters
    },
    metrics,
    trends: buildTrends(normalizedEvents, range.tzOffsetMinutes),
    dimensions,
    top,
    topUps: top.ups,
    categories: dimensions.categories,
    modes: dimensions.modes,
    sources: dimensions.sources,
    feedback: dimensions.feedback
  };
}

export {
  TOP_ANALYTICS_LIMIT,
  addDailyMetricEvent,
  buildReportAnalyticsFromSqlRows,
  buildReportAnalytics,
  eventMatchesReportEventOptions,
  eventMatchesAnalyticsOptions,
  filterReportAnalyticsSection,
  filterSamples,
  getAnalyticsEventWhere,
  getDailyMetricDelta,
  getReportEventWhere,
  getSampleOrderBy,
  getSampleWhere,
  normalizeAnalyticsOptions,
  normalizeAnalyticsSection,
  normalizeEventListOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent,
  sortSamples
};
