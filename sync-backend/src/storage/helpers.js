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
  return {
    days,
    tzOffsetMinutes,
    sinceMs,
    sinceIso: new Date(sinceMs).toISOString()
  };
}

function buildTopUps(samples) {
  const byUp = new Map();
  for (const sample of samples) {
    const key = sample.upMid || sample.upName || 'unknown';
    if (!byUp.has(key)) {
      byUp.set(key, {
        key,
        upName: sample.upName || key,
        seenCount: 0,
        clickCount: 0,
        sampleCount: 0
      });
    }
    const stat = byUp.get(key);
    stat.seenCount += Number(sample.seenCount || 0);
    stat.clickCount += Number(sample.clickCount || 0);
    stat.sampleCount += 1;
  }

  return [...byUp.values()]
    .sort((a, b) => b.seenCount - a.seenCount)
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

function buildReportAnalytics({ samples, events, metrics, tzOffsetMinutes }) {
  const impressionEvents = events.filter((event) => event.eventKind !== 'click' && event.eventKind !== 'feedback');
  return {
    metrics: {
      batchCount: metrics.batchCount,
      eventCount: metrics.eventCount,
      sampleCount: samples.length,
      impressionCount: samples.reduce((sum, sample) => sum + Number(sample.seenCount || 0), 0),
      clickCount: samples.reduce((sum, sample) => sum + Number(sample.clickCount || 0), 0),
      feedbackCount: samples.filter((sample) => sample.feedback && sample.feedback !== 'unset').length
    },
    trends: buildTrends(events, tzOffsetMinutes),
    topUps: buildTopUps(samples),
    categories: countBy(samples, (sample) => sample.category).slice(0, 20),
    modes: countBy(impressionEvents, (event) => event.mode).slice(0, 20),
    sources: countBy(impressionEvents, (event) => event.source).slice(0, 20),
    feedback: countBy(samples, (sample) => sample.feedback || 'unset')
  };
}

export {
  buildReportAnalytics,
  filterSamples,
  getSampleOrderBy,
  getSampleWhere,
  normalizeAnalyticsOptions,
  normalizeLimit,
  normalizeOffset,
  normalizeSampleListOptions,
  sortSamples
};
