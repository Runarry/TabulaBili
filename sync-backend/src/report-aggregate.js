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

function normalizeEventKind(value) {
  return value === 'click' || value === 'feedback' ? value : 'impression';
}

function normalizeText(value) {
  return String(value || '').trim();
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
  const eventKind = normalizeEventKind(event.eventKind);
  const modes = normalizeCountMap(existing && existing.modes);
  const sources = normalizeCountMap(existing && existing.sources);
  if (eventKind === 'impression') {
    increment(modes, event.mode || 'unknown');
    increment(sources, event.source || 'unknown');
  }

  const positions = Array.isArray(existing && existing.positions) ? existing.positions.slice(-29) : [];
  if (eventKind === 'impression' && Number.isFinite(Number(event.position)) && Number(event.position) > 0) {
    positions.push(Number(event.position));
  }
  const nextFeedback = eventKind === 'feedback' || (event.feedback && event.feedback !== 'unset')
    ? (event.feedback || 'unset')
    : ((existing && existing.feedback) || 'unset');
  const nextClickCount = Number((existing && existing.clickCount) || 0) + (eventKind === 'click' ? 1 : 0);

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
    feedback: nextFeedback,
    firstSeenAt: minIsoDate(existing && existing.firstSeenAt, capturedAt),
    lastSeenAt: eventKind === 'impression'
      ? maxIsoDate(existing && existing.lastSeenAt, capturedAt)
      : ((existing && existing.lastSeenAt) || capturedAt),
    seenCount: Number((existing && existing.seenCount) || 0) + (eventKind === 'impression' ? 1 : 0),
    clickCount: nextClickCount,
    lastClickedAt: eventKind === 'click' ? capturedAt : ((existing && existing.lastClickedAt) || ''),
    feedbackUpdatedAt: eventKind === 'feedback' ? capturedAt : ((existing && existing.feedbackUpdatedAt) || ''),
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
        eventKind: event.eventKind === 'click' || event.eventKind === 'feedback' ? event.eventKind : 'impression',
        batchId,
        clientId,
        capturedAt: String(event.capturedAt || capturedAt)
      }))
  };
}

function toSampleRow(sampleId, aggregate, fallbackSeenAt) {
  return {
    sampleId,
    bvid: aggregate.bvid || '',
    title: aggregate.title || '',
    upName: aggregate.upName || '',
    upMid: aggregate.upMid || '',
    category: aggregate.category || '',
    firstSeenAt: aggregate.firstSeenAt || aggregate.lastSeenAt || aggregate.updatedAt || fallbackSeenAt,
    lastSeenAt: aggregate.lastSeenAt || aggregate.updatedAt || fallbackSeenAt,
    seenCount: Number(aggregate.seenCount || 0),
    clickCount: Number(aggregate.clickCount || 0),
    feedback: aggregate.feedback || 'unset',
    lastClickedAt: aggregate.lastClickedAt || '',
    feedbackUpdatedAt: aggregate.feedbackUpdatedAt || '',
    json: JSON.stringify(aggregate)
  };
}

function toEventRow(event, batch, receivedAt, existingSample = null) {
  const sampleId = getSampleId(event);
  const eventKind = normalizeEventKind(event && event.eventKind);
  const position = Number(event && event.position);
  const fallback = existingSample && typeof existingSample === 'object' ? existingSample : {};

  return {
    eventId: normalizeText(event && event.eventId),
    batchId: normalizeText((event && event.batchId) || (batch && batch.batchId)),
    clientId: normalizeText((event && event.clientId) || (batch && batch.clientId)),
    sampleId,
    capturedAt: normalizeText((event && event.capturedAt) || (batch && batch.capturedAt) || receivedAt),
    receivedAt: normalizeText(receivedAt),
    eventKind,
    mode: normalizeText(event && event.mode),
    source: normalizeText(event && event.source),
    category: normalizeText((event && event.category) || fallback.category),
    feedback: normalizeText(event && event.feedback),
    position: Number.isFinite(position) && position > 0 ? position : 0,
    bvid: normalizeText((event && event.bvid) || fallback.bvid),
    upName: normalizeText((event && event.upName) || fallback.upName),
    upMid: normalizeText((event && event.upMid) || fallback.upMid),
    rawJson: JSON.stringify(event || {})
  };
}

export {
  getSampleId,
  mergeAggregate,
  normalizeEventKind,
  normalizeReportPayload,
  toEventRow,
  toSampleRow
};
