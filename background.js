const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';

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

function buildFeedRuleCondition(tabId = null) {
  const condition = {
    urlFilter: '||api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
    resourceTypes: ['xmlhttprequest'],
    requestDomains: ['api.bilibili.com'],
    initiatorDomains: ['www.bilibili.com']
  };

  if (Number.isInteger(tabId)) {
    condition.tabIds = [tabId];
  }

  return condition;
}

async function compileDynamicNetworkRules(mode, tabId = null) {
  const ruleIdsToRemove = [100];

  if (mode === 'origin') {
    await updateSessionRules({ removeRuleIds: ruleIdsToRemove });
    return;
  }

  const { bili_fingerprint: fingerprint = '' } = await storageGet(['bili_fingerprint']);
  const requestHeaders = mode === 'pure' || !fingerprint
    ? [{ header: 'cookie', operation: 'remove' }]
    : [{ header: 'cookie', operation: 'set', value: fingerprint }];

  await updateSessionRules({
    removeRuleIds: ruleIdsToRemove,
    addRules: [
      {
        id: 100,
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

async function syncGlobalModeConfiguration(mode) {
  await updateEnabledRulesets({ disableRulesetIds: ['rules'] });

  if (mode === 'pure' || mode === 'refresh') {
    await compileDynamicNetworkRules(mode);
    return;
  }

  await updateSessionRules({ removeRuleIds: [100] });
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
  if (areaName !== 'local' || !changes.bili_mode) return;

  syncGlobalModeConfiguration(changes.bili_mode.newValue).catch((error) => {
    console.warn('[TabulaBili] Failed to sync mode:', error);
  });
});

extensionApi.runtime.onInstalled.addListener(() => {
  syncStoredModeConfiguration().catch((error) => {
    console.warn('[TabulaBili] Failed to initialize mode:', error);
  });
});

extensionApi.runtime.onStartup.addListener(() => {
  syncStoredModeConfiguration().catch((error) => {
    console.warn('[TabulaBili] Failed to restore mode:', error);
  });
});

const tabRequestCounters = {};

async function evaluateMixedRequest(sender) {
  const { bili_mode: mode = 'pure' } = await storageGet(['bili_mode']);

  if (mode === 'mixed' && sender.tab && Number.isInteger(sender.tab.id)) {
    const tabId = sender.tab.id;
    tabRequestCounters[tabId] = (tabRequestCounters[tabId] || 0) + 1;

    const active = tabRequestCounters[tabId] % 2 !== 0;
    if (active) {
      await compileDynamicNetworkRules('mixed', tabId);
    } else {
      await updateSessionRules({ removeRuleIds: [100] });
    }

    return { active };
  }

  if (mode === 'refresh') {
    await compileDynamicNetworkRules('refresh');
    return { active: true };
  }

  return { active: false };
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'evaluateMixedRequest') {
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
