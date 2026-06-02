if (typeof globalThis.TabulaBiliSync === 'undefined' && typeof importScripts === 'function') {
  importScripts('sync-common.js');
}

const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';
const GLOBAL_FEED_RULE_ID = 100;
const FUSION_FEED_RULE_ID = 101;
const FUSION_BRANCH_PARAM = 'tabula_mix_branch';
const FUSION_BRANCH_VALUE = 'clean';
const syncStore = globalThis.TabulaBiliSync;
const CONFIG_SYNC_ALARM = 'tabulabili-config-sync';
const REPORT_SYNC_ALARM = 'tabulabili-report-sync';
const CONFIG_SYNC_DEBOUNCE_MS = 1200;

let configSyncTimer = null;
let applyingRemoteConfigUntil = 0;

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

async function setSyncStatus(ok, message, extra = {}) {
  await storageSet({ [syncStore.LAST_STATUS_KEY]: syncStore.makeStatus(ok, message, extra) });
}

async function ensureSyncClientId() {
  const result = await storageGet([syncStore.CLIENT_ID_KEY]);
  const clientId = syncStore.getStableClientId(result[syncStore.CLIENT_ID_KEY]);
  if (clientId !== result[syncStore.CLIENT_ID_KEY]) {
    await storageSet({ [syncStore.CLIENT_ID_KEY]: clientId });
  }
  return clientId;
}

async function getSyncConnection() {
  const result = await storageGet([
    syncStore.ENDPOINT_KEY,
    syncStore.SECRET_KEY,
    syncStore.ENABLED_KEY
  ]);
  return {
    endpoint: syncStore.normalizeEndpoint(result[syncStore.ENDPOINT_KEY]),
    secret: typeof result[syncStore.SECRET_KEY] === 'string' ? result[syncStore.SECRET_KEY] : '',
    enabled: result[syncStore.ENABLED_KEY] === true
  };
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
    throw new Error(text || `HTTP ${response.status}`);
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

  const result = await storageGet([syncStore.REPORT_QUEUE_KEY]);
  const queue = Array.isArray(result[syncStore.REPORT_QUEUE_KEY])
    ? result[syncStore.REPORT_QUEUE_KEY]
    : [];
  const nextQueue = queue.filter((item) => item && item.batchId !== batch.batchId);
  nextQueue.push(batch);
  const overflow = Math.max(0, nextQueue.length - syncStore.MAX_REPORT_BATCHES);
  const trimmed = overflow ? nextQueue.slice(overflow) : nextQueue;
  await storageSet({ [syncStore.REPORT_QUEUE_KEY]: trimmed });
  if (overflow) {
    await setSyncStatus(false, `上报队列过长，已丢弃 ${overflow} 个最旧批次`);
  }
  return { queued: true, eventCount: batch.events.length };
}

async function flushReportQueue(force = false) {
  const connection = await getSyncConnection();
  if (!connection.enabled) return { skipped: true };

  const result = await storageGet([
    syncStore.REPORT_QUEUE_KEY,
    syncStore.RETRY_STATE_KEY
  ]);
  let queue = Array.isArray(result[syncStore.REPORT_QUEUE_KEY])
    ? result[syncStore.REPORT_QUEUE_KEY]
    : [];
  const retryState = result[syncStore.RETRY_STATE_KEY] || {};
  if (!force && retryState.nextRetryAt && new Date(retryState.nextRetryAt).getTime() > Date.now()) {
    return { skipped: true };
  }

  let sent = 0;
  while (queue.length) {
    const batch = queue[0];
    try {
      await syncFetch('/api/reports', {
        method: 'POST',
        body: JSON.stringify(batch)
      }, connection);
      sent += 1;
      queue = queue.slice(1);
      await storageSet({
        [syncStore.REPORT_QUEUE_KEY]: queue,
        [syncStore.RETRY_STATE_KEY]: {}
      });
    } catch (error) {
      const attempts = Number(retryState.attempts || 0) + 1;
      const delayMinutes = Math.min(120, 2 ** Math.min(attempts, 6));
      await storageSet({
        [syncStore.REPORT_QUEUE_KEY]: queue,
        [syncStore.RETRY_STATE_KEY]: {
          attempts,
          nextRetryAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
        }
      });
      await setSyncStatus(false, `数据上报失败：${error.message}`, { queuedBatches: queue.length });
      throw error;
    }
  }

  if (sent) await setSyncStatus(true, `已上报 ${sent} 个批次`);
  return { sent };
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
  await scheduleSyncAlarms();
  syncConfigNow().catch((error) => {
    console.warn('[TabulaBili] Failed to initialize config sync:', error);
  });
  flushReportQueue(false).catch((error) => {
    console.warn('[TabulaBili] Failed to initialize report sync:', error);
  });
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

async function buildCleanRequestHeaders(mode) {
  const { bili_fingerprint: fingerprint = '' } = await storageGet(['bili_fingerprint']);
  return mode === 'pure' || !fingerprint
    ? [{ header: 'cookie', operation: 'remove' }]
    : [{ header: 'cookie', operation: 'set', value: fingerprint }];
}

async function compileDynamicNetworkRules(mode, tabId = null) {
  const ruleIdsToRemove = [GLOBAL_FEED_RULE_ID];

  if (mode === 'origin') {
    await updateSessionRules({ removeRuleIds: ruleIdsToRemove });
    return;
  }

  const requestHeaders = await buildCleanRequestHeaders(mode);

  await updateSessionRules({
    removeRuleIds: ruleIdsToRemove,
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
  const requestHeaders = await buildCleanRequestHeaders('fusion');

  await updateSessionRules({
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
  await updateEnabledRulesets({ disableRulesetIds: ['rules'] });

  if (mode === 'pure' || mode === 'refresh') {
    await updateSessionRules({ removeRuleIds: [FUSION_FEED_RULE_ID] });
    await compileDynamicNetworkRules(mode);
    return;
  }

  if (mode === 'fusion') {
    await updateSessionRules({ removeRuleIds: [GLOBAL_FEED_RULE_ID] });
    await compileFusionNetworkRule();
    return;
  }

  await updateSessionRules({ removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
}

async function syncStoredModeConfiguration() {
  const { bili_mode: storedMode } = await storageGet(['bili_mode']);
  const mode = storedMode || 'pure';

  if (!storedMode) {
    await storageSet({ bili_mode: mode });
  }

  await syncGlobalModeConfiguration(mode);
}

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || (!changes.bili_mode && !changes.bili_fingerprint)) return;

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
      flushReportQueue(false).catch((error) => {
        console.warn('[TabulaBili] Scheduled report sync failed:', error);
      });
    }
  });
}

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[syncStore.REPORT_FREQUENCY_KEY]) {
    scheduleSyncAlarms().catch((error) => {
      console.warn('[TabulaBili] Failed to reschedule sync alarms:', error);
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
  const { bili_mode: mode = 'pure' } = await storageGet(['bili_mode']);

  if (mode === 'pure') {
    await compileDynamicNetworkRules('pure');
    return { active: true };
  }

  if (mode === 'origin') {
    await updateSessionRules({ removeRuleIds: [GLOBAL_FEED_RULE_ID, FUSION_FEED_RULE_ID] });
    return { active: false };
  }

  if (mode === 'mixed' && sender.tab && Number.isInteger(sender.tab.id)) {
    const tabId = sender.tab.id;
    tabRequestCounters[tabId] = (tabRequestCounters[tabId] || 0) + 1;

    const active = tabRequestCounters[tabId] % 2 !== 0;
    if (active) {
      await compileDynamicNetworkRules('mixed', tabId);
    } else {
      await updateSessionRules({ removeRuleIds: [GLOBAL_FEED_RULE_ID] });
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

  if (message.action === 'syncBackendNow') {
    syncConfigNow()
      .then((result) => flushReportQueue(true).then((reportResult) => ({ ...result, report: reportResult })))
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
        flushReportQueue(false).catch(() => null);
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

initializeSyncBackground().catch((error) => {
  console.warn('[TabulaBili] Failed to start sync background:', error);
});
