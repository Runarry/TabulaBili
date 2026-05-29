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

function dispatchNetworkReady(eventId) {
  window.dispatchEvent(new CustomEvent('tabula_network_ready', { detail: eventId }));
}

const fingerprintReady = captureBiliFingerprint().catch((error) => {
  console.warn('[TabulaBili] Failed to capture fingerprint:', error);
});

window.addEventListener('tabula_request_triggered', async (event) => {
  const eventId = getBridgeEventId(event.detail);
  if (!eventId) return;

  try {
    await fingerprintReady;
    await sendRuntimeMessage({ action: 'evaluateMixedRequest' });
  } catch (error) {
    console.warn('[TabulaBili] Failed to prepare network state:', error);
  } finally {
    dispatchNetworkReady(eventId);
  }
});

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

    const rollBtn = document.querySelector('.roll-btn');
    if (rollBtn) {
      rollBtn.click();
    }

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
