const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';
const DEFAULT_FUSION_CLEAN_RATIO = 50;

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

function createRuleId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((rule) => rule && (rule.type === 'up_name_exact' || rule.type === 'title_regex'))
    .map((rule) => ({
      id: typeof rule.id === 'string' && rule.id ? rule.id : createRuleId(),
      type: rule.type,
      pattern: typeof rule.pattern === 'string' ? rule.pattern : '',
      enabled: rule.enabled !== false,
      createdAt: typeof rule.createdAt === 'string' ? rule.createdAt : new Date().toISOString()
    }))
    .filter((rule) => rule.pattern.trim());
}

function normalizeFusionCleanRatio(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FUSION_CLEAN_RATIO;

  const rounded = Math.round(parsed / 10) * 10;
  return Math.min(90, Math.max(10, rounded));
}

function getTypeLabel(type) {
  return type === 'title_regex' ? '标题正则' : 'UP 主名';
}

function formatCreatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}

document.addEventListener('DOMContentLoaded', async () => {
  const fusionCleanRatioInput = document.getElementById('fusionCleanRatio');
  const fusionCleanRatioText = document.getElementById('fusionCleanRatioText');
  const fusionOriginRatioText = document.getElementById('fusionOriginRatioText');
  const fusionMessage = document.getElementById('fusionMessage');
  const enabledInput = document.getElementById('blockerEnabled');
  const ruleForm = document.getElementById('ruleForm');
  const ruleType = document.getElementById('ruleType');
  const rulePattern = document.getElementById('rulePattern');
  const formMessage = document.getElementById('formMessage');
  const rulesList = document.getElementById('rulesList');
  const ruleCount = document.getElementById('ruleCount');

  let rules = [];
  let fusionCleanRatio = DEFAULT_FUSION_CLEAN_RATIO;
  let refreshTimer = null;

  function setMessage(text, isError = false) {
    formMessage.textContent = text;
    formMessage.classList.toggle('error', isError);
  }

  function setFusionMessage(text, isError = false) {
    fusionMessage.textContent = text;
    fusionMessage.classList.toggle('error', isError);
  }

  function renderFusionRatio() {
    fusionCleanRatioInput.value = String(fusionCleanRatio);
    fusionCleanRatioText.textContent = `${fusionCleanRatio}%`;
    fusionOriginRatioText.textContent = `${100 - fusionCleanRatio}%`;
  }

  function queueBiliTabsRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(async () => {
      refreshTimer = null;

      try {
        const tabs = await tabsQuery({ url: ['*://www.bilibili.com/*'] });
        await Promise.all((tabs || [])
          .filter((tab) => Number.isInteger(tab.id))
          .map((tab) => tabsSendMessage(tab.id, { action: 'triggerSettingsRefresh' }).catch(() => null)));
      } catch (error) {
        console.warn('[TabulaBili] Failed to refresh Bilibili tabs:', error);
      }
    }, 400);
  }

  async function persistBlocker() {
    await storageSet({
      bili_blocker_enabled: enabledInput.checked,
      bili_block_rules: rules
    });
    queueBiliTabsRefresh();
  }

  async function persistFusionRatio() {
    await storageSet({ bili_fusion_clean_ratio: fusionCleanRatio });
    queueBiliTabsRefresh();
  }

  function renderRules() {
    rulesList.textContent = '';
    ruleCount.textContent = `${rules.length} 条`;

    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '还没有屏蔽规则。';
      rulesList.append(empty);
      return;
    }

    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'rule-row';

      const type = document.createElement('div');
      type.className = 'rule-type';
      type.textContent = getTypeLabel(rule.type);

      const pattern = document.createElement('div');
      pattern.className = 'rule-pattern';
      pattern.textContent = rule.pattern;

      const created = document.createElement('div');
      created.className = 'rule-created';
      created.textContent = formatCreatedAt(rule.createdAt);

      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'rule-enabled';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = rule.enabled !== false;
      enabled.addEventListener('change', async () => {
        rule.enabled = enabled.checked;
        await persistBlocker();
      });
      enabledLabel.append(enabled, document.createTextNode('启用'));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary-btn';
      removeBtn.textContent = '删除';
      removeBtn.addEventListener('click', async () => {
        rules = rules.filter((item) => item.id !== rule.id);
        await persistBlocker();
        renderRules();
      });

      row.append(type, pattern, created, enabledLabel, removeBtn);
      rulesList.append(row);
    }
  }

  try {
    const result = await storageGet([
      'bili_blocker_enabled',
      'bili_block_rules',
      'bili_fusion_clean_ratio'
    ]);
    fusionCleanRatio = normalizeFusionCleanRatio(result.bili_fusion_clean_ratio);
    renderFusionRatio();
    enabledInput.checked = result.bili_blocker_enabled !== false;
    rules = normalizeRules(result.bili_block_rules);
    renderRules();
  } catch (error) {
    console.warn('[TabulaBili] Failed to load blocker settings:', error);
    renderFusionRatio();
    enabledInput.checked = true;
    renderRules();
    setMessage('设置加载失败，请刷新后重试。', true);
  }

  fusionCleanRatioInput.addEventListener('input', () => {
    fusionCleanRatio = normalizeFusionCleanRatio(fusionCleanRatioInput.value);
    renderFusionRatio();
  });

  fusionCleanRatioInput.addEventListener('change', async () => {
    try {
      fusionCleanRatio = normalizeFusionCleanRatio(fusionCleanRatioInput.value);
      renderFusionRatio();
      await persistFusionRatio();
      setFusionMessage('融合比例已保存。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save fusion ratio:', error);
      setFusionMessage('保存失败，请重试。', true);
    }
  });

  enabledInput.addEventListener('change', async () => {
    try {
      await persistBlocker();
      setMessage('已保存启用状态。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save blocker state:', error);
      setMessage('保存失败，请重试。', true);
    }
  });

  ruleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const type = ruleType.value;
    const pattern = rulePattern.value.trim();

    if (!pattern) {
      setMessage('规则内容不能为空。', true);
      return;
    }

    if (type === 'title_regex') {
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        setMessage(`正则无效：${error.message}`, true);
        return;
      }
    }

    rules.push({
      id: createRuleId(),
      type,
      pattern,
      enabled: true,
      createdAt: new Date().toISOString()
    });

    try {
      await persistBlocker();
      renderRules();
      rulePattern.value = '';
      setMessage('规则已添加。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save blocker rule:', error);
      setMessage('保存失败，请重试。', true);
    }
  });
});
