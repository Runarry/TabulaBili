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

function getTypeLabel(type) {
  return type === 'title_regex' ? '标题正则' : 'UP 主名';
}

function formatCreatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
}

document.addEventListener('DOMContentLoaded', async () => {
  const enabledInput = document.getElementById('blockerEnabled');
  const ruleForm = document.getElementById('ruleForm');
  const ruleType = document.getElementById('ruleType');
  const rulePattern = document.getElementById('rulePattern');
  const formMessage = document.getElementById('formMessage');
  const rulesList = document.getElementById('rulesList');
  const ruleCount = document.getElementById('ruleCount');

  let rules = [];

  function setMessage(text, isError = false) {
    formMessage.textContent = text;
    formMessage.classList.toggle('error', isError);
  }

  async function persist() {
    await storageSet({
      bili_blocker_enabled: enabledInput.checked,
      bili_block_rules: rules
    });
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
        await persist();
      });
      enabledLabel.append(enabled, document.createTextNode('启用'));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary-btn';
      removeBtn.textContent = '删除';
      removeBtn.addEventListener('click', async () => {
        rules = rules.filter((item) => item.id !== rule.id);
        await persist();
        renderRules();
      });

      row.append(type, pattern, created, enabledLabel, removeBtn);
      rulesList.append(row);
    }
  }

  try {
    const result = await storageGet(['bili_blocker_enabled', 'bili_block_rules']);
    enabledInput.checked = result.bili_blocker_enabled !== false;
    rules = normalizeRules(result.bili_block_rules);
    renderRules();
  } catch (error) {
    console.warn('[TabulaBili] Failed to load blocker settings:', error);
    enabledInput.checked = true;
    renderRules();
    setMessage('设置加载失败，请刷新后重试。', true);
  }

  enabledInput.addEventListener('change', async () => {
    try {
      await persist();
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
      await persist();
      renderRules();
      rulePattern.value = '';
      setMessage('规则已添加。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save blocker rule:', error);
      setMessage('保存失败，请重试。', true);
    }
  });
});
