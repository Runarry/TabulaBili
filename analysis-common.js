globalThis.TabulaBiliAnalysis = (() => {
  const SAMPLES_KEY = 'bili_analysis_samples_v1';
  const SETTINGS_KEY = 'bili_analysis_settings_v1';
  const DEFAULT_SETTINGS = {
    retentionDays: 30,
    maxSamples: 5000,
    captureClicks: true
  };
  const FEEDBACK_VALUES = ['unset', 'like', 'dislike', 'neutral', 'blocked'];

  function normalizeSettings(value) {
    const retentionDays = Number.parseInt(value && value.retentionDays, 10);
    const maxSamples = Number.parseInt(value && value.maxSamples, 10);

    return {
      retentionDays: Number.isFinite(retentionDays)
        ? Math.min(365, Math.max(1, retentionDays))
        : DEFAULT_SETTINGS.retentionDays,
      maxSamples: Number.isFinite(maxSamples)
        ? Math.min(50000, Math.max(100, maxSamples))
        : DEFAULT_SETTINGS.maxSamples,
      captureClicks: !value || value.captureClicks !== false
    };
  }

  function normalizeSamples(value) {
    if (!Array.isArray(value)) return [];

    return value
      .filter((sample) => sample && typeof sample.id === 'string' && sample.id)
      .map((sample) => ({
        ...sample,
        seenCount: getPositiveInteger(sample.seenCount, 1),
        clickCount: getPositiveInteger(sample.clickCount, 0),
        modes: normalizeCountMap(sample.modes),
        sources: normalizeCountMap(sample.sources),
        positions: Array.isArray(sample.positions) ? sample.positions.slice(0, 30) : [],
        stats: normalizeStats(sample.stats),
        feedback: normalizeFeedback(sample.feedback),
        tags: Array.isArray(sample.tags) ? sample.tags.filter((tag) => typeof tag === 'string') : []
      }));
  }

  function normalizeIncomingSample(value) {
    if (!value || typeof value !== 'object') return null;

    const id = getTrimmedString(value.id);
    if (!id) return null;

    const capturedAt = normalizeIsoDate(value.capturedAt) || new Date().toISOString();
    return {
      id,
      capturedAt,
      dateKey: getTrimmedString(value.dateKey) || getLocalDateKey(capturedAt),
      mode: getTrimmedString(value.mode) || 'unknown',
      source: getTrimmedString(value.source) || 'unknown',
      position: getPositiveInteger(value.position, 0),
      bvid: getTrimmedString(value.bvid),
      aid: getTrimmedString(value.aid),
      uri: getTrimmedString(value.uri),
      title: getTrimmedString(value.title),
      upName: getTrimmedString(value.upName),
      upMid: getTrimmedString(value.upMid),
      category: getTrimmedString(value.category),
      duration: getPositiveInteger(value.duration, 0),
      reason: getTrimmedString(value.reason),
      stats: normalizeStats(value.stats),
      feedback: normalizeFeedback(value.feedback),
      tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string') : []
    };
  }

  function mergeSamples(existingSamples, incomingSamples, settings) {
    const byId = new Map();
    for (const sample of normalizeSamples(existingSamples)) {
      byId.set(sample.id, sample);
    }

    for (const rawSample of incomingSamples) {
      const sample = normalizeIncomingSample(rawSample);
      if (!sample) continue;

      const existing = byId.get(sample.id);
      if (!existing) {
        byId.set(sample.id, {
          ...sample,
          firstSeenAt: sample.capturedAt,
          lastSeenAt: sample.capturedAt,
          seenCount: 1,
          modes: sample.mode ? { [sample.mode]: 1 } : {},
          sources: sample.source ? { [sample.source]: 1 } : {},
          positions: sample.position ? [sample.position] : [],
          clickCount: 0,
          lastClickedAt: ''
        });
        continue;
      }

      existing.lastSeenAt = maxIsoDate(existing.lastSeenAt, sample.capturedAt);
      existing.firstSeenAt = minIsoDate(existing.firstSeenAt, sample.capturedAt);
      existing.seenCount = getPositiveInteger(existing.seenCount, 0) + 1;
      incrementCount(existing.modes, sample.mode);
      incrementCount(existing.sources, sample.source);
      if (sample.position) {
        existing.positions = [...(existing.positions || []), sample.position].slice(-30);
      }
      mergeSampleFields(existing, sample);
    }

    return trimSamples([...byId.values()], settings);
  }

  function mergeSampleFields(target, source) {
    for (const field of [
      'bvid',
      'aid',
      'uri',
      'title',
      'upName',
      'upMid',
      'category',
      'duration',
      'reason'
    ]) {
      if (source[field]) target[field] = source[field];
    }

    if (source.stats) {
      target.stats = {
        view: source.stats.view || (target.stats && target.stats.view) || 0,
        like: source.stats.like || (target.stats && target.stats.like) || 0,
        danmaku: source.stats.danmaku || (target.stats && target.stats.danmaku) || 0
      };
    }
  }

  function trimSamples(samples, settings) {
    const normalizedSettings = normalizeSettings(settings);
    const cutoff = Date.now() - normalizedSettings.retentionDays * 24 * 60 * 60 * 1000;
    return samples
      .filter((sample) => getDateTime(sample.lastSeenAt || sample.capturedAt) >= cutoff)
      .sort((a, b) => getDateTime(b.lastSeenAt || b.capturedAt) - getDateTime(a.lastSeenAt || a.capturedAt))
      .slice(0, normalizedSettings.maxSamples);
  }

  function normalizeStats(value) {
    return {
      view: getPositiveInteger(value && value.view, 0),
      like: getPositiveInteger(value && value.like, 0),
      danmaku: getPositiveInteger(value && value.danmaku, 0)
    };
  }

  function normalizeCountMap(value) {
    const output = {};
    if (!value || typeof value !== 'object') return output;

    for (const [key, count] of Object.entries(value)) {
      const normalizedKey = getTrimmedString(key);
      const normalizedCount = getPositiveInteger(count, 0);
      if (normalizedKey && normalizedCount > 0) output[normalizedKey] = normalizedCount;
    }

    return output;
  }

  function normalizeFeedback(value) {
    return FEEDBACK_VALUES.includes(value) ? value : 'unset';
  }

  function normalizeIsoDate(value) {
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function getTrimmedString(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  }

  function getPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function getDateTime(value) {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function getLocalDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function incrementCount(target, key) {
    if (!key) return;
    target[key] = (target[key] || 0) + 1;
  }

  function maxIsoDate(left, right) {
    return getDateTime(left) >= getDateTime(right) ? left : right;
  }

  function minIsoDate(left, right) {
    if (!left) return right;
    if (!right) return left;
    return getDateTime(left) <= getDateTime(right) ? left : right;
  }

  return {
    SAMPLES_KEY,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    getDateTime,
    getLocalDateKey,
    getPositiveInteger,
    mergeSamples,
    normalizeCountMap,
    normalizeFeedback,
    normalizeSamples,
    normalizeSettings,
    trimSamples
  };
})();
