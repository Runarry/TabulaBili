globalThis.TabulaBiliSync = (() => {
  const ENDPOINT_KEY = 'tabulabili_sync_endpoint';
  const SECRET_KEY = 'tabulabili_sync_secret';
  const ENABLED_KEY = 'tabulabili_sync_enabled';
  const CLIENT_ID_KEY = 'tabulabili_sync_client_id';
  const CONFIG_ENVELOPE_KEY = 'tabulabili_sync_config_envelope_v1';
  const REPORT_QUEUE_KEY = 'tabulabili_report_queue_v1';
  const REPORT_QUEUE_STATUS_KEY = 'tabulabili_report_queue_status_v1';
  const REPORT_FREQUENCY_KEY = 'tabulabili_report_frequency_minutes';
  const LAST_STATUS_KEY = 'tabulabili_sync_last_status_v1';
  const RETRY_STATE_KEY = 'tabulabili_sync_retry_state_v1';
  const MAX_REPORT_BATCHES = 200;
  const DB_NAME = 'tabulabili-sync';
  const DB_VERSION = 1;
  const REPORT_QUEUE_STORE = 'reportQueue';

  const CONFIG_FIELD_KEYS = [
    'bili_mode',
    'bili_fusion_clean_ratio',
    'bili_blocker_enabled',
    'bili_analysis_enabled',
    'bili_analysis_settings_v1',
    REPORT_FREQUENCY_KEY
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeEndpoint(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.replace(/\/+$/, '');
  }

  function getStableClientId(value) {
    if (typeof value === 'string' && value) return value;
    const random = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `tabulabili-${random}`;
  }

  function normalizeFrequency(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 30;
    return Math.min(1440, Math.max(5, parsed));
  }

  function makeStatus(ok, message, extra = {}) {
    return {
      ok,
      message,
      at: nowIso(),
      ...extra
    };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error('Failed to open sync IndexedDB'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REPORT_QUEUE_STORE)) {
          const queue = db.createObjectStore(REPORT_QUEUE_STORE, { keyPath: 'batchId' });
          queue.createIndex('queuedAt', 'queuedAt');
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

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sameValue(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function normalizeRules(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((rule) => rule && (rule.type === 'up_name_exact' || rule.type === 'title_regex'))
      .map((rule) => ({
        id: typeof rule.id === 'string' && rule.id ? rule.id : hashString(`${rule.type}:${rule.pattern || ''}`),
        type: rule.type,
        pattern: typeof rule.pattern === 'string' ? rule.pattern.trim() : '',
        enabled: rule.enabled !== false,
        createdAt: typeof rule.createdAt === 'string' ? rule.createdAt : nowIso(),
        source: typeof rule.source === 'string' ? rule.source : ''
      }))
      .filter((rule) => rule.pattern);
  }

  function buildConfigEnvelope(values, previousEnvelope, clientId, changedKeys = CONFIG_FIELD_KEYS) {
    const previous = previousEnvelope && typeof previousEnvelope === 'object' ? previousEnvelope : {};
    const previousFields = previous.fields && typeof previous.fields === 'object' ? previous.fields : {};
    const changeSet = new Set(changedKeys || []);
    const timestamp = nowIso();
    const fields = {};

    for (const key of CONFIG_FIELD_KEYS) {
      const previousField = previousFields[key];
      const hasValue = Object.prototype.hasOwnProperty.call(values || {}, key);
      if (!hasValue && previousField) {
        fields[key] = previousField;
        continue;
      }
      if (!hasValue) continue;

      const value = key === REPORT_FREQUENCY_KEY ? normalizeFrequency(values[key]) : values[key];
      if (previousField && !changeSet.has(key) && sameValue(previousField.value, value)) {
        fields[key] = previousField;
      } else {
        fields[key] = { value, updatedAt: timestamp, clientId };
      }
    }

    const rulesChanged = changeSet.has('bili_block_rules') || !previous.rules;
    const previousItems = previous.rules && Array.isArray(previous.rules.items) ? previous.rules.items : [];
    const ruleItems = rulesChanged
      ? mergeRuleEnvelopeItems(previousItems, normalizeRules(values && values.bili_block_rules), clientId, timestamp)
      : previousItems;

    return {
      version: 1,
      clientId,
      updatedAt: timestamp,
      fields,
      rules: { items: ruleItems }
    };
  }

  function mergeRuleEnvelopeItems(previousItems, activeRules, clientId, timestamp) {
    const byId = new Map();
    for (const item of previousItems) {
      if (item && typeof item.id === 'string') byId.set(item.id, item);
    }

    const activeIds = new Set();
    for (const rule of activeRules) {
      activeIds.add(rule.id);
      const previous = byId.get(rule.id);
      if (previous && sameValue(stripRuleSyncFields(previous), rule) && !previous.deletedAt) {
        byId.set(rule.id, previous);
      } else {
        byId.set(rule.id, {
          ...rule,
          updatedAt: timestamp,
          clientId
        });
      }
    }

    for (const item of [...byId.values()]) {
      if (!item.deletedAt && !activeIds.has(item.id)) {
        byId.set(item.id, {
          ...item,
          deletedAt: timestamp,
          updatedAt: timestamp,
          clientId
        });
      }
    }

    return [...byId.values()];
  }

  function stripRuleSyncFields(rule) {
    return {
      id: rule.id,
      type: rule.type,
      pattern: rule.pattern,
      enabled: rule.enabled !== false,
      createdAt: rule.createdAt,
      source: rule.source || ''
    };
  }

  function materializeConfig(envelope) {
    const source = envelope && typeof envelope === 'object' ? envelope : {};
    const fields = source.fields && typeof source.fields === 'object' ? source.fields : {};
    const values = {};
    for (const key of CONFIG_FIELD_KEYS) {
      if (fields[key] && Object.prototype.hasOwnProperty.call(fields[key], 'value')) {
        values[key] = fields[key].value;
      }
    }
    values.bili_block_rules = source.rules && Array.isArray(source.rules.items)
      ? source.rules.items
        .filter((rule) => !rule.deletedAt)
        .map(stripRuleSyncFields)
      : [];
    return values;
  }

  function buildReportBatch(payload, clientId) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const samples = Array.isArray(source.samples) ? source.samples : [];
    const capturedAt = typeof source.capturedAt === 'string' ? source.capturedAt : nowIso();
    const url = typeof source.url === 'string' ? source.url : '';
    const seed = stableStringify({
      clientId,
      capturedAt,
      url,
      ids: samples.map((sample) => sample && sample.id)
    });
    const batchId = `${clientId}:${hashString(seed)}`;
    const events = samples
      .filter((sample) => sample && typeof sample === 'object' && sample.id)
      .map((sample) => {
        const eventSeed = stableStringify({
          clientId,
          capturedAt: sample.capturedAt || capturedAt,
          eventKind: sample.eventKind || 'impression',
          id: sample.id,
          mode: sample.mode,
          source: sample.source,
          position: sample.position,
          feedback: sample.feedback
        });
        return {
          ...sample,
          eventId: `${clientId}:${hashString(eventSeed)}`,
          batchId,
          clientId,
          capturedAt: sample.capturedAt || capturedAt
        };
      });

    return {
      batchId,
      clientId,
      capturedAt,
      url,
      queuedAt: nowIso(),
      events
    };
  }

  function normalizeReportBatch(batch, index = 0) {
    if (!batch || typeof batch !== 'object' || typeof batch.batchId !== 'string' || !batch.batchId) {
      return null;
    }
    if (!Array.isArray(batch.events) || !batch.events.length) return null;

    return {
      ...batch,
      queuedAt: typeof batch.queuedAt === 'string' && batch.queuedAt
        ? batch.queuedAt
        : new Date(Date.now() + index).toISOString()
    };
  }

  async function enqueueReportBatch(batch) {
    const normalized = normalizeReportBatch(batch);
    if (!normalized) return { queued: false };

    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readwrite');
    tx.objectStore(REPORT_QUEUE_STORE).put(normalized);
    await transactionDone(tx);
    return { queued: true, batchId: normalized.batchId };
  }

  function readQueuedBatches(store, limit = MAX_REPORT_BATCHES) {
    return new Promise((resolve, reject) => {
      const items = [];
      const request = store.index('queuedAt').openCursor();
      request.onerror = () => reject(request.error || new Error('Failed to read report queue'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || items.length >= limit) {
          resolve(items);
          return;
        }
        items.push(cursor.value);
        cursor.continue();
      };
    });
  }

  async function listReportBatches(limit = MAX_REPORT_BATCHES) {
    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readonly');
    const items = await readQueuedBatches(tx.objectStore(REPORT_QUEUE_STORE), limit);
    await transactionDone(tx);
    return items;
  }

  async function deleteReportBatch(batchId) {
    if (!batchId) return { deleted: false };
    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readwrite');
    tx.objectStore(REPORT_QUEUE_STORE).delete(batchId);
    await transactionDone(tx);
    return { deleted: true };
  }

  async function deleteReportBatches(batchIds) {
    const ids = (Array.isArray(batchIds) ? batchIds : [])
      .map((batchId) => String(batchId || ''))
      .filter(Boolean);
    if (!ids.length) return { deleted: 0 };

    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(REPORT_QUEUE_STORE);
    for (const batchId of ids) {
      store.delete(batchId);
    }
    await transactionDone(tx);
    return { deleted: ids.length };
  }

  function deleteOldestQueuedBatches(store, count) {
    if (count <= 0) return Promise.resolve(0);

    return new Promise((resolve, reject) => {
      let deleted = 0;
      const request = store.index('queuedAt').openCursor();
      request.onerror = () => reject(request.error || new Error('Failed to trim report queue'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleted >= count) {
          resolve(deleted);
          return;
        }

        const deleteRequest = cursor.delete();
        deleteRequest.onerror = () => reject(deleteRequest.error || new Error('Failed to delete queued report'));
        deleted += 1;
        cursor.continue();
      };
    });
  }

  async function trimReportQueue(maxBatches = MAX_REPORT_BATCHES) {
    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(REPORT_QUEUE_STORE);
    const total = await requestToPromise(store.count());
    const overflow = Math.max(0, total - maxBatches);
    const trimmed = await deleteOldestQueuedBatches(store, overflow);
    const remaining = total - trimmed;
    await transactionDone(tx);
    return { trimmed, queuedBatches: remaining };
  }

  async function getReportQueueCount() {
    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readonly');
    const count = await requestToPromise(tx.objectStore(REPORT_QUEUE_STORE).count());
    await transactionDone(tx);
    return count;
  }

  async function migrateLegacyReportQueue(legacyQueue) {
    if (!Array.isArray(legacyQueue) || !legacyQueue.length) {
      return { imported: 0, trimmed: 0, queuedBatches: await getReportQueueCount() };
    }

    const db = await openDb();
    const tx = db.transaction([REPORT_QUEUE_STORE], 'readwrite');
    const store = tx.objectStore(REPORT_QUEUE_STORE);
    let imported = 0;

    for (let index = 0; index < legacyQueue.length; index += 1) {
      const batch = normalizeReportBatch(legacyQueue[index], index);
      if (!batch) continue;
      store.put(batch);
      imported += 1;
    }

    await transactionDone(tx);
    const queuedBatches = await getReportQueueCount();
    return {
      imported,
      trimmed: 0,
      queuedBatches
    };
  }

  return {
    ENDPOINT_KEY,
    SECRET_KEY,
    ENABLED_KEY,
    CLIENT_ID_KEY,
    CONFIG_ENVELOPE_KEY,
    REPORT_QUEUE_KEY,
    REPORT_QUEUE_STATUS_KEY,
    REPORT_FREQUENCY_KEY,
    LAST_STATUS_KEY,
    RETRY_STATE_KEY,
    DB_NAME,
    REPORT_QUEUE_STORE,
    MAX_REPORT_BATCHES,
    CONFIG_FIELD_KEYS,
    buildConfigEnvelope,
    buildReportBatch,
    deleteReportBatch,
    deleteReportBatches,
    enqueueReportBatch,
    getReportQueueCount,
    getStableClientId,
    listReportBatches,
    makeStatus,
    materializeConfig,
    migrateLegacyReportQueue,
    normalizeEndpoint,
    normalizeFrequency,
    trimReportQueue
  };
})();
