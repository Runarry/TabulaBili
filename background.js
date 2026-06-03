if (typeof globalThis.TabulaBiliAnalysis === 'undefined' && typeof importScripts === 'function') {
  importScripts('analysis-common.js');
}

if (typeof globalThis.TabulaBiliSync === 'undefined' && typeof importScripts === 'function') {
  importScripts('sync-common.js');
}

const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';
const GLOBAL_FEED_RULE_ID = 100;
const FUSION_FEED_RULE_ID = 101;
const FUSION_BRANCH_PARAM = 'tabula_mix_branch';
const FUSION_BRANCH_VALUE = 'clean';
const analysisStore = globalThis.TabulaBiliAnalysis;
const syncStore = globalThis.TabulaBiliSync;
const CONFIG_SYNC_ALARM = 'tabulabili-config-sync';
const REPORT_SYNC_ALARM = 'tabulabili-report-sync';
const CONFIG_SYNC_DEBOUNCE_MS = 1200;
const REPORT_FLUSH_DEBOUNCE_MS = 1500;
const REPORT_BULK_BATCH_LIMIT = 50;
const REPORT_BULK_EVENT_LIMIT = 500;
const ANALYSIS_UPDATE_DEBOUNCE_MS = 1000;

let configSyncTimer = null;
let reportFlushTimer = null;
let reportFlushPromise = null;
let applyingRemoteConfigUntil = 0;
let reportQueueMigration = null;
let syncClientIdCache = '';
let syncConnectionCache = null;
let analysisSettingsCache = null;
let analysisMigrationDone = false;
let analysisMigration = null;
let modeCache = 'pure';
let fingerprintCache = '';
let sessionRulesSignature = '';
let disabledRulesetsSignature = '';
let pendingAnalysisUpdate = null;
let analysisUpdateTimer = null;

function getLastRuntimeError() {
  return extensionApi.runtime.lastError
    ? new Error(extensionApi.runtime.lastError.message)
    : null;
}

function storageGet(keys) {
  if (usePromiseApi) return extensionApi.storage.local.get(keys);

  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(keys, (result) => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function storageSet(values) {
  if (usePromiseApi) return extensionApi.storage.local.set(values);

  return new Promise((resolve, reject) => {
    extensionApi.storage.local.set(values, () => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function mergePendingAnalysisUpdate(extra) {
  const next = {
    ...(pendingAnalysisUpdate || {}),
    ...extra
  };
  if (pendingAnalysisUpdate && Number.isFinite(Number(pendingAnalysisUpdate.count)) && Number.isFinite(Number(extra.count))) {
    next.count = Number(pendingAnalysisUpdate.count) + Number(extra.count);
  }
  pendingAnalysisUpdate = next;
}

function flushAnalysisUpdated() {
  if (!pendingAnalysisUpdate) return Promise.resolve();
  const extra = pendingAnalysisUpdate;
  pendingAnalysisUpdate = null;
  return storageSet({
    [analysisStore.UPDATED_AT_KEY]: {
      at: new Date().toISOString(),
      ...extra
    }
  });
}

async function notifyAnalysisUpdated(extra = {}) {
  mergePendingAnalysisUpdate(extra);
  if (analysisUpdateTimer) return;

  analysisUpdateTimer = setTimeout(() => {
    analysisUpdateTimer = null;
    flushAnalysisUpdated().catch((error) => {
      console.warn('[TabulaBili] Failed to notify analysis update:', error);
    });
  }, ANALYSIS_UPDATE_DEBOUNCE_MS);
}

async function getAnalysisSettingsState() {
  if (analysisSettingsCache) return analysisSettingsCache;

  const result = await storageGet([
    'bili_analysis_enabled',
    analysisStore.SETTINGS_KEY
  ]);
  analysisSettingsCache = {
    enabled: result.bili_analysis_enabled === true,
    settings: analysisStore.normalizeSettings(result[analysisStore.SETTINGS_KEY])
  };
  return analysisSettingsCache;
}

async function ensureAnalysisMigrated() {
  if (analysisMigrationDone) {
    return { migrated: false };
  }
  if (analysisMigration) return analysisMigration;

  analysisMigration = (async () => {
    const result = await storageGet([
      analysisStore.INDEXEDDB_MIGRATED_KEY,
      analysisStore.SAMPLES_KEY,
      analysisStore.SETTINGS_KEY
    ]);
    if (result[analysisStore.INDEXEDDB_MIGRATED_KEY] === true) {
      analysisMigrationDone = true;
      return { migrated: false };
    }

    const legacySamples = analysisStore.normalizeSamples(result[analysisStore.SAMPLES_KEY]);
    const settings = analysisStore.normalizeSettings(result[analysisStore.SETTINGS_KEY]);
    if (legacySamples.length) {
      await analysisStore.replaceSamples(legacySamples, settings);
    }
    await storageSet({
      [analysisStore.INDEXEDDB_MIGRATED_KEY]: true,
      [analysisStore.SAMPLES_KEY]: []
    });
    analysisMigrationDone = true;
    await notifyAnalysisUpdated({ reason: 'migrated', count: legacySamples.length });
    return { migrated: true, count: legacySamples.length };
  })().catch((error) => {
    analysisMigration = null;
    throw error;
  });

  return analysisMigration;
}

function withReportKind(samples, eventKind) {
  const capturedAt = new Date().toISOString();
  return (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample && sample.id)
    .map((sample) => ({
      ...sample,
      eventKind,
      capturedAt: eventKind === 'impression' ? (sample.capturedAt || capturedAt) : capturedAt
    }));
}

async function captureAnalysisSamples(payload) {
  await ensureAnalysisMigrated();
  const state = await getAnalysisSettingsState();
  if (!state.enabled) return { skipped: true, reason: 'disabled' };

  const source = payload && typeof payload === 'object' ? payload : {};
  const samples = Array.isArray(source.samples) ? source.samples : [];
  const result = await analysisStore.captureSamples(samples, state.settings);
  await notifyAnalysisUpdated({ reason: 'capture', count: result.stored });
  const report = await queueReportPayload({
    ...source,
    samples: withReportKind(samples, 'impression')
  });
  return { ...result, report };
}

async function recordAnalysisClick(videoId) {
  await ensureAnalysisMigrated();
  const state = await getAnalysisSettingsState();
  if (!state.enabled) return { skipped: true, reason: 'disabled' };
  if (!state.settings.captureClicks) return { skipped: true, reason: 'clicks_disabled' };

  const sample = await analysisStore.recordClick(videoId);
  if (!sample) return { updated: false };
  await notifyAnalysisUpdated({ reason: 'click', sampleId: sample.id });
  const report = await queueReportPayload({
    capturedAt: new Date().toISOString(),
    samples: withReportKind([sample], 'click')
  });
  return { updated: true, sample, report };
}

async function updateAnalysisFeedback(sampleId, feedback) {
  await ensureAnalysisMigrated();
  const sample = await analysisStore.updateSampleFeedback(sampleId, feedback);
  if (!sample) return { updated: false };
  await notifyAnalysisUpdated({ reason: 'feedback', sampleId: sample.id });
  const report = await queueReportPayload({
    capturedAt: new Date().toISOString(),
    samples: withReportKind([sample], 'feedback')
  });
  return { updated: true, sample, report };
}

async function updateAnalysisUpFeedback(criteria, feedback) {
  await ensureAnalysisMigrated();
  const result = await analysisStore.updateUpFeedback(criteria, feedback);
  if (!result.updated) return result;
  await notifyAnalysisUpdated({ reason: 'up_feedback', count: result.updated });
  const report = await queueReportPayload({
    capturedAt: new Date().toISOString(),
    samples: withReportKind(result.samples, 'feedback')
  });
  return { ...result, report };
}

async function trimAnalysisSamples() {
  await ensureAnalysisMigrated();
  const state = await getAnalysisSettingsState();
  await analysisStore.trimStoredSamples(state.settings);
  await notifyAnalysisUpdated({ reason: 'trim' });
  return { trimmed: true };
}

async function clearAnalysisSamples() {
  await analysisStore.clearSamples();
  await storageSet({ [analysisStore.SAMPLES_KEY]: [] });
  await notifyAnalysisUpdated({ reason: 'clear' });
  return { cleared: true };
}

async function setSyncStatus(ok, message, extra = {}) {
  await storageSet({ [syncStore.LAST_STATUS_KEY]: syncStore.makeStatus(ok, message, extra) });
}

async function updateReportQueueStatus(queuedBatches = null) {
  const count = queuedBatches === null
    ? await syncStore.getReportQueueCount()
    : Math.max(0, Number(queuedBatches) || 0);
  await storageSet({
    [syncStore.REPORT_QUEUE_STATUS_KEY]: {
      queuedBatches: count,
      updatedAt: new Date().toISOString()
    }
  });
  return count;
}

async function ensureReportQueueMigrated() {
  if (!reportQueueMigration) {
    reportQueueMigration = (async () => {
      const result = await storageGet([syncStore.REPORT_QUEUE_KEY]);
      const legacyQueue = result[syncStore.REPORT_QUEUE_KEY];
      const migration = await syncStore.migrateLegacyReportQueue(legacyQueue);
      if (Array.isArray(legacyQueue) && legacyQueue.length) {
        await storageSet({ [syncStore.REPORT_QUEUE_KEY]: [] });
      }
      const queuedBatches = await updateReportQueueStatus(migration.queuedBatches);
      return { ...migration, queuedBatches };
    })().catch((error) => {
      reportQueueMigration = null;
      throw error;
    });
  }

  return reportQueueMigration;
}

async function ensureSyncClientId() {
  if (syncClientIdCache) return syncClientIdCache;

  const result = await storageGet([syncStore.CLIENT_ID_KEY]);
  const clientId = syncStore.getStableClientId(result[syncStore.CLIENT_ID_KEY]);
  if (clientId !== result[syncStore.CLIENT_ID_KEY]) {
    await storageSet({ [syncStore.CLIENT_ID_KEY]: clientId });
  }
  syncClientIdCache = clientId;
  return clientId;
}

async function getSyncConnection() {
  if (syncConnectionCache) return { ...syncConnectionCache };

  const result = await storageGet([
    syncStore.ENDPOINT_KEY,
    syncStore.SECRET_KEY,
    syncStore.ENABLED_KEY
  ]);
  syncConnectionCache = {
    endpoint: syncStore.normalizeEndpoint(result[syncStore.ENDPOINT_KEY]),
    secret: typeof result[syncStore.SECRET_KEY] === 'string' ? result[syncStore.SECRET_KEY] : '',
    enabled: result[syncStore.ENABLED_KEY] === true
  };
  return { ...syncConnectionCache };
}

async function syncFetch(path, options = {}, connection = null) {
  const activeConnection = connection || await getSyncConnection();
  if (!activeConnection.endpoint || !activeConnection.secret) {
    throw new Error('缺少后端 URL 或服务密钥');
  }

  const response = await fetch(`${activeConnection.endpoint}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${activeConnection.secret}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(text || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return response.json();
}

async function readConfigSyncValues() {
  const keys = [
    ...syncStore.CONFIG_FIELD_KEYS,
    'bili_block_rules',
    syncStore.CONFIG_ENVELOPE_KEY,
    syncStore.CLIENT_ID_KEY
  ];
  return storageGet(keys);
}

async function syncConfigNow(changedKeys = [...syncStore.CONFIG_FIELD_KEYS, 'bili_block_rules']) {
  const connection = await getSyncConnection();
  if (!connection.enabled) return { skipped: true };

  const clientId = await ensureSyncClientId();
  const values = await readConfigSyncValues();
  const localEnvelope = syncStore.buildConfigEnvelope(
    values,
    values[syncStore.CONFIG_ENVELOPE_KEY],
    clientId,
    changedKeys
  );

  const result = await syncFetch('/api/config/sync', {
    method: 'POST',
    body: JSON.stringify({ config: localEnvelope })
  }, connection);

  const remoteEnvelope = result.config || localEnvelope;
  const materialized = result.materialized || syncStore.materializeConfig(remoteEnvelope);
  applyingRemoteConfigUntil = Date.now() + 1500;
  const nextValues = { [syncStore.CONFIG_ENVELOPE_KEY]: remoteEnvelope };
  for (const key of syncStore.CONFIG_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(materialized, key)) nextValues[key] = materialized[key];
  }
  if (Array.isArray(materialized.bili_block_rules)) {
    nextValues.bili_block_rules = materialized.bili_block_rules;
  }
  await storageSet(nextValues);
  await setSyncStatus(true, '配置已同步');
  return { ok: true };
}

function queueConfigSync(changedKeys) {
  if (Date.now() < applyingRemoteConfigUntil) return;
  if (configSyncTimer) clearTimeout(configSyncTimer);
  configSyncTimer = setTimeout(() => {
    configSyncTimer = null;
    syncConfigNow(changedKeys).catch((error) => {
      console.warn('[TabulaBili] Failed to sync config:', error);
      setSyncStatus(false, `配置同步失败：${error.message}`).catch(() => null);
    });
  }, CONFIG_SYNC_DEBOUNCE_MS);
}

async function queueReportPayload(payload) {
  const connection = await getSyncConnection();
  if (!connection.enabled || !connection.endpoint || !connection.secret) {
    return { queued: false, skipped: true };
  }

  const clientId = await ensureSyncClientId();
  const batch = syncStore.buildReportBatch(payload, clientId);
  if (!batch.events.length) return { queued: false };

  await ensureReportQueueMigrated();
  await syncStore.enqueueReportBatch(batch);
  const trimResult = await syncStore.trimReportQueue(syncStore.MAX_REPORT_BATCHES);
  const queuedBatches = await updateReportQueueStatus(trimResult.queuedBatches);
  if (trimResult.trimmed) {
    await setSyncStatus(false, `上报队列过长，已丢弃 ${trimResult.trimmed} 个最旧批次`, { queuedBatches });
  }
  return { queued: true, eventCount: batch.events.length, queuedBatches };
}

function getReportBatchEventCount(batch) {
  return Array.isArray(batch && batch.events) ? batch.events.length : 0;
}

function isBulkReportUnavailable(error) {
  return error && (error.status === 404 || error.status === 405);
}

function shiftReportBatchGroup(queue) {
  const group = [];
  let eventCount = 0;

  while (queue.length && group.length < REPORT_BULK_BATCH_LIMIT) {
    const batch = queue[0];
    const batchEventCount = getReportBatchEventCount(batch);
    if (!group.length && batchEventCount > REPORT_BULK_EVENT_LIMIT) {
      group.push(queue.shift());
      break;
    }
    if (group.length && eventCount + batchEventCount > REPORT_BULK_EVENT_LIMIT) break;

    group.push(queue.shift());
    eventCount += batchEventCount;
  }

  return group;
}

async function postSingleReportBatch(batch, connection) {
  await syncFetch('/api/reports', {
    method: 'POST',
    body: JSON.stringify(batch)
  }, connection);
}

async function postBulkReportBatches(batches, connection) {
  await syncFetch('/api/reports/bulk', {
    method: 'POST',
    body: JSON.stringify({ batches })
  }, connection);
}

async function deleteReportBatches(batches) {
  await syncStore.deleteReportBatches(batches.map((batch) => batch.batchId));
}

function queueReportFlush() {
  if (reportFlushTimer) clearTimeout(reportFlushTimer);
  reportFlushTimer = setTimeout(() => {
    reportFlushTimer = null;
    flushReportQueue(false).catch((error) => {
      console.warn('[TabulaBili] Background report flush failed:', error);
    });
  }, REPORT_FLUSH_DEBOUNCE_MS);
}

async function flushReportQueue(force = false) {
  if (force && reportFlushTimer) {
    clearTimeout(reportFlushTimer);
    reportFlushTimer = null;
  }

  if (reportFlushPromise) {
    const currentPromise = reportFlushPromise;
    if (!force) return currentPromise;
    await currentPromise.catch(() => null);
    if (reportFlushPromise && reportFlushPromise !== currentPromise) return reportFlushPromise;
  }

  const nextPromise = flushReportQueueNow(force);
  const trackedPromise = nextPromise.finally(() => {
    if (reportFlushPromise === trackedPromise) {
      reportFlushPromise = null;
    }
  });
  reportFlushPromise = trackedPromise;
  return trackedPromise;
}

async function flushReportQueueNow(force = false) {
  await ensureReportQueueMigrated();
  const connection = await getSyncConnection();
  const queuedBatches = await updateReportQueueStatus();
  if (!connection.enabled) {
    if (force) await setSyncStatus(false, '同步与上报未启用');
    return { skipped: true, reason: 'disabled', queuedBatches };
  }

  const result = await storageGet([syncStore.RETRY_STATE_KEY]);

  if (!connection.endpoint || !connection.secret) {
    const message = '缺少后端 URL 或服务密钥';
    if (force || queuedBatches) await setSyncStatus(false, message, { queuedBatches });
    throw new Error(message);
  }

  const retryState = result[syncStore.RETRY_STATE_KEY] || {};
  const queue = await syncStore.listReportBatches(syncStore.MAX_REPORT_BATCHES);
  if (!queue.length) {
    if (force) await setSyncStatus(true, '没有待上报数据', { queuedBatches: 0 });
    return { sent: 0, queuedBatches: 0 };
  }

  if (!force && retryState.nextRetryAt && new Date(retryState.nextRetryAt).getTime() > Date.now()) {
    await setSyncStatus(false, '上报等待重试', {
      queuedBatches,
      nextRetryAt: retryState.nextRetryAt
    });
    return {
      skipped: true,
      reason: 'retry_wait',
      queuedBatches,
      nextRetryAt: retryState.nextRetryAt
    };
  }

  let sent = 0;
  while (queue.length) {
    const group = shiftReportBatchGroup(queue);
    try {
      if (group.length === 1 && getReportBatchEventCount(group[0]) > REPORT_BULK_EVENT_LIMIT) {
        await postSingleReportBatch(group[0], connection);
      } else {
        try {
          await postBulkReportBatches(group, connection);
        } catch (error) {
          if (!isBulkReportUnavailable(error)) throw error;
          for (const batch of group) {
            await postSingleReportBatch(batch, connection);
            sent += 1;
            await deleteReportBatches([batch]);
            await updateReportQueueStatus();
            await storageSet({ [syncStore.RETRY_STATE_KEY]: {} });
          }
          continue;
        }
      }

      sent += group.length;
      await deleteReportBatches(group);
      const remaining = await updateReportQueueStatus();
      await storageSet({ [syncStore.RETRY_STATE_KEY]: {} });
      if (!remaining) break;
    } catch (error) {
      const attempts = Number(retryState.attempts || 0) + 1;
      const delayMinutes = Math.min(120, 2 ** Math.min(attempts, 6));
      await storageSet({
        [syncStore.RETRY_STATE_KEY]: {
          attempts,
          nextRetryAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
        }
      });
      const remaining = await updateReportQueueStatus();
      await setSyncStatus(false, `数据上报失败：${error.message}`, { queuedBatches: remaining });
      throw error;
    }
  }

  const remaining = await updateReportQueueStatus();
  if (sent) await setSyncStatus(true, `已上报 ${sent} 个批次`, { queuedBatches: remaining });
  return { sent, queuedBatches: remaining };
}

async function scheduleSyncAlarms() {
  if (!extensionApi.alarms) return;
  const result = await storageGet([syncStore.REPORT_FREQUENCY_KEY]);
  const frequency = syncStore.normalizeFrequency(result[syncStore.REPORT_FREQUENCY_KEY]);
  extensionApi.alarms.create(CONFIG_SYNC_ALARM, { periodInMinutes: 60 });
  extensionApi.alarms.create(REPORT_SYNC_ALARM, { periodInMinutes: frequency });
}

async function initializeSyncBackground() {
  await ensureSyncClientId();
  await ensureAnalysisMigrated();
  await scheduleSyncAlarms();
  syncConfigNow().catch((error) => {
    console.warn('[TabulaBili] Failed to initialize config sync:', error);
  });
  queueReportFlush();
}

function updateSessionRules(options) {
  if (usePromiseApi) {
    return extensionApi.declarativeNetRequest.updateSessionRules(options);
  }

  return new Promise((resolve, reject) => {
    extensionApi.declarativeNetRequest.updateSessionRules(options, () => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function updateEnabledRulesets(options) {
  if (usePromiseApi) {
    return extensionApi.declarativeNetRequest.updateEnabledRulesets(options);
  }

  return new Promise((resolve, reject) => {
    extensionApi.declarativeNetRequest.updateEnabledRulesets(options, () => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function buildFeedRuleCondition(tabId = null, options = {}) {
  const condition = {
    urlFilter: options.fusionBranch
      ? `||api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd*${FUSION_BRANCH_PARAM}=${FUSION_BRANCH_VALUE}`
      : '||api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
    resourceTypes: ['xmlhttprequest'],
    requestDomains: ['api.bilibili.com'],
    initiatorDomains: ['www.bilibili.com']
  };

  if (Number.isInteger(tabId)) {
    condition.tabIds = [tabId];
  }

  return condition;
}

function buildCleanRequestHeaders(mode) {
  return mode === 'pure' || !fingerprintCache
    ? [{ header: 'cookie', operation: 'remove' }]
    : [{ header: 'cookie', operation: 'set', value: fingerprintCache }];
}

function getHeaderSignature(mode) {
  return mode === 'pure' || !fingerprintCache
    ? 'remove-cookie'
    : `set-cookie:${fingerprintCache}`;
}

async function applySessionRules(signature, options) {
  if (sessionRulesSignature === signature) return;
  await updateSessionRules(options);
  sessionRulesSignature = signature;
}

async function disableStaticRuleset() {
  const signature = 'rules-disabled';
  if (disabledRulesetsSignature === signature) return;
  await updateEnabledRulesets({ disableRulesetIds: ['rules'] });
  disabledRulesetsSignature = signature;
}

async function compileDynamicNetworkRules(mode, tabId = null) {
  const ruleIdsToRemove = [GLOBAL_FEED_RULE_ID];

  if (mode === 'origin') {
    await applySessionRules('origin:none', { removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
    return;
  }

  const requestHeaders = buildCleanRequestHeaders(mode);
  const tabSignature = Number.isInteger(tabId) ? String(tabId) : '*';
  const signature = `dynamic:${mode}:${tabSignature}:${getHeaderSignature(mode)}`;

  await applySessionRules(signature, {
    removeRuleIds: [...ruleIdsToRemove, FUSION_FEED_RULE_ID],
    addRules: [
      {
        id: GLOBAL_FEED_RULE_ID,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders
        },
        condition: buildFeedRuleCondition(tabId)
      }
    ]
  });
}

async function compileFusionNetworkRule() {
  const requestHeaders = buildCleanRequestHeaders('fusion');
  const signature = `fusion:${getHeaderSignature('fusion')}`;

  await applySessionRules(signature, {
    removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID],
    addRules: [
      {
        id: FUSION_FEED_RULE_ID,
        priority: 3,
        action: {
          type: 'modifyHeaders',
          requestHeaders
        },
        condition: buildFeedRuleCondition(null, { fusionBranch: true })
      }
    ]
  });
}

async function syncGlobalModeConfiguration(mode) {
  await disableStaticRuleset();

  if (mode === 'pure' || mode === 'refresh') {
    await compileDynamicNetworkRules(mode);
    return;
  }

  if (mode === 'fusion') {
    await compileFusionNetworkRule();
    return;
  }

  await applySessionRules('none', { removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
}

async function syncStoredModeConfiguration() {
  const { bili_mode: storedMode, bili_fingerprint: fingerprint = '' } = await storageGet(['bili_mode', 'bili_fingerprint']);
  const mode = storedMode || 'pure';
  modeCache = mode;
  fingerprintCache = typeof fingerprint === 'string' ? fingerprint : '';

  if (!storedMode) {
    await storageSet({ bili_mode: mode });
  }

  await syncGlobalModeConfiguration(mode);
}

function updateCachedStateFromChanges(changes) {
  if (changes.bili_mode) {
    modeCache = changes.bili_mode.newValue || 'pure';
  }
  if (changes.bili_fingerprint) {
    fingerprintCache = typeof changes.bili_fingerprint.newValue === 'string'
      ? changes.bili_fingerprint.newValue
      : '';
  }
  if (
    changes[syncStore.ENDPOINT_KEY]
    || changes[syncStore.SECRET_KEY]
    || changes[syncStore.ENABLED_KEY]
  ) {
    syncConnectionCache = null;
  }
  if (changes[syncStore.CLIENT_ID_KEY]) {
    syncClientIdCache = '';
  }
  if (changes.bili_analysis_enabled || changes[analysisStore.SETTINGS_KEY]) {
    analysisSettingsCache = null;
  }
  if (changes[analysisStore.INDEXEDDB_MIGRATED_KEY]) {
    analysisMigrationDone = changes[analysisStore.INDEXEDDB_MIGRATED_KEY].newValue === true;
  }
}

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || (!changes.bili_mode && !changes.bili_fingerprint)) return;
  updateCachedStateFromChanges(changes);

  syncStoredModeConfiguration().catch((error) => {
    console.warn('[TabulaBili] Failed to sync mode:', error);
  });
});

extensionApi.runtime.onInstalled.addListener(() => {
  syncStoredModeConfiguration().catch((error) => {
    console.warn('[TabulaBili] Failed to initialize mode:', error);
  });
  initializeSyncBackground().catch((error) => {
    console.warn('[TabulaBili] Failed to initialize sync:', error);
  });
});

extensionApi.runtime.onStartup.addListener(() => {
  syncStoredModeConfiguration().catch((error) => {
    console.warn('[TabulaBili] Failed to restore mode:', error);
  });
  initializeSyncBackground().catch((error) => {
    console.warn('[TabulaBili] Failed to restore sync:', error);
  });
});

if (extensionApi.alarms && extensionApi.alarms.onAlarm) {
  extensionApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CONFIG_SYNC_ALARM) {
      syncConfigNow().catch((error) => {
        console.warn('[TabulaBili] Scheduled config sync failed:', error);
      });
    }
    if (alarm.name === REPORT_SYNC_ALARM) {
      queueReportFlush();
    }
  });
}

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  updateCachedStateFromChanges(changes);

  if (changes[syncStore.REPORT_FREQUENCY_KEY]) {
    scheduleSyncAlarms().catch((error) => {
      console.warn('[TabulaBili] Failed to reschedule sync alarms:', error);
    });
  }

  if (changes[analysisStore.SETTINGS_KEY]) {
    trimAnalysisSamples().catch((error) => {
      console.warn('[TabulaBili] Failed to trim analysis samples after settings change:', error);
    });
  }

  const changedConfigKeys = [
    ...syncStore.CONFIG_FIELD_KEYS,
    'bili_block_rules'
  ].filter((key) => changes[key]);
  if (changedConfigKeys.length) {
    queueConfigSync(changedConfigKeys);
  }
});

const tabRequestCounters = {};

async function evaluateMixedRequest(sender) {
  const mode = modeCache || 'pure';

  if (mode === 'pure') {
    await compileDynamicNetworkRules('pure');
    return { active: true };
  }

  if (mode === 'origin') {
    await applySessionRules('none', { removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
    return { active: false };
  }

  if (mode === 'mixed' && sender.tab && Number.isInteger(sender.tab.id)) {
    const tabId = sender.tab.id;
    tabRequestCounters[tabId] = (tabRequestCounters[tabId] || 0) + 1;

    const active = tabRequestCounters[tabId] % 2 !== 0;
    if (active) {
      await compileDynamicNetworkRules('mixed', tabId);
    } else {
      await applySessionRules(`mixed-origin:${tabId}`, { removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
    }

    return { active };
  }

  if (mode === 'fusion') {
    await compileFusionNetworkRule();
    return { active: true };
  }

  if (mode === 'refresh') {
    await compileDynamicNetworkRules('refresh');
    return { active: true };
  }

  return { active: false };
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.action === 'ensureAnalysisMigrated') {
    ensureAnalysisMigrated()
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to migrate analysis samples:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'captureAnalysisSamples') {
    captureAnalysisSamples(message.payload)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to capture analysis samples:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'recordAnalysisClick') {
    recordAnalysisClick(message.videoId)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to record analysis click:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'updateAnalysisFeedback') {
    updateAnalysisFeedback(message.sampleId, message.feedback)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to update analysis feedback:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'updateAnalysisUpFeedback') {
    updateAnalysisUpFeedback(message.criteria, message.feedback)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to update UP feedback:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'trimAnalysisSamples') {
    trimAnalysisSamples()
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to trim analysis samples:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'clearAnalysisSamples') {
    clearAnalysisSamples()
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Failed to clear analysis samples:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'syncBackendNow') {
    syncConfigNow()
      .then((result) => flushReportQueue(true).then(async (reportResult) => {
        if (result && result.ok === true && reportResult && !reportResult.skipped) {
          const sent = Number(reportResult.sent || 0);
          await setSyncStatus(
            true,
            sent ? `配置已同步，已上报 ${sent} 个批次` : '配置已同步，没有待上报数据',
            { queuedBatches: Number(reportResult.queuedBatches || 0) }
          );
        }
        return { ...result, report: reportResult };
      }))
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Manual sync failed:', error);
        setSyncStatus(false, `同步失败：${error.message}`).catch(() => null);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'reportBackendNow') {
    flushReportQueue(true)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => {
        console.warn('[TabulaBili] Manual report failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'queueReportSamples') {
    queueReportPayload(message.payload)
      .then((result) => {
        queueReportFlush();
        sendResponse({ success: true, result });
      })
      .catch((error) => {
        console.warn('[TabulaBili] Failed to queue report samples:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'checkSyncBackendAuth') {
    getSyncConnection()
      .then((connection) => syncFetch('/api/auth/check', { method: 'POST', body: '{}' }, connection))
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'syncModeConfiguration') {
    syncStoredModeConfiguration()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.warn('[TabulaBili] Failed to sync mode configuration:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  if (message.action !== 'evaluateMixedRequest') {
    return false;
  }

  evaluateMixedRequest(sender)
    .then(sendResponse)
    .catch((error) => {
      console.warn('[TabulaBili] Failed to prepare network state:', error);
      sendResponse({ active: false, error: error.message });
    });

  return true;
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  if (tabRequestCounters[tabId]) {
    delete tabRequestCounters[tabId];
  }
});

syncStoredModeConfiguration().catch((error) => {
  console.warn('[TabulaBili] Failed to start mode background:', error);
});

initializeSyncBackground().catch((error) => {
  console.warn('[TabulaBili] Failed to start sync background:', error);
});
