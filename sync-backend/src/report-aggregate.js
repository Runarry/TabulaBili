function getDateTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function minIsoDate(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return getDateTime(left) <= getDateTime(right) ? left : right;
}

function maxIsoDate(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return getDateTime(left) >= getDateTime(right) ? left : right;
}

function getSampleId(event) {
  return String(event && (event.id || event.bvid || event.aid || event.uri || event.eventId) || '').trim();
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function normalizeCountMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function mergeAggregate(existingValue, event) {
  const existing = existingValue && typeof existingValue === 'object' ? existingValue : null;
  const capturedAt = event.capturedAt || new Date().toISOString();
  const modes = normalizeCountMap(existing && existing.modes);
  const sources = normalizeCountMap(existing && existing.sources);
  increment(modes, event.mode || 'unknown');
  increment(sources, event.source || 'unknown');

  const positions = Array.isArray(existing && existing.positions) ? existing.positions.slice(-29) : [];
  if (Number.isFinite(Number(event.position)) && Number(event.position) > 0) {
    positions.push(Number(event.position));
  }

  return {
    id: getSampleId(event),
    bvid: event.bvid || (existing && existing.bvid) || '',
    aid: event.aid || (existing && existing.aid) || '',
    uri: event.uri || (existing && existing.uri) || '',
    title: event.title || (existing && existing.title) || '',
    upName: event.upName || (existing && existing.upName) || '',
    upMid: event.upMid || (existing && existing.upMid) || '',
    category: event.category || (existing && existing.category) || '',
    duration: Number(event.duration || (existing && existing.duration) || 0),
    reason: event.reason || (existing && existing.reason) || '',
    stats: {
      view: Number((event.stats && event.stats.view) || (existing && existing.stats && existing.stats.view) || 0),
      like: Number((event.stats && event.stats.like) || (existing && existing.stats && existing.stats.like) || 0),
      danmaku: Number((event.stats && event.stats.danmaku) || (existing && existing.stats && existing.stats.danmaku) || 0)
    },
    feedback: event.feedback && event.feedback !== 'unset'
      ? event.feedback
      : ((existing && existing.feedback) || 'unset'),
    firstSeenAt: minIsoDate(existing && existing.firstSeenAt, capturedAt),
    lastSeenAt: maxIsoDate(existing && existing.lastSeenAt, capturedAt),
    seenCount: Number((existing && existing.seenCount) || 0) + 1,
    modes,
    sources,
    positions,
    updatedAt: new Date().toISOString()
  };
}

function normalizeReportPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const batchId = String(source.batchId || '').trim();
  const clientId = String(source.clientId || '').trim();
  const capturedAt = String(source.capturedAt || new Date().toISOString());
  const events = Array.isArray(source.events) ? source.events : [];

  return {
    batchId,
    clientId,
    capturedAt,
    url: String(source.url || ''),
    queuedAt: String(source.queuedAt || ''),
    events: events
      .filter((event) => event && typeof event === 'object' && String(event.eventId || '').trim())
      .map((event) => ({
        ...event,
        eventId: String(event.eventId).trim(),
        batchId,
        clientId,
        capturedAt: String(event.capturedAt || capturedAt)
      }))
  };
}

export {
  getSampleId,
  mergeAggregate,
  normalizeReportPayload
};
