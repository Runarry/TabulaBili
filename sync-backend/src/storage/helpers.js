import { getSampleId, normalizeEventKind } from '../report-aggregate.js';

const ANALYTICS_FILTERS = [
  ['clientId', 'client_id'],
  ['mode', 'mode'],
  ['source', 'source'],
  ['category', 'category'],
  ['feedback', 'feedback']
];

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

function buildTopUps(events) {
  const byUp = new Map();
  for (const event of events) {
    const key = event.upMid || event.upName || 'unknown';
    if (!byUp.has(key)) {
      byUp.set(key, {
        key,
        upName: event.upName || key,
        seenCount: 0,
        clickCount: 0,
        feedbackCount: 0,
        sampleIds: new Set()
      });
    }
    const stat = byUp.get(key);
    const sampleId = event.sampleId || getSampleId(event);
    if (sampleId) stat.sampleIds.add(sampleId);
    if (event.eventKind === 'click') stat.clickCount += 1;
    else if (event.eventKind === 'feedback') stat.feedbackCount += 1;
    else stat.seenCount += 1;
  }

  return [...byUp.values()]
    .map((item) => ({
      key: item.key,
      upName: item.upName,
      seenCount: item.seenCount,
      clickCount: item.clickCount,
      feedbackCount: item.feedbackCount,
      sampleCount: item.sampleIds.size
    }))
    .sort((a, b) => b.seenCount - a.seenCount || b.clickCount - a.clickCount || String(a.upName).localeCompare(String(b.upName)))
    .slice(0, 20);
}

function buildTrends(events, tzOffsetMinutes) {
  const trendsByDate = new Map();
  for (const event of events) {
    const date = getLocalDateKey(event.capturedAt || event.receivedAt, tzOffsetMinutes);
    if (!date) continue;
    if (!trendsByDate.has(date)) trendsByDate.set(date, { date, impressions: 0, clicks: 0, feedbacks: 0 });
    const row = trendsByDate.get(date);
    if (event.eventKind === 'click') row.clicks += 1;
    else if (event.eventKind === 'feedback') row.feedbacks += 1;
    else row.impressions += 1;
  }
  return [...trendsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildReportAnalytics({ events, range }) {
  const normalizedEvents = events.map(normalizeStoredEvent);
  const impressionEvents = normalizedEvents.filter((event) => event.eventKind === 'impression');
  const clickEvents = normalizedEvents.filter((event) => event.eventKind === 'click');
  const feedbackEvents = normalizedEvents.filter((event) => event.eventKind === 'feedback');
  const sampleIds = new Set(normalizedEvents.map((event) => event.sampleId || getSampleId(event)).filter(Boolean));
  const batchIds = new Set(normalizedEvents.map((event) => event.batchId).filter(Boolean));

  return {
    range: {
      days: range.days,
      sinceIso: range.sinceIso,
      tzOffsetMinutes: range.tzOffsetMinutes,
      filters: range.filters
    },
    metrics: {
      batchCount: batchIds.size,
      eventCount: normalizedEvents.length,
      sampleCount: sampleIds.size,
      distinctSampleCount: sampleIds.size,
      impressionCount: impressionEvents.length,
      clickCount: clickEvents.length,
      feedbackCount: feedbackEvents.length
    },
    trends: buildTrends(normalizedEvents, range.tzOffsetMinutes),
    topUps: buildTopUps(normalizedEvents),
    categories: countBy(impressionEvents, (event) => event.category).slice(0, 20),
    modes: countBy(impressionEvents, (event) => event.mode).slice(0, 20),
    sources: countBy(impressionEvents, (event) => event.source).slice(0, 20),
    feedback: countBy(feedbackEvents, (event) => event.feedback || 'unset')
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
