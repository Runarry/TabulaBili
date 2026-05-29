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

function storageRemove(keys) {
  if (usePromiseApi) return extensionApi.storage.local.remove(keys);

  return new Promise((resolve, reject) => {
    extensionApi.storage.local.remove(keys, () => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  if (usePromiseApi) return extensionApi.tabs.query(queryInfo);

  return new Promise((resolve, reject) => {
    extensionApi.tabs.query(queryInfo, (tabs) => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve(tabs);
    });
  });
}

function tabsSendMessage(tabId, message) {
  if (usePromiseApi) return extensionApi.tabs.sendMessage(tabId, message);

  return new Promise((resolve, reject) => {
    extensionApi.tabs.sendMessage(tabId, message, (response) => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function isBilibiliTab(tab) {
  if (!tab || !tab.url) return false;

  try {
    const { hostname } = new URL(tab.url);
    return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
  } catch {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const radioInputs = document.querySelectorAll('input[name="biliMode"]');
  const resetFingerprintBtn = document.getElementById('resetFingerprintBtn');

  const updateStatusBar = (mode) => {
    switch (mode) {
      case 'pure':
        statusDot.className = 'status-dot active';
        statusText.textContent = '纯净模式运行中，阻止个人数据回传';
        statusText.style.color = 'var(--color-mint)';
        resetFingerprintBtn.style.display = 'none';
        break;
      case 'refresh':
        statusDot.className = 'status-dot active';
        statusText.textContent = '探索模式运行中，每次都有新花样';
        statusText.style.color = 'var(--color-mint)';
        resetFingerprintBtn.style.display = 'block';
        break;
      case 'mixed':
        statusDot.className = 'status-dot active';
        statusText.textContent = '混合模式运行中，热门与推荐兼顾';
        statusText.style.color = 'var(--color-mint)';
        resetFingerprintBtn.style.display = 'block';
        break;
      case 'origin':
      default:
        statusDot.className = 'status-dot';
        statusText.textContent = '个性模式运行中，已恢复B站原生推荐算法';
        statusText.style.color = 'var(--color-text-sub)';
        resetFingerprintBtn.style.display = 'none';
        break;
    }
  };

  try {
    const result = await storageGet(['bili_mode']);
    const currentMode = result.bili_mode || 'pure';
    const targetRadio = document.querySelector(`input[value="${currentMode}"]`);
    if (targetRadio) targetRadio.checked = true;
    updateStatusBar(currentMode);
  } catch (error) {
    console.warn('[TabulaBili] Failed to load mode:', error);
    updateStatusBar('pure');
  }

  radioInputs.forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const selectedMode = e.target.value;

      try {
        await storageSet({ bili_mode: selectedMode });
        updateStatusBar(selectedMode);

        const [tab] = await tabsQuery({ active: true, currentWindow: true });
        if (isBilibiliTab(tab)) {
          await tabsSendMessage(tab.id, {
            action: 'triggerModeSwitchRefresh',
            newMode: selectedMode
          });
        }
      } catch (error) {
        console.warn('[TabulaBili] Failed to switch mode:', error);
      }
    });
  });

  resetFingerprintBtn.addEventListener('click', async () => {
    try {
      await storageRemove(['bili_fingerprint']);
      const [tab] = await tabsQuery({ active: true, currentWindow: true });

      if (isBilibiliTab(tab)) {
        const response = await tabsSendMessage(tab.id, { action: 'resetDeviceFingerprint' });
        if (response && response.success) {
          resetFingerprintBtn.textContent = '已重置';
          setTimeout(() => { window.close(); }, 600);
        }
        return;
      }

      alert('请在打开的 B 站首页标签页中点击此按钮进行指纹重置。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to reset fingerprint:', error);
      alert('指纹重置失败，请确认当前标签页已打开 B 站页面。');
    }
  });
});
