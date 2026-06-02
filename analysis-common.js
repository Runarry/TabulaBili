globalThis.TabulaBiliAnalysis = (() => {
  const SAMPLES_KEY = 'bili_analysis_samples_v1';
  const SETTINGS_KEY = 'bili_analysis_settings_v1';
  const INDEXEDDB_MIGRATED_KEY = 'bili_analysis_indexeddb_migrated_v1';
  const UPDATED_AT_KEY = 'bili_analysis_updated_at_v1';
  const DB_NAME = 'tabulabili-analysis';
  const DB_VERSION = 1;
  const SAMPLE_STORE = 'samples';
  const UP_STORE = 'upStats';
  const META_STORE = 'meta';
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

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
          const samples = db.createObjectStore(SAMPLE_STORE, { keyPath: 'id' });
          samples.createIndex('lastSeenAt', 'lastSeenAt');
          samples.createIndex('dateKey', 'dateKey');
          samples.createIndex('feedback', 'feedback');
          samples.createIndex('hasClick', 'hasClick');
          samples.createIndex('bvidLower', 'bvidLower');
          samples.createIndex('upNameLower', 'upNameLower');
          samples.createIndex('upKey', 'upKey');
          samples.createIndex('titleLower', 'titleLower');
        }
        if (!db.objectStoreNames.contains(UP_STORE)) {
          const upStats = db.createObjectStore(UP_STORE, { keyPath: 'key' });
          upStats.createIndex('seenCount', 'seenCount');
          upStats.createIndex('lastSeenAt', 'lastSeenAt');
          upStats.createIndex('searchText', 'searchText');
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      request.onsuccess = () => resolve(request.result);
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function normalizeLower(value) {
    return String(value || '').trim().toLowerCase();
  }

  function getSampleDateKey(sample) {
    return getLocalDateKey(sample.lastSeenAt || sample.capturedAt) || sample.dateKey || '';
  }

  function getUpKey(sample) {
    const upMid = getTrimmedString(sample && sample.upMid);
    const upName = getTrimmedString(sample && sample.upName);
    if (upMid) return `mid:${upMid}`;
    if (upName) return `name:${upName.toLowerCase()}`;
    return '';
  }

  function decorateSample(sample) {
    const titleLower = normalizeLower(sample.title);
    const upNameLower = normalizeLower(sample.upName);
    const bvidLower = normalizeLower(sample.bvid);
    const upKey = getUpKey(sample);
    return {
      ...sample,
      dateKey: getSampleDateKey(sample),
      feedback: normalizeFeedback(sample.feedback),
      seenCount: getPositiveInteger(sample.seenCount, 0),
      clickCount: getPositiveInteger(sample.clickCount, 0),
      hasClick: getPositiveInteger(sample.clickCount, 0) > 0 ? 1 : 0,
      modes: normalizeCountMap(sample.modes),
      sources: normalizeCountMap(sample.sources),
      positions: Array.isArray(sample.positions) ? sample.positions.slice(-30) : [],
      stats: normalizeStats(sample.stats),
      tags: Array.isArray(sample.tags) ? sample.tags.filter((tag) => typeof tag === 'string') : [],
      lastSeenAt: sample.lastSeenAt || sample.capturedAt || '',
      firstSeenAt: sample.firstSeenAt || sample.capturedAt || '',
      bvidLower,
      upNameLower,
      titleLower,
      upKey,
      searchText: `${sample.id || ''} ${sample.bvid || ''} ${sample.aid || ''} ${sample.title || ''} ${sample.upName || ''}`.toLowerCase()
    };
  }

  function mergeStoredSample(existingValue, rawValue) {
    const incoming = normalizeIncomingSample(rawValue);
    if (!incoming) return null;

    const existing = normalizeSamples(existingValue ? [existingValue] : [])[0];
    if (!existing) {
      return decorateSample({
        ...incoming,
        firstSeenAt: incoming.capturedAt,
        lastSeenAt: incoming.capturedAt,
        seenCount: 1,
        modes: incoming.mode ? { [incoming.mode]: 1 } : {},
        sources: incoming.source ? { [incoming.source]: 1 } : {},
        positions: incoming.position ? [incoming.position] : [],
        clickCount: 0,
        lastClickedAt: ''
      });
    }

    const next = {
      ...existing,
      lastSeenAt: maxIsoDate(existing.lastSeenAt, incoming.capturedAt),
      firstSeenAt: minIsoDate(existing.firstSeenAt, incoming.capturedAt),
      seenCount: getPositiveInteger(existing.seenCount, 0) + 1,
      modes: normalizeCountMap(existing.modes),
      sources: normalizeCountMap(existing.sources),
      positions: Array.isArray(existing.positions) ? existing.positions.slice(-29) : []
    };
    incrementCount(next.modes, incoming.mode);
    incrementCount(next.sources, incoming.source);
    if (incoming.position) next.positions.push(incoming.position);
    mergeSampleFields(next, incoming);
    return decorateSample(next);
  }

  function buildUpStat(samples, key) {
    const stat = {
      key,
      upName: '',
      upMid: '',
      seenCount: 0,
      sampleCount: 0,
      clickCount: 0,
      dislikeCount: 0,
      blockedCount: 0,
      lastSeenAt: '',
      searchText: ''
    };

    for (const sample of samples) {
      stat.upName = stat.upName || sample.upName || '(未知 UP)';
      stat.upMid = stat.upMid || sample.upMid || '';
      stat.seenCount += getPositiveInteger(sample.seenCount, 0);
      stat.sampleCount += 1;
      stat.clickCount += getPositiveInteger(sample.clickCount, 0);
      if (sample.feedback === 'dislike') stat.dislikeCount += 1;
      if (sample.feedback === 'blocked') stat.blockedCount += 1;
      if (getDateTime(sample.lastSeenAt) > getDateTime(stat.lastSeenAt)) {
        stat.lastSeenAt = sample.lastSeenAt;
      }
    }

    stat.searchText = `${stat.upName} ${stat.upMid}`.toLowerCase();
    return stat;
  }

  async function rebuildUpStatForKey(sampleStore, upStore, key) {
    if (!key) return;
    const index = sampleStore.index('upKey');
    const samples = await requestToPromise(index.getAll(IDBKeyRange.only(key)));
    if (!samples.length) {
      upStore.delete(key);
      return;
    }
    upStore.put(buildUpStat(samples, key));
  }

  async function trimStoredSamples(settings) {
    const normalizedSettings = normalizeSettings(settings);
    const cutoffIso = new Date(Date.now() - normalizedSettings.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    const changedUpKeys = new Set();
    const all = await requestToPromise(sampleStore.getAll());
    const kept = all
      .filter((sample) => getDateTime(sample.lastSeenAt || sample.capturedAt) >= getDateTime(cutoffIso))
      .sort((a, b) => getDateTime(b.lastSeenAt || b.capturedAt) - getDateTime(a.lastSeenAt || a.capturedAt))
      .slice(0, normalizedSettings.maxSamples);
    const keepIds = new Set(kept.map((sample) => sample.id));
    for (const sample of all) {
      if (!keepIds.has(sample.id)) {
        changedUpKeys.add(sample.upKey);
        sampleStore.delete(sample.id);
      }
    }
    for (const key of changedUpKeys) {
      await rebuildUpStatForKey(sampleStore, upStore, key);
    }
    await transactionDone(tx);
  }

  async function captureSamples(samples, settings) {
    const incomingSamples = Array.isArray(samples) ? samples : [];
    if (!incomingSamples.length) return { stored: 0 };
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    const changedUpKeys = new Set();
    let stored = 0;

    for (const rawSample of incomingSamples) {
      const id = getTrimmedString(rawSample && rawSample.id);
      if (!id) continue;
      const existing = await requestToPromise(sampleStore.get(id));
      const next = mergeStoredSample(existing, rawSample);
      if (!next) continue;
      if (existing) changedUpKeys.add(existing.upKey);
      changedUpKeys.add(next.upKey);
      sampleStore.put(next);
      stored += 1;
    }

    for (const key of changedUpKeys) {
      await rebuildUpStatForKey(sampleStore, upStore, key);
    }

    await transactionDone(tx);
    await trimStoredSamples(settings);
    return { stored };
  }

  async function replaceSamples(samples, settings) {
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE, META_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    sampleStore.clear();
    upStore.clear();
    tx.objectStore(META_STORE).put({ key: 'replacedAt', value: new Date().toISOString() });
    const normalized = trimSamples(normalizeSamples(samples), settings);
    const byUp = new Map();
    for (const sample of normalized) {
      const next = decorateSample(sample);
      sampleStore.put(next);
      if (next.upKey) {
        if (!byUp.has(next.upKey)) byUp.set(next.upKey, []);
        byUp.get(next.upKey).push(next);
      }
    }
    for (const [key, items] of byUp) {
      upStore.put(buildUpStat(items, key));
    }
    await transactionDone(tx);
  }

  async function getSummary() {
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE], 'readonly');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const todayKey = getLocalDateKey(new Date());
    const weekStart = getLocalDateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const total = await requestToPromise(sampleStore.count());
    const today = await requestToPromise(sampleStore.index('dateKey').count(IDBKeyRange.only(todayKey)));
    const week = await requestToPromise(sampleStore.index('dateKey').count(IDBKeyRange.lowerBound(weekStart)));
    const clicked = await requestToPromise(sampleStore.index('hasClick').count(IDBKeyRange.only(1)));
    const disliked = await requestToPromise(sampleStore.index('feedback').count(IDBKeyRange.only('dislike')));
    await transactionDone(tx);
    return { total, today, week, clicked, disliked };
  }

  function sortSamplesDesc(samples) {
    return samples.sort((a, b) => getDateTime(b.lastSeenAt || b.capturedAt) - getDateTime(a.lastSeenAt || a.capturedAt));
  }

  function matchesSampleQuery(sample, q) {
    if (!q) return true;
    return String(sample.searchText || '').includes(q);
  }

  function matchesFeedback(sample, feedback) {
    return !feedback || feedback === 'all' || sample.feedback === feedback;
  }

  async function listSamples(options = {}) {
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || options.limit || 25)));
    const page = Math.max(1, Number(options.page || 1));
    const offset = Math.max(0, Number.isFinite(Number(options.offset)) ? Number(options.offset) : (page - 1) * pageSize);
    const q = normalizeLower(options.q);
    const feedback = normalizeFeedbackFilter(options.feedback);
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE], 'readonly');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    let filtered;

    if (!q && feedback === 'all') {
      const total = await requestToPromise(sampleStore.count());
      const items = [];
      let skipped = 0;
      await new Promise((resolve, reject) => {
        const request = sampleStore.index('lastSeenAt').openCursor(null, 'prev');
        request.onerror = () => reject(request.error || new Error('Failed to read samples'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || items.length >= pageSize) {
            resolve();
            return;
          }
          if (skipped < offset) {
            skipped += 1;
            cursor.continue();
            return;
          }
          items.push(cursor.value);
          cursor.continue();
        };
      });
      await transactionDone(tx);
      return { items, total, page, pageSize };
    }

    filtered = await requestToPromise(sampleStore.getAll());
    filtered = sortSamplesDesc(filtered.filter((sample) => matchesSampleQuery(sample, q) && matchesFeedback(sample, feedback)));
    await transactionDone(tx);
    return {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize
    };
  }

  function normalizeFeedbackFilter(value) {
    const text = String(value || 'all');
    return text === 'all' || FEEDBACK_VALUES.includes(text) ? text : 'all';
  }

  async function listUpStats(options = {}) {
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || options.limit || 25)));
    const page = Math.max(1, Number(options.page || 1));
    const offset = Math.max(0, Number.isFinite(Number(options.offset)) ? Number(options.offset) : (page - 1) * pageSize);
    const q = normalizeLower(options.q);
    const db = await openDb();
    const tx = db.transaction([UP_STORE], 'readonly');
    const upStore = tx.objectStore(UP_STORE);
    const rows = await requestToPromise(upStore.getAll());
    const filtered = rows
      .filter((stat) => !q || String(stat.searchText || '').includes(q))
      .sort((a, b) => b.seenCount - a.seenCount || getDateTime(b.lastSeenAt) - getDateTime(a.lastSeenAt));
    await transactionDone(tx);
    return {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize
    };
  }

  async function getSampleByVideoId(videoId) {
    const id = getTrimmedString(videoId);
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE], 'readonly');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    let sample = await requestToPromise(sampleStore.get(id));
    if (!sample) {
      sample = await requestToPromise(sampleStore.index('bvidLower').get(id.toLowerCase()));
    }
    await transactionDone(tx);
    return sample || null;
  }

  async function recordClick(videoId) {
    const sample = await getSampleByVideoId(videoId);
    if (!sample) return null;
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    const current = await requestToPromise(sampleStore.get(sample.id));
    if (!current) {
      await transactionDone(tx);
      return null;
    }
    const next = decorateSample({
      ...current,
      clickCount: getPositiveInteger(current.clickCount, 0) + 1,
      lastClickedAt: new Date().toISOString()
    });
    sampleStore.put(next);
    await rebuildUpStatForKey(sampleStore, upStore, next.upKey);
    await transactionDone(tx);
    return next;
  }

  async function updateSampleFeedback(sampleId, feedback) {
    const id = getTrimmedString(sampleId);
    const normalizedFeedback = normalizeFeedback(feedback);
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    const current = await requestToPromise(sampleStore.get(id));
    if (!current) {
      await transactionDone(tx);
      return null;
    }
    const next = decorateSample({
      ...current,
      feedback: normalizedFeedback,
      feedbackUpdatedAt: new Date().toISOString()
    });
    sampleStore.put(next);
    await rebuildUpStatForKey(sampleStore, upStore, next.upKey);
    await transactionDone(tx);
    return next;
  }

  async function updateUpFeedback(criteria, feedback) {
    const normalizedFeedback = normalizeFeedback(feedback);
    const upMid = getTrimmedString(criteria && criteria.upMid);
    const upName = getTrimmedString(criteria && criteria.upName);
    if (!upMid && !upName) return { updated: 0, samples: [] };
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE], 'readwrite');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const upStore = tx.objectStore(UP_STORE);
    const all = await requestToPromise(sampleStore.getAll());
    const now = new Date().toISOString();
    const changedUpKeys = new Set();
    const samples = [];
    for (const sample of all) {
      const matched = upMid ? sample.upMid === upMid : sample.upName === upName;
      if (!matched) continue;
      const next = decorateSample({
        ...sample,
        feedback: normalizedFeedback,
        feedbackUpdatedAt: now
      });
      sampleStore.put(next);
      changedUpKeys.add(next.upKey);
      samples.push(next);
    }
    for (const key of changedUpKeys) {
      await rebuildUpStatForKey(sampleStore, upStore, key);
    }
    await transactionDone(tx);
    return { updated: samples.length, samples };
  }

  async function clearSamples() {
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE, UP_STORE, META_STORE], 'readwrite');
    tx.objectStore(SAMPLE_STORE).clear();
    tx.objectStore(UP_STORE).clear();
    tx.objectStore(META_STORE).put({ key: 'clearedAt', value: new Date().toISOString() });
    await transactionDone(tx);
  }

  async function exportSamples(options = {}) {
    const db = await openDb();
    const tx = db.transaction([SAMPLE_STORE], 'readonly');
    const sampleStore = tx.objectStore(SAMPLE_STORE);
    const q = normalizeLower(options.q);
    const feedback = normalizeFeedbackFilter(options.feedback);
    const all = await requestToPromise(sampleStore.getAll());
    await transactionDone(tx);
    return sortSamplesDesc(all.filter((sample) => matchesSampleQuery(sample, q) && matchesFeedback(sample, feedback)));
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
    INDEXEDDB_MIGRATED_KEY,
    UPDATED_AT_KEY,
    DEFAULT_SETTINGS,
    captureSamples,
    clearSamples,
    exportSamples,
    getDateTime,
    getLocalDateKey,
    getPositiveInteger,
    getSampleByVideoId,
    getSummary,
    listSamples,
    listUpStats,
    mergeSamples,
    normalizeCountMap,
    normalizeFeedback,
    normalizeSamples,
    normalizeSettings,
    recordClick,
    replaceSamples,
    trimStoredSamples,
    updateSampleFeedback,
    updateUpFeedback,
    trimSamples
  };
})();
