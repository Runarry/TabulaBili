const extensionApi = globalThis.browser ?? globalThis.chrome;
const usePromiseApi = typeof globalThis.browser !== 'undefined';
const DEFAULT_FUSION_CLEAN_RATIO = 50;
const analysisStore = globalThis.TabulaBiliAnalysis;
const syncStore = globalThis.TabulaBiliSync;
const ANALYSIS_PRIVACY_PROMPT = '导出的文件包含你的首页推荐标题、UP 主和人工标注，仅保存在本地。请确认后再分享给其他软件。';

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

function callPermissionsBoolean(method, permissions, fallbackValue) {
  if (!extensionApi.permissions) {
    return fallbackValue instanceof Error
      ? Promise.reject(fallbackValue)
      : Promise.resolve(fallbackValue);
  }
  if (usePromiseApi) return extensionApi.permissions[method](permissions);

  return new Promise((resolve, reject) => {
    extensionApi.permissions[method](permissions, (result) => {
      const error = getLastRuntimeError();
      if (error) reject(error);
      else resolve(result === true);
    });
  });
}

function permissionsContains(permissions) {
  return callPermissionsBoolean('contains', permissions, false);
}

function permissionsRequest(permissions) {
  return callPermissionsBoolean('request', permissions, new Error('当前浏览器不支持运行时授权'));
}

function permissionsRemove(permissions) {
  return callPermissionsBoolean('remove', permissions, false);
}

function getBackendOriginPattern(endpoint) {
  const text = syncStore.normalizeEndpoint(endpoint);
  if (!text) return '';

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('后端 URL 格式无效');
  }

  const hostname = url.hostname.toLowerCase();
  const isLocalHttp = url.protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('后端 URL 仅支持 HTTPS；本地调试可使用 localhost 或 127.0.0.1');
  }

  return `${url.protocol}//${hostname}/*`;
}

function getBackendOriginPatternOrEmpty(endpoint) {
  try {
    return getBackendOriginPattern(endpoint);
  } catch {
    return '';
  }
}

async function ensureBackendHostPermission(endpoint) {
  const origin = getBackendOriginPattern(endpoint);
  if (!origin) return '';

  const granted = await permissionsRequest({ origins: [origin] });
  if (!granted) throw new Error(`未授权访问后端 ${origin}`);
  return origin;
}

async function removeBackendHostPermission(origin) {
  if (!origin) return;
  const hasPermission = await permissionsContains({ origins: [origin] });
  if (hasPermission) await permissionsRemove({ origins: [origin] });
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

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatCountMap(value) {
  const entries = Object.entries(value || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  return entries.length
    ? entries.map(([key, count]) => `${key}:${count}`).join(' / ')
    : '';
}

function getTodayKey() {
  return analysisStore.getLocalDateKey(new Date());
}

function getFeedbackLabel(feedback) {
  const labels = {
    like: '喜欢',
    dislike: '不喜欢',
    neutral: '一般',
    blocked: '已屏蔽',
    unset: '未标注'
  };
  return labels[feedback] || labels.unset;
}

function makeDownload(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

document.addEventListener('DOMContentLoaded', async () => {
  const tabButtons = [...document.querySelectorAll('[data-tab-target]')];
  const tabPanels = [...document.querySelectorAll('[data-tab-panel]')];
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
  const analysisEnabledInput = document.getElementById('analysisEnabled');
  const analysisRetentionDaysInput = document.getElementById('analysisRetentionDays');
  const analysisMaxSamplesInput = document.getElementById('analysisMaxSamples');
  const analysisCaptureClicksInput = document.getElementById('analysisCaptureClicks');
  const analysisSaveSettingsBtn = document.getElementById('analysisSaveSettingsBtn');
  const analysisSettingsMessage = document.getElementById('analysisSettingsMessage');
  const syncEnabledInput = document.getElementById('syncEnabled');
  const syncEndpointInput = document.getElementById('syncEndpoint');
  const syncSecretInput = document.getElementById('syncSecret');
  const reportFrequencyInput = document.getElementById('reportFrequency');
  const syncSaveBtn = document.getElementById('syncSaveBtn');
  const syncNowBtn = document.getElementById('syncNowBtn');
  const reportNowBtn = document.getElementById('reportNowBtn');
  const syncMessage = document.getElementById('syncMessage');
  const analysisTotalSamples = document.getElementById('analysisTotalSamples');
  const analysisTodaySamples = document.getElementById('analysisTodaySamples');
  const analysisWeekSamples = document.getElementById('analysisWeekSamples');
  const analysisClickedSamples = document.getElementById('analysisClickedSamples');
  const analysisDislikedSamples = document.getElementById('analysisDislikedSamples');
  const analysisExportCsvBtn = document.getElementById('analysisExportCsvBtn');
  const analysisExportJsonlBtn = document.getElementById('analysisExportJsonlBtn');
  const analysisClearBtn = document.getElementById('analysisClearBtn');
  const analysisMessage = document.getElementById('analysisMessage');
  const analysisUpCount = document.getElementById('analysisUpCount');
  const analysisUpList = document.getElementById('analysisUpList');
  const analysisUpSearchInput = document.getElementById('analysisUpSearchInput');
  const analysisUpPageSizeInput = document.getElementById('analysisUpPageSize');
  const analysisUpPrevBtn = document.getElementById('analysisUpPrevBtn');
  const analysisUpNextBtn = document.getElementById('analysisUpNextBtn');
  const analysisUpPageInfo = document.getElementById('analysisUpPageInfo');
  const analysisSampleCount = document.getElementById('analysisSampleCount');
  const analysisSampleList = document.getElementById('analysisSampleList');
  const analysisSearchInput = document.getElementById('analysisSearchInput');
  const analysisFeedbackFilter = document.getElementById('analysisFeedbackFilter');
  const analysisPageSizeInput = document.getElementById('analysisPageSize');
  const analysisPrevPageBtn = document.getElementById('analysisPrevPageBtn');
  const analysisNextPageBtn = document.getElementById('analysisNextPageBtn');
  const analysisPageInfo = document.getElementById('analysisPageInfo');

  let rules = [];
  let fusionCleanRatio = DEFAULT_FUSION_CLEAN_RATIO;
  let analysisEnabled = false;
  let analysisSettings = { ...analysisStore.DEFAULT_SETTINGS };
  let analysisSampleState = { page: 1, pageSize: 25, q: '', feedback: 'all', total: 0 };
  let analysisUpState = { page: 1, pageSize: 25, q: '', total: 0 };
  let syncEnabled = false;
  let syncEndpoint = '';
  let syncSecret = '';
  let reportFrequency = syncStore.normalizeFrequency();
  let syncStatus = null;
  let syncQueuedBatches = 0;
  let refreshTimer = null;

  function getTabFromHash() {
    const name = window.location.hash.replace(/^#/, '');
    return name === 'statistics' || name === 'settings' ? name : 'settings';
  }

  function activateOptionsTab(tabName, updateHash = false) {
    const activeTab = tabName === 'statistics' ? 'statistics' : 'settings';

    for (const button of tabButtons) {
      const isActive = button.dataset.tabTarget === activeTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    }

    for (const panel of tabPanels) {
      panel.hidden = panel.dataset.tabPanel !== activeTab;
    }

    if (updateHash && window.location.hash !== `#${activeTab}`) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${activeTab}`);
    }
  }

  function setMessage(text, isError = false) {
    formMessage.textContent = text;
    formMessage.classList.toggle('error', isError);
  }

  function setFusionMessage(text, isError = false) {
    fusionMessage.textContent = text;
    fusionMessage.classList.toggle('error', isError);
  }

  function setAnalysisSettingsMessage(text, isError = false) {
    analysisSettingsMessage.textContent = text;
    analysisSettingsMessage.classList.toggle('error', isError);
  }

  function setAnalysisMessage(text, isError = false) {
    analysisMessage.textContent = text;
    analysisMessage.classList.toggle('error', isError);
  }

  function setSyncMessage(text, isError = false) {
    syncMessage.textContent = text;
    syncMessage.classList.toggle('error', isError);
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

  async function persistAnalysisSettings() {
    analysisSettings = analysisStore.normalizeSettings({
      retentionDays: analysisRetentionDaysInput.value,
      maxSamples: analysisMaxSamplesInput.value,
      captureClicks: analysisCaptureClicksInput.checked
    });
    analysisEnabled = analysisEnabledInput.checked;

    await storageSet({
      bili_analysis_enabled: analysisEnabled,
      [analysisStore.SETTINGS_KEY]: analysisSettings
    });
    await sendRuntimeMessage({ action: 'trimAnalysisSamples' });
    await renderAnalysis();
  }

  async function persistSyncSettings() {
    const previousOrigin = getBackendOriginPatternOrEmpty(syncEndpoint);
    const nextEndpoint = syncStore.normalizeEndpoint(syncEndpointInput.value);
    const nextSecret = syncSecretInput.value.trim();
    const nextReportFrequency = syncStore.normalizeFrequency(reportFrequencyInput.value);
    const nextEnabled = syncEnabledInput.checked;
    const nextOrigin = nextEnabled && nextEndpoint
      ? await ensureBackendHostPermission(nextEndpoint)
      : '';

    await storageSet({
      [syncStore.ENDPOINT_KEY]: nextEndpoint,
      [syncStore.SECRET_KEY]: nextSecret,
      [syncStore.ENABLED_KEY]: nextEnabled,
      [syncStore.REPORT_FREQUENCY_KEY]: nextReportFrequency
    });

    syncEndpoint = nextEndpoint;
    syncSecret = nextSecret;
    reportFrequency = nextReportFrequency;
    syncEnabled = nextEnabled;
    renderSyncControls();

    if (previousOrigin && previousOrigin !== nextOrigin) {
      removeBackendHostPermission(previousOrigin).catch((error) => {
        console.warn('[TabulaBili] Failed to remove previous backend permission:', error);
      });
    }
  }

  function renderAnalysisControls() {
    analysisEnabledInput.checked = analysisEnabled;
    analysisRetentionDaysInput.value = String(analysisSettings.retentionDays);
    analysisMaxSamplesInput.value = String(analysisSettings.maxSamples);
    analysisCaptureClicksInput.checked = analysisSettings.captureClicks;
  }

  async function renderAnalysis() {
    renderAnalysisControls();
    await Promise.all([
      renderAnalysisSummary(),
      renderUpStats(),
      renderSampleStats()
    ]);
  }

  function renderSyncControls() {
    syncEnabledInput.checked = syncEnabled;
    syncEndpointInput.value = syncEndpoint;
    syncSecretInput.value = syncSecret;
    reportFrequencyInput.value = String(reportFrequency);
    const queueSuffix = syncQueuedBatches > 0 ? `，待上报 ${syncQueuedBatches} 个批次` : '';

    if (syncStatus && syncStatus.message) {
      const date = new Date(syncStatus.at || 0);
      const suffix = Number.isNaN(date.getTime()) ? '' : `（${date.toLocaleString('zh-CN')}）`;
      setSyncMessage(`${syncStatus.message}${queueSuffix}${suffix}`, syncStatus.ok === false);
    } else {
      setSyncMessage(syncEnabled
        ? `同步已启用${queueSuffix || '，保存后可立即同步。'}`
        : '同步未启用。');
    }
  }

  function getQueueStatusCount(value) {
    const count = Number(value && value.queuedBatches);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function getReportResultMessage(result, prefix = '') {
    if (result && result.skipped) {
      if (result.reason === 'disabled') return `${prefix}同步与上报未启用。`;
      if (result.reason === 'retry_wait') return `${prefix}上报等待重试。`;
      return `${prefix}上报已跳过。`;
    }

    const sent = result && Number(result.sent || 0);
    return sent ? `${prefix}已上报 ${sent} 个批次。` : `${prefix}没有待上报数据。`;
  }

  function renderAnalysisSafely() {
    renderAnalysis().catch((error) => {
      console.warn('[TabulaBili] Failed to render analysis data:', error);
      setAnalysisMessage('统计数据加载失败，请刷新后重试。', true);
    });
  }

  function renderAnalysisSummarySafely() {
    renderAnalysisSummary().catch((error) => {
      console.warn('[TabulaBili] Failed to render analysis summary:', error);
      setAnalysisMessage('统计概览加载失败，请刷新后重试。', true);
    });
  }

  function renderUpStatsSafely() {
    renderUpStats().catch((error) => {
      console.warn('[TabulaBili] Failed to render UP stats:', error);
      setAnalysisMessage('UP 统计加载失败，请刷新后重试。', true);
    });
  }

  function renderSampleStatsSafely() {
    renderSampleStats().catch((error) => {
      console.warn('[TabulaBili] Failed to render sample stats:', error);
      setAnalysisMessage('样本统计加载失败，请刷新后重试。', true);
    });
  }

  async function renderAnalysisSummary() {
    const summary = await analysisStore.getSummary();
    analysisTotalSamples.textContent = String(summary.total);
    analysisTodaySamples.textContent = String(summary.today);
    analysisWeekSamples.textContent = String(summary.week);
    analysisClickedSamples.textContent = String(summary.clicked);
    analysisDislikedSamples.textContent = String(summary.disliked);
  }

  async function renderUpStats() {
    const result = await analysisStore.listUpStats(analysisUpState);
    const stats = result.items;
    analysisUpState.total = result.total;
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (analysisUpState.page > totalPages) {
      analysisUpState.page = totalPages;
      return renderUpStats();
    }

    analysisUpList.textContent = '';
    analysisUpCount.textContent = `${result.total} 位`;
    analysisUpPageInfo.textContent = `第 ${analysisUpState.page} / ${totalPages} 页`;
    analysisUpPrevBtn.disabled = analysisUpState.page <= 1;
    analysisUpNextBtn.disabled = analysisUpState.page >= totalPages;

    if (!stats.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = analysisEnabled ? '还没有采集到推荐样本。' : '本地分析模式未开启。';
      analysisUpList.append(empty);
      return;
    }

    for (const stat of stats) {
      const row = document.createElement('div');
      row.className = 'analysis-row';

      const main = document.createElement('div');
      main.className = 'analysis-main';

      const title = document.createElement('div');
      title.className = 'analysis-title';
      title.textContent = stat.upName;

      const meta = document.createElement('div');
      meta.className = 'analysis-meta';
      meta.textContent = `推荐 ${stat.seenCount} 次 / 视频 ${stat.sampleCount} 条 / 点击 ${stat.clickCount} 次`;

      const submeta = document.createElement('div');
      submeta.className = 'analysis-submeta';
      submeta.textContent = `不喜欢 ${stat.dislikeCount} / 已屏蔽 ${stat.blockedCount} / 最近 ${formatDateTime(stat.lastSeenAt) || '-'}`;

      main.append(title, meta, submeta);

      const actions = document.createElement('div');
      actions.className = 'analysis-actions-inline';

      const dislikeBtn = createAnalysisButton('不喜欢', false, async () => {
        await markUpFeedback(stat, 'dislike');
      });
      const blockBtn = createAnalysisButton('屏蔽 UP', false, async () => {
        await blockUp(stat.upName);
      });

      actions.append(dislikeBtn, blockBtn);
      row.append(main, actions);
      analysisUpList.append(row);
    }
  }

  async function renderSampleStats() {
    const result = await analysisStore.listSamples(analysisSampleState);
    const samples = result.items;
    analysisSampleState.total = result.total;
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (analysisSampleState.page > totalPages) {
      analysisSampleState.page = totalPages;
      return renderSampleStats();
    }

    analysisSampleList.textContent = '';
    analysisSampleCount.textContent = `${result.total} 条`;
    analysisPageInfo.textContent = `第 ${analysisSampleState.page} / ${totalPages} 页`;
    analysisPrevPageBtn.disabled = analysisSampleState.page <= 1;
    analysisNextPageBtn.disabled = analysisSampleState.page >= totalPages;

    if (!samples.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = analysisEnabled ? '还没有采集到推荐样本。' : '开启本地分析模式后会显示推荐样本。';
      analysisSampleList.append(empty);
      return;
    }

    for (const sample of samples) {
      const row = document.createElement('div');
      row.className = 'analysis-row';

      const main = document.createElement('div');
      main.className = 'analysis-main';

      const title = document.createElement('div');
      title.className = 'analysis-title';
      title.textContent = sample.title || sample.id;

      const meta = document.createElement('div');
      meta.className = 'analysis-meta';
      meta.textContent = `${sample.upName || '未知 UP'} / ${sample.category || '未分类'} / ${formatDateTime(sample.lastSeenAt || sample.capturedAt) || '-'}`;

      const submeta = document.createElement('div');
      submeta.className = 'analysis-submeta';
      submeta.textContent = [
        `推荐 ${sample.seenCount} 次`,
        `点击 ${sample.clickCount} 次`,
        `标注 ${getFeedbackLabel(sample.feedback)}`,
        `模式 ${formatCountMap(sample.modes) || sample.mode || '-'}`,
        `来源 ${formatCountMap(sample.sources) || sample.source || '-'}`
      ].join(' / ');

      main.append(title, meta, submeta);

      const actions = document.createElement('div');
      actions.className = 'analysis-actions-inline';
      actions.append(
        createAnalysisButton('喜欢', sample.feedback === 'like', async () => updateSampleFeedback(sample.id, 'like')),
        createAnalysisButton('不喜欢', sample.feedback === 'dislike', async () => updateSampleFeedback(sample.id, 'dislike')),
        createAnalysisButton('一般', sample.feedback === 'neutral', async () => updateSampleFeedback(sample.id, 'neutral')),
        createAnalysisButton('清除', sample.feedback === 'unset', async () => updateSampleFeedback(sample.id, 'unset')),
        createAnalysisButton('屏蔽 UP', sample.feedback === 'blocked', async () => blockUp(sample.upName, sample.id))
      );

      row.append(main, actions);
      analysisSampleList.append(row);
    }
  }

  function createAnalysisButton(label, active, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `analysis-chip${active ? ' active' : ''}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      try {
        button.disabled = true;
        await onClick();
      } catch (error) {
        console.warn('[TabulaBili] Failed to update analysis data:', error);
        setAnalysisMessage('操作失败，请重试。', true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  async function updateSampleFeedback(sampleId, feedback) {
    const response = await sendRuntimeMessage({ action: 'updateAnalysisFeedback', sampleId, feedback });
    if (!response || response.success !== true) {
      throw new Error(response && response.error ? response.error : '标注失败');
    }
    await renderAnalysis();
    setAnalysisMessage('标注已保存。');
  }

  async function markUpFeedback(stat, feedback) {
    const response = await sendRuntimeMessage({
      action: 'updateAnalysisUpFeedback',
      criteria: { upMid: stat.upMid, upName: stat.upName },
      feedback
    });
    if (!response || response.success !== true) {
      throw new Error(response && response.error ? response.error : '标注失败');
    }
    await renderAnalysis();
    setAnalysisMessage('UP 主相关样本已标注。');
  }

  async function blockUp(upName, sampleId = '') {
    const pattern = (upName || '').trim();
    if (!pattern) {
      setAnalysisMessage('缺少 UP 主名称，无法添加屏蔽规则。', true);
      return;
    }

    const blockerEnabled = enabledInput.checked;
    const exists = rules.some((rule) => (
      rule.type === 'up_name_exact'
      && rule.pattern.trim() === pattern
    ));

    if (!exists) {
      rules.push({
        id: createRuleId(),
        type: 'up_name_exact',
        pattern,
        enabled: true,
        createdAt: new Date().toISOString(),
        source: 'analysis'
      });
      await persistBlocker();
      renderRules();
    }

    const response = sampleId
      ? await sendRuntimeMessage({ action: 'updateAnalysisFeedback', sampleId, feedback: 'blocked' })
      : await sendRuntimeMessage({
        action: 'updateAnalysisUpFeedback',
        criteria: { upName: pattern },
        feedback: 'blocked'
      });
    if (!response || response.success !== true) {
      throw new Error(response && response.error ? response.error : '标注失败');
    }
    await renderAnalysis();
    setAnalysisMessage(exists
      ? '该 UP 主已在屏蔽规则中。'
      : (blockerEnabled ? '已添加 UP 主屏蔽规则。' : '已添加 UP 主屏蔽规则，内容屏蔽开关当前关闭。'));
  }

  async function exportAnalysisCsv() {
    const samples = await analysisStore.exportSamples({
      q: analysisSampleState.q,
      feedback: analysisSampleState.feedback
    });
    if (!samples.length) {
      setAnalysisMessage('没有可导出的统计样本。', true);
      return;
    }
    if (!window.confirm(ANALYSIS_PRIVACY_PROMPT)) return;

    const columns = [
      ['id', (sample) => sample.id],
      ['bvid', (sample) => sample.bvid],
      ['aid', (sample) => sample.aid],
      ['title', (sample) => sample.title],
      ['upName', (sample) => sample.upName],
      ['upMid', (sample) => sample.upMid],
      ['category', (sample) => sample.category],
      ['duration', (sample) => sample.duration],
      ['firstSeenAt', (sample) => sample.firstSeenAt],
      ['lastSeenAt', (sample) => sample.lastSeenAt],
      ['seenCount', (sample) => sample.seenCount],
      ['clickCount', (sample) => sample.clickCount],
      ['lastClickedAt', (sample) => sample.lastClickedAt],
      ['feedback', (sample) => sample.feedback],
      ['modeCounts', (sample) => formatCountMap(sample.modes)],
      ['sourceCounts', (sample) => formatCountMap(sample.sources)],
      ['reason', (sample) => sample.reason],
      ['view', (sample) => sample.stats && sample.stats.view],
      ['like', (sample) => sample.stats && sample.stats.like],
      ['danmaku', (sample) => sample.stats && sample.stats.danmaku],
      ['uri', (sample) => sample.uri]
    ];
    const rows = samples.map((sample) => columns.map(([, getValue]) => getValue(sample)));

    const csv = [columns.map(([header]) => header), ...rows]
      .map((row) => row.map(csvEscape).join(','))
      .join('\n');
    makeDownload(`tabulabili-analysis-${getTodayKey()}.csv`, 'text/csv;charset=utf-8', `\ufeff${csv}`);
    setAnalysisMessage('CSV 已导出。');
  }

  async function exportAnalysisJsonl() {
    const samples = await analysisStore.exportSamples({
      q: analysisSampleState.q,
      feedback: analysisSampleState.feedback
    });
    if (!samples.length) {
      setAnalysisMessage('没有可导出的统计样本。', true);
      return;
    }
    if (!window.confirm(ANALYSIS_PRIVACY_PROMPT)) return;

    const jsonl = samples.map((sample) => JSON.stringify(sample)).join('\n');
    makeDownload(`tabulabili-analysis-${getTodayKey()}.jsonl`, 'application/jsonl;charset=utf-8', jsonl);
    setAnalysisMessage('JSONL 已导出。');
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

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      activateOptionsTab(button.dataset.tabTarget, true);
    });
  }

  window.addEventListener('hashchange', () => {
    activateOptionsTab(getTabFromHash());
  });

  let analysisSampleSearchTimer = null;
  let analysisUpSearchTimer = null;
  analysisSearchInput.addEventListener('input', () => {
    analysisSampleState.q = analysisSearchInput.value.trim();
    analysisSampleState.page = 1;
    clearTimeout(analysisSampleSearchTimer);
    analysisSampleSearchTimer = setTimeout(renderSampleStatsSafely, 220);
  });
  analysisFeedbackFilter.addEventListener('change', () => {
    analysisSampleState.feedback = analysisFeedbackFilter.value;
    analysisSampleState.page = 1;
    renderSampleStatsSafely();
  });
  analysisPageSizeInput.addEventListener('change', () => {
    analysisSampleState.pageSize = Number(analysisPageSizeInput.value || 25);
    analysisSampleState.page = 1;
    renderSampleStatsSafely();
  });
  analysisPrevPageBtn.addEventListener('click', () => {
    analysisSampleState.page = Math.max(1, analysisSampleState.page - 1);
    renderSampleStatsSafely();
  });
  analysisNextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(analysisSampleState.total / analysisSampleState.pageSize));
    analysisSampleState.page = Math.min(totalPages, analysisSampleState.page + 1);
    renderSampleStatsSafely();
  });

  analysisUpSearchInput.addEventListener('input', () => {
    analysisUpState.q = analysisUpSearchInput.value.trim();
    analysisUpState.page = 1;
    clearTimeout(analysisUpSearchTimer);
    analysisUpSearchTimer = setTimeout(renderUpStatsSafely, 220);
  });
  analysisUpPageSizeInput.addEventListener('change', () => {
    analysisUpState.pageSize = Number(analysisUpPageSizeInput.value || 25);
    analysisUpState.page = 1;
    renderUpStatsSafely();
  });
  analysisUpPrevBtn.addEventListener('click', () => {
    analysisUpState.page = Math.max(1, analysisUpState.page - 1);
    renderUpStatsSafely();
  });
  analysisUpNextBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(analysisUpState.total / analysisUpState.pageSize));
    analysisUpState.page = Math.min(totalPages, analysisUpState.page + 1);
    renderUpStatsSafely();
  });

  activateOptionsTab(getTabFromHash());

  try {
    const result = await storageGet([
      'bili_blocker_enabled',
      'bili_block_rules',
      'bili_fusion_clean_ratio',
      'bili_analysis_enabled',
      analysisStore.SETTINGS_KEY,
      syncStore.ENDPOINT_KEY,
      syncStore.SECRET_KEY,
      syncStore.ENABLED_KEY,
      syncStore.REPORT_FREQUENCY_KEY,
      syncStore.LAST_STATUS_KEY,
      syncStore.REPORT_QUEUE_STATUS_KEY
    ]);
    fusionCleanRatio = normalizeFusionCleanRatio(result.bili_fusion_clean_ratio);
    renderFusionRatio();
    enabledInput.checked = result.bili_blocker_enabled !== false;
    rules = normalizeRules(result.bili_block_rules);
    renderRules();
    analysisEnabled = result.bili_analysis_enabled === true;
    analysisSettings = analysisStore.normalizeSettings(result[analysisStore.SETTINGS_KEY]);
    const migration = await sendRuntimeMessage({ action: 'ensureAnalysisMigrated' });
    if (!migration || migration.success !== true) {
      throw new Error(migration && migration.error ? migration.error : '统计数据迁移失败');
    }
    syncEndpoint = syncStore.normalizeEndpoint(result[syncStore.ENDPOINT_KEY]);
    syncSecret = typeof result[syncStore.SECRET_KEY] === 'string' ? result[syncStore.SECRET_KEY] : '';
    syncEnabled = result[syncStore.ENABLED_KEY] === true;
    reportFrequency = syncStore.normalizeFrequency(result[syncStore.REPORT_FREQUENCY_KEY]);
    syncStatus = result[syncStore.LAST_STATUS_KEY] || null;
    syncQueuedBatches = getQueueStatusCount(result[syncStore.REPORT_QUEUE_STATUS_KEY]);
    await renderAnalysis();
    renderSyncControls();
  } catch (error) {
    console.warn('[TabulaBili] Failed to load blocker settings:', error);
    renderFusionRatio();
    enabledInput.checked = true;
    renderRules();
    await renderAnalysis().catch(() => null);
    renderSyncControls();
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

  analysisEnabledInput.addEventListener('change', async () => {
    try {
      await persistAnalysisSettings();
      setAnalysisSettingsMessage(analysisEnabled ? '本地分析模式已开启。' : '本地分析模式已关闭。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save analysis enabled state:', error);
      setAnalysisSettingsMessage('保存失败，请重试。', true);
    }
  });

  analysisSaveSettingsBtn.addEventListener('click', async () => {
    try {
      await persistAnalysisSettings();
      setAnalysisSettingsMessage('统计设置已保存。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save analysis settings:', error);
      setAnalysisSettingsMessage('保存失败，请重试。', true);
    }
  });

  syncSaveBtn.addEventListener('click', async () => {
    try {
      await persistSyncSettings();
      setSyncMessage('同步连接已保存。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save sync settings:', error);
      setSyncMessage(`保存失败：${error.message}`, true);
    }
  });

  syncEnabledInput.addEventListener('change', async () => {
    try {
      await persistSyncSettings();
      setSyncMessage(syncEnabled ? '同步已启用。' : '同步已关闭。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to save sync enabled state:', error);
      renderSyncControls();
      setSyncMessage(`保存失败：${error.message}`, true);
    }
  });

  syncNowBtn.addEventListener('click', async () => {
    try {
      await persistSyncSettings();
      syncNowBtn.disabled = true;
      const response = await sendRuntimeMessage({ action: 'syncBackendNow' });
      if (!response || response.success !== true) {
        throw new Error(response && response.error ? response.error : '同步失败');
      }
      const prefix = response.result && response.result.ok === true ? '配置已同步，' : '';
      setSyncMessage(getReportResultMessage(response.result && response.result.report, prefix));
    } catch (error) {
      console.warn('[TabulaBili] Manual sync failed:', error);
      setSyncMessage(`同步失败：${error.message}`, true);
    } finally {
      syncNowBtn.disabled = false;
    }
  });

  reportNowBtn.addEventListener('click', async () => {
    try {
      await persistSyncSettings();
      reportNowBtn.disabled = true;
      const response = await sendRuntimeMessage({ action: 'reportBackendNow' });
      if (!response || response.success !== true) {
        throw new Error(response && response.error ? response.error : '上报失败');
      }
      setSyncMessage(getReportResultMessage(response.result));
    } catch (error) {
      console.warn('[TabulaBili] Manual report failed:', error);
      setSyncMessage(`上报失败：${error.message}`, true);
    } finally {
      reportNowBtn.disabled = false;
    }
  });

  analysisExportCsvBtn.addEventListener('click', () => {
    exportAnalysisCsv().catch((error) => {
      console.warn('[TabulaBili] Failed to export analysis CSV:', error);
      setAnalysisMessage('导出失败，请重试。', true);
    });
  });
  analysisExportJsonlBtn.addEventListener('click', () => {
    exportAnalysisJsonl().catch((error) => {
      console.warn('[TabulaBili] Failed to export analysis JSONL:', error);
      setAnalysisMessage('导出失败，请重试。', true);
    });
  });

  analysisClearBtn.addEventListener('click', async () => {
    if (!window.confirm('确定清空所有本地统计样本和标注吗？此操作不可恢复。')) return;

    try {
      const response = await sendRuntimeMessage({ action: 'clearAnalysisSamples' });
      if (!response || response.success !== true) {
        throw new Error(response && response.error ? response.error : '清空失败');
      }
      analysisSampleState.page = 1;
      analysisUpState.page = 1;
      await renderAnalysis();
      setAnalysisMessage('统计数据已清空。');
    } catch (error) {
      console.warn('[TabulaBili] Failed to clear analysis samples:', error);
      setAnalysisMessage('清空失败，请重试。', true);
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

  extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    let shouldRenderAnalysis = false;
    let shouldRenderAnalysisSummary = false;
    if (changes.bili_analysis_enabled) {
      analysisEnabled = changes.bili_analysis_enabled.newValue === true;
      shouldRenderAnalysis = true;
    }
    if (changes[analysisStore.SETTINGS_KEY]) {
      analysisSettings = analysisStore.normalizeSettings(changes[analysisStore.SETTINGS_KEY].newValue);
      shouldRenderAnalysis = true;
    }
    if (changes[analysisStore.UPDATED_AT_KEY]) {
      const reason = changes[analysisStore.UPDATED_AT_KEY].newValue
        && changes[analysisStore.UPDATED_AT_KEY].newValue.reason;
      if (reason === 'capture') {
        shouldRenderAnalysisSummary = true;
      } else {
        shouldRenderAnalysis = true;
      }
    }

    if (shouldRenderAnalysis) renderAnalysis().catch((error) => {
      console.warn('[TabulaBili] Failed to render analysis data:', error);
    });
    else if (shouldRenderAnalysisSummary) renderAnalysisSummarySafely();

    let shouldRenderSync = false;
    if (changes[syncStore.ENDPOINT_KEY]) {
      syncEndpoint = syncStore.normalizeEndpoint(changes[syncStore.ENDPOINT_KEY].newValue);
      shouldRenderSync = true;
    }
    if (changes[syncStore.SECRET_KEY]) {
      syncSecret = typeof changes[syncStore.SECRET_KEY].newValue === 'string' ? changes[syncStore.SECRET_KEY].newValue : '';
      shouldRenderSync = true;
    }
    if (changes[syncStore.ENABLED_KEY]) {
      syncEnabled = changes[syncStore.ENABLED_KEY].newValue === true;
      shouldRenderSync = true;
    }
    if (changes[syncStore.REPORT_FREQUENCY_KEY]) {
      reportFrequency = syncStore.normalizeFrequency(changes[syncStore.REPORT_FREQUENCY_KEY].newValue);
      shouldRenderSync = true;
    }
    if (changes[syncStore.LAST_STATUS_KEY]) {
      syncStatus = changes[syncStore.LAST_STATUS_KEY].newValue || null;
      shouldRenderSync = true;
    }
    if (changes[syncStore.REPORT_QUEUE_STATUS_KEY]) {
      syncQueuedBatches = getQueueStatusCount(changes[syncStore.REPORT_QUEUE_STATUS_KEY].newValue);
      shouldRenderSync = true;
    }

    if (shouldRenderSync) renderSyncControls();
  });
});
