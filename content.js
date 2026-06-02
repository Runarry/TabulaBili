const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';
const DEFAULT_FUSION_CLEAN_RATIO = 50;
const analysisStore = globalThis.TabulaBiliAnalysis;

let lastAnalysisWrite = Promise.resolve();

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

function sendRuntimeMessage(message) {
  if (usePromiseApi) return extensionApi.runtime.sendMessage(message);

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function getRawCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]*)'));
  return match ? match[2] : null;
}

async function captureBiliFingerprint() {
  const buvid3 = getRawCookie('buvid3');
  const buvid4 = getRawCookie('buvid4');

  if (!buvid3) return;

  const fingerprintString = `buvid3=${buvid3}${buvid4 ? `; buvid4=${buvid4}` : ''}`;
  await storageSet({ bili_fingerprint: fingerprintString });
}

function setDocumentMode(mode) {
  document.documentElement.setAttribute('data-tabula-mode', mode);
}

function tryClickRollBtn() {
  const rollBtn = document.querySelector('.roll-btn');
  if (rollBtn) {
    if (window.scrollY < 100) rollBtn.click();
    return;
  }

  setTimeout(tryClickRollBtn, 200);
}

let queuedRefreshTimer = null;

function queueRollRefresh() {
  if (queuedRefreshTimer) {
    clearTimeout(queuedRefreshTimer);
  }

  queuedRefreshTimer = setTimeout(() => {
    queuedRefreshTimer = null;
    clickRollBtnWithRetry(0);
  }, 350);
}

function clickRollBtnWithRetry(attempt) {
  const rollBtn = document.querySelector('.roll-btn');
  if (rollBtn) {
    rollBtn.click();
    return;
  }

  if (attempt < 8) {
    queuedRefreshTimer = setTimeout(() => {
      queuedRefreshTimer = null;
      clickRollBtnWithRetry(attempt + 1);
    }, 200);
  }
}

function enablePureModeAutoRoll() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryClickRollBtn);
    return;
  }

  tryClickRollBtn();
}

function getBridgeEventId(detail) {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail.eventId === 'string') return detail.eventId;
  return null;
}

function dispatchNetworkReady(detail) {
  window.dispatchEvent(new CustomEvent('tabula_network_ready', {
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail)
  }));
}

function normalizeBlockerRules(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((rule) => rule && (rule.type === 'up_name_exact' || rule.type === 'title_regex'))
    .map((rule) => ({
      id: typeof rule.id === 'string' ? rule.id : '',
      type: rule.type,
      pattern: typeof rule.pattern === 'string' ? rule.pattern : '',
      enabled: rule.enabled !== false
    }))
    .filter((rule) => rule.pattern.trim());
}

function normalizeFusionCleanRatio(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FUSION_CLEAN_RATIO;

  const rounded = Math.round(parsed / 10) * 10;
  return Math.min(90, Math.max(10, rounded));
}

function dispatchSettingsConfig(config) {
  window.dispatchEvent(new CustomEvent('tabula_settings_config', {
    detail: JSON.stringify(config)
  }));
}

async function syncSettingsConfig() {
  const result = await storageGet([
    'bili_blocker_enabled',
    'bili_block_rules',
    'bili_fusion_clean_ratio',
    'bili_analysis_enabled'
  ]);

  dispatchSettingsConfig({
    blocker: {
      enabled: result.bili_blocker_enabled !== false,
      rules: normalizeBlockerRules(result.bili_block_rules)
    },
    fusionCleanRatio: normalizeFusionCleanRatio(result.bili_fusion_clean_ratio),
    analysis: {
      enabled: result.bili_analysis_enabled === true
    }
  });
}

function queueAnalysisPayload(payload) {
  const samples = payload && Array.isArray(payload.samples) ? payload.samples : [];
  if (!samples.length) return;

  lastAnalysisWrite = sendRuntimeMessage({ action: 'captureAnalysisSamples', payload })
    .catch((error) => {
      console.warn('[TabulaBili] Failed to capture analysis samples:', error);
    });
}

function getVideoIdFromUrl(value) {
  if (!value) return '';

  try {
    const url = new URL(value, location.href);
    const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (match) return match[1];
  } catch {
    const match = String(value).match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (match) return match[1];
  }

  return '';
}

async function trackAnalysisClick(videoId) {
  if (!videoId) return;
  await lastAnalysisWrite.catch(() => null);
  await sendRuntimeMessage({ action: 'recordAnalysisClick', videoId });
}

const fingerprintReady = captureBiliFingerprint().catch((error) => {
  console.warn('[TabulaBili] Failed to capture fingerprint:', error);
});

window.addEventListener('tabula_settings_config_request', () => {
  syncSettingsConfig().catch((error) => {
    console.warn('[TabulaBili] Failed to sync settings config:', error);
  });
});

window.addEventListener('tabula_analysis_samples', (event) => {
  const detail = typeof event.detail === 'string' ? event.detail : '';
  if (!detail) return;

  try {
    const parsed = JSON.parse(detail);
    queueAnalysisPayload(parsed);
  } catch (error) {
    console.warn('[TabulaBili] Failed to parse analysis samples:', error);
  }
});

syncSettingsConfig().catch((error) => {
  console.warn('[TabulaBili] Failed to initialize settings config:', error);
});

window.addEventListener('tabula_request_triggered', async (event) => {
  const eventId = getBridgeEventId(event.detail);
  if (!eventId) return;

  let response = null;
  try {
    await fingerprintReady;
    response = await sendRuntimeMessage({ action: 'evaluateMixedRequest' });
  } catch (error) {
    console.warn('[TabulaBili] Failed to prepare network state:', error);
  } finally {
    dispatchNetworkReady({
      eventId,
      active: response && response.active === true
    });
  }
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const link = target.closest('a[href]');
  const videoId = link ? getVideoIdFromUrl(link.href) : '';
  if (!videoId) return;

  trackAnalysisClick(videoId).catch((error) => {
    console.warn('[TabulaBili] Failed to track analysis click:', error);
  });
}, true);

storageGet(['bili_mode'])
  .then((result) => {
    const currentMode = result.bili_mode || 'pure';
    setDocumentMode(currentMode);

    if (currentMode === 'pure') {
      enablePureModeAutoRoll();
    }
  })
  .catch((error) => {
    console.warn('[TabulaBili] Failed to read mode:', error);
    setDocumentMode('pure');
    enablePureModeAutoRoll();
  });

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'triggerModeSwitchRefresh') {
    setDocumentMode(message.newMode);
    sendRuntimeMessage({ action: 'syncModeConfiguration' })
      .catch((error) => {
        console.warn('[TabulaBili] Failed to sync mode before refresh:', error);
      })
      .finally(queueRollRefresh);

    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'triggerSettingsRefresh') {
    if (message.newMode) {
      setDocumentMode(message.newMode);
    }

    queueRollRefresh();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'resetDeviceFingerprint') {
    document.cookie = 'buvid3=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.bilibili.com';
    document.cookie = 'buvid4=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.bilibili.com';
    sendResponse({ success: true });
    window.location.reload();
    return true;
  }

  return false;
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (
    changes.bili_blocker_enabled
    || changes.bili_block_rules
    || changes.bili_fusion_clean_ratio
    || changes.bili_analysis_enabled
  ) {
    syncSettingsConfig().catch((error) => {
      console.warn('[TabulaBili] Failed to sync settings config:', error);
    });
  }
});
