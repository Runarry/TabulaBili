import { getSampleId, normalizeEventKind } from '../report-aggregate.js';

const ANALYTICS_FILTERS = [
  ['clientId', 'client_id'],
  ['mode', 'mode'],
  ['source', 'source'],
  ['category', 'category'],
  ['feedback', 'feedback']
];

const NEGATIVE_FEEDBACK = new Set(['dislike', 'blocked']);

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
  return {
    limit: normalizeLimit(options.limit, maxLimit),
    offset: normalizeOffset(options.offset),
    q: String(options.q || '').trim(),
    feedback: String(options.feedback || 'all'),
    sort: options.sort === 'seenCount' || options.sort === 'clickCount' ? options.sort : 'lastSeenAt'
  };
}

function getSearchText(item) {
  return [item.id, item.bvid, item.aid, item.title, item.upName, item.upMid, item.category]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

function filterSamples(samples, options) {
  const q = options.q.toLowerCase();
  return samples
    .filter((item) => !q || getSearchText(item).includes(q))
    .filter((item) => options.feedback === 'all' || !options.feedback || item.feedback === options.feedback);
}

function sortSamples(samples, sort) {
  return samples.sort((a, b) => {
    if (sort === 'seenCount') return Number(b.seenCount || 0) - Number(a.seenCount || 0);
    if (sort === 'clickCount') return Number(b.clickCount || 0) - Number(a.clickCount || 0);
    return String(b.lastSeenAt).localeCompare(String(a.lastSeenAt));
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
  return {
    whereSql: where.length ? `where ${where.join(' and ')}` : '',
    args
  };
}

function getSampleOrderBy(sort) {
  if (sort === 'seenCount') return 'seen_count desc, last_seen_at desc';
  if (sort === 'clickCount') return 'click_count desc, last_seen_at desc';
  return 'last_seen_at desc';
}

function normalizeFilter(value) {
  const text = String(value || '').trim();
  return text && text !== 'all' ? text : '';
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

function eventMatchesAnalyticsOptions(event, options) {
  const capturedMs = Date.parse(event.capturedAt || event.receivedAt || '');
  if (!Number.isFinite(capturedMs) || capturedMs < options.sinceMs) return false;

  return ANALYTICS_FILTERS.every(([key]) => !options[key] || String(event[key] || '') === options[key]);
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
  buildReportAnalytics,
  eventMatchesAnalyticsOptions,
  filterSamples,
  getAnalyticsEventWhere,
  getSampleOrderBy,
  getSampleWhere,
  normalizeAnalyticsOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  normalizeStoredEvent,
  sortSamples
};
