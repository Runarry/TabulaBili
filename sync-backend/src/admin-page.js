function adminPage(activePage = 'data') {
  const page = activePage === 'analytics' ? 'analytics' : 'data';
  const body = page === 'analytics' ? analyticsBody() : dataBody();
  const script = page === 'analytics' ? analyticsScript() : dataScript();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TabulaBili Sync</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #19202a; }
    header, main { max-width: 1180px; margin: 0 auto; padding: 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    a { color: inherit; }
    button, input, select { font: inherit; }
    input, select { padding: 9px 10px; border: 1px solid #c9d1dc; border-radius: 6px; background: white; }
    button { padding: 9px 12px; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.secondary { background: #485465; }
    nav { display: flex; gap: 8px; margin-top: 10px; }
    nav a { padding: 7px 10px; border: 1px solid #d8dee8; border-radius: 6px; text-decoration: none; background: white; color: #485465; }
    nav a.active { border-color: #2563eb; color: #2563eb; }
    section { background: white; border: 1px solid #dde3ea; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .login { display: flex; gap: 8px; align-items: center; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid #e4e9f0; border-radius: 8px; padding: 12px; }
    .metric span { display: block; color: #667085; font-size: 13px; }
    .metric strong { display: block; margin-top: 4px; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #edf0f4; padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: #667085; font-weight: 600; }
    pre { overflow: auto; background: #101828; color: #f2f4f7; padding: 12px; border-radius: 8px; max-height: 360px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
    .toolbar h2 { flex: 1 1 180px; margin: 0; }
    .grow { flex: 1 1 220px; }
    .muted { color: #667085; }
    .error { color: #b42318; }
    .header-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .login-screen { max-width: 420px; margin: 48px auto; }
    .login-panel { display: grid; gap: 12px; }
    .login-panel input, .login-panel button { width: 100%; box-sizing: border-box; }
    .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
    .table-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .table-panel h3 { margin: 0 0 8px; font-size: 15px; }
    [hidden] { display: none !important; }
    @media (max-width: 760px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-grid { grid-template-columns: 1fr; }
      header { display: block; }
      .header-actions { margin-top: 12px; justify-content: flex-start; }
      .toolbar input, .toolbar select, .toolbar button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>TabulaBili Sync</h1>
      <div class="muted">配置同步与推荐数据上报后台</div>
    </div>
    <div class="header-actions" id="appNav" hidden>
      <nav>
        <a class="${page === 'data' ? 'active' : ''}" href="/data">数据</a>
        <a class="${page === 'analytics' ? 'active' : ''}" href="/analytics">分析</a>
      </nav>
      <button class="secondary" type="button" id="logoutBtn">退出</button>
    </div>
  </header>
  <main>
    <section class="login-screen" id="loginScreen">
      <form class="login-panel" id="loginForm">
        <h2>登录后台</h2>
        <input id="secretInput" type="password" placeholder="服务密钥" autocomplete="current-password">
        <button type="submit">登录</button>
        <p id="loginMessage" class="muted">请输入服务密钥。</p>
      </form>
    </section>
    <div id="appShell" hidden>
      <p id="message" class="muted"></p>
      ${body}
    </div>
  </main>
  <script>
    const AUTH_SESSION_KEY = 'tabulabili_sync_authenticated';
    const state = {
      secret: localStorage.getItem('tabulabili_sync_secret') || '',
      authenticated: sessionStorage.getItem(AUTH_SESSION_KEY) === '1'
    };
    const $ = (id) => document.getElementById(id);
    $('secretInput').value = state.secret;
    function setLoginMessage(text, error = false) {
      $('loginMessage').textContent = text;
      $('loginMessage').className = error ? 'error' : 'muted';
    }
    function setMessage(text, error = false) {
      $('message').textContent = text;
      $('message').className = error ? 'error' : 'muted';
    }
    async function api(path) {
      const response = await fetch(path, { headers: { Authorization: 'Bearer ' + state.secret } });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    async function download(path, filename) {
      const response = await fetch(path, { headers: { Authorization: 'Bearer ' + state.secret } });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    }
    function fmt(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
    }
    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function metric(id, value) {
      const node = $(id);
      if (node) node.textContent = String(value == null ? 0 : value);
    }
    function isUnauthorizedError(error) {
      return String(error && error.message || error).includes('unauthorized');
    }
    function showLogin(text = '请输入服务密钥。', error = false) {
      state.authenticated = false;
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      $('appNav').hidden = true;
      $('appShell').hidden = true;
      $('loginScreen').hidden = false;
      setLoginMessage(text, error);
      setTimeout(() => $('secretInput').focus(), 0);
    }
    function showApp() {
      $('loginScreen').hidden = true;
      $('appNav').hidden = false;
      $('appShell').hidden = false;
      setLoginMessage('');
    }
    $('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const secret = $('secretInput').value.trim();
      if (!secret) {
        showLogin('请输入服务密钥。', true);
        return;
      }
      setLoginMessage('正在验证。');
      try {
        const response = await fetch('/api/auth/check', { method: 'POST', headers: { Authorization: 'Bearer ' + secret } });
        if (!response.ok) throw new Error(await response.text());
        state.secret = secret;
        state.authenticated = true;
        localStorage.setItem('tabulabili_sync_secret', state.secret);
        sessionStorage.setItem(AUTH_SESSION_KEY, '1');
        showApp();
        await refresh().catch((error) => setMessage(error.message, true));
      } catch (error) {
        localStorage.removeItem('tabulabili_sync_secret');
        state.secret = '';
        showLogin('登录失败：' + error.message, true);
      }
    });
    $('logoutBtn').addEventListener('click', () => {
      localStorage.removeItem('tabulabili_sync_secret');
      state.secret = '';
      showLogin('已退出。');
    });
    ${script}
    function initAdmin() {
      if (!state.secret || !state.authenticated) {
        showLogin('请输入服务密钥。');
        return;
      }
      showApp();
      refresh().catch((error) => {
        if (isUnauthorizedError(error)) {
          localStorage.removeItem('tabulabili_sync_secret');
          state.secret = '';
          showLogin('登录状态已失效，请重新登录。', true);
          return;
        }
        setMessage(error.message, true);
      });
    }
    initAdmin();
  </script>
</body>
</html>`;
}

function dataBody() {
  return `
    <section>
      <div class="toolbar">
        <h2>概览</h2>
        <button class="secondary" type="button" id="summaryRefreshBtn">刷新概览</button>
      </div>
      <div class="grid">
        <div class="metric"><span>批次</span><strong id="batchCount">0</strong></div>
        <div class="metric"><span>事件</span><strong id="eventCount">0</strong></div>
        <div class="metric"><span>重复事件</span><strong id="duplicateCount">0</strong></div>
        <div class="metric"><span>聚合视频</span><strong id="sampleCount">0</strong></div>
      </div>
    </section>
    <section>
      <div class="toolbar">
        <h2>服务端配置</h2>
        <button class="secondary" type="button" id="configLoadBtn">查看配置</button>
      </div>
      <p class="muted" id="configStatus">未加载</p>
      <pre id="configView">{}</pre>
    </section>
    <section>
      <div class="toolbar">
        <h2>最近批次</h2>
        <select id="batchPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select>
        <button class="secondary" type="button" id="batchLoadBtn">加载最近批次</button>
      </div>
      <p class="muted" id="batchStatus">未加载</p>
      <table>
        <thead><tr><th>时间</th><th>批次</th><th>设备</th><th>事件</th><th>重复</th></tr></thead>
        <tbody id="batchRows"><tr><td class="muted" colspan="5">未加载</td></tr></tbody>
      </table>
      <div class="pager">
        <button class="secondary" type="button" id="batchPrevBtn">上一页</button>
        <span class="muted" id="batchPageInfo">第 1 页</span>
        <button class="secondary" type="button" id="batchNextBtn">下一页</button>
      </div>
    </section>
    <section>
      <div class="toolbar">
        <h2>聚合样本</h2>
        <input class="grow" id="queryInput" placeholder="搜索标题 / UP / BV">
        <select id="feedbackFilter">
          <option value="all">全部标注</option>
          <option value="unset">未标注</option>
          <option value="like">喜欢</option>
          <option value="dislike">不喜欢</option>
          <option value="neutral">一般</option>
          <option value="blocked">已屏蔽</option>
        </select>
        <select id="sampleSort">
          <option value="lastSeenAt">最近推荐</option>
          <option value="seenCount">推荐次数</option>
          <option value="clickCount">点击次数</option>
        </select>
        <select id="samplePageSize"><option value="25">25 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select>
        <button class="secondary" type="button" id="sampleLoadBtn">加载聚合样本</button>
        <button class="secondary" type="button" id="sampleApplyBtn">应用筛选</button>
        <button class="secondary" type="button" id="exportBtn">导出 JSON</button>
      </div>
      <p class="muted" id="sampleStatus">未加载</p>
      <table>
        <thead><tr><th>标题</th><th>UP 主</th><th>推荐</th><th>点击</th><th>标注</th><th>最近</th></tr></thead>
        <tbody id="sampleRows"><tr><td class="muted" colspan="6">未加载</td></tr></tbody>
      </table>
      <div class="pager">
        <button class="secondary" type="button" id="samplePrevBtn">上一页</button>
        <span class="muted" id="samplePageInfo">第 1 页</span>
        <button class="secondary" type="button" id="sampleNextBtn">下一页</button>
      </div>
    </section>`;
}

function analyticsBody() {
  return `
    <section>
      <div class="toolbar">
        <h2>分析概览</h2>
        <select id="daysInput"><option value="7">近 7 天</option><option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select>
        <select id="modeFilter">
          <option value="">全部模式</option>
          <option value="pure">pure</option>
          <option value="mixed">mixed</option>
          <option value="fusion">fusion</option>
          <option value="origin">origin</option>
          <option value="refresh">refresh</option>
        </select>
        <input id="sourceFilter" placeholder="来源">
        <input id="categoryFilter" placeholder="分类">
        <select id="analyticsFeedbackFilter">
          <option value="">全部反馈</option>
          <option value="like">like</option>
          <option value="dislike">dislike</option>
          <option value="neutral">neutral</option>
          <option value="blocked">blocked</option>
          <option value="unset">unset</option>
        </select>
        <input id="clientFilter" placeholder="clientId">
        <button class="secondary" type="button" id="analyticsRunBtn">生成分析</button>
        <button class="secondary" type="button" id="exportAnalyticsBtn">导出 JSON</button>
      </div>
      <p class="muted" id="analyticsStatus">未加载</p>
      <div class="grid">
        <div class="metric"><span>视频</span><strong id="metricSamples">0</strong></div>
        <div class="metric"><span>UP</span><strong id="metricUps">0</strong></div>
        <div class="metric"><span>曝光</span><strong id="metricImpressions">0</strong></div>
        <div class="metric"><span>点击</span><strong id="metricClicks">0</strong></div>
        <div class="metric"><span>CTR</span><strong id="metricCtr">0%</strong></div>
        <div class="metric"><span>反馈率</span><strong id="metricFeedbackRate">0%</strong></div>
        <div class="metric"><span>负反馈率</span><strong id="metricNegativeRate">0%</strong></div>
        <div class="metric"><span>重复推荐率</span><strong id="metricRepeatRate">0%</strong></div>
      </div>
    </section>
    <section>
      <h2>近期趋势</h2>
      <table>
        <thead><tr><th>日期</th><th>曝光</th><th>点击</th><th>CTR</th><th>标注</th></tr></thead>
        <tbody id="trendRows"></tbody>
      </table>
    </section>
    <section>
      <div class="toolbar">
        <h2>Top UP</h2>
        <button class="secondary" type="button" id="topRunBtn">加载 Top/重复推荐</button>
      </div>
      <p class="muted" id="topStatus">未加载</p>
      <table>
        <thead><tr><th>UP 主</th><th>样本</th><th>曝光</th><th>点击</th><th>CTR</th><th>负反馈率</th></tr></thead>
        <tbody id="topUpRows"></tbody>
      </table>
    </section>
    <section>
      <div class="toolbar">
        <h2>维度对比</h2>
        <button class="secondary" type="button" id="dimensionsRunBtn">加载维度对比</button>
      </div>
      <p class="muted" id="dimensionsStatus">未加载</p>
      <div class="table-grid">
        <div class="table-panel">
          <h3>模式</h3>
          <table>
            <thead><tr><th>模式</th><th>曝光</th><th>点击</th><th>CTR</th><th>负反馈率</th><th>均位</th></tr></thead>
            <tbody id="modeRows"></tbody>
          </table>
        </div>
        <div class="table-panel">
          <h3>来源</h3>
          <table>
            <thead><tr><th>来源</th><th>曝光</th><th>点击</th><th>CTR</th><th>负反馈率</th><th>均位</th></tr></thead>
            <tbody id="sourceRows"></tbody>
          </table>
        </div>
        <div class="table-panel">
          <h3>分类</h3>
          <table>
            <thead><tr><th>分类</th><th>曝光</th><th>点击</th><th>CTR</th><th>负反馈率</th><th>均位</th></tr></thead>
            <tbody id="categoryRows"></tbody>
          </table>
        </div>
        <div class="table-panel">
          <h3>位置</h3>
          <table>
            <thead><tr><th>位置</th><th>曝光</th><th>点击</th><th>CTR</th><th>负反馈率</th><th>均位</th></tr></thead>
            <tbody id="positionRows"></tbody>
          </table>
        </div>
      </div>
    </section>
    <section>
      <div class="toolbar">
        <h2>重复推荐视频</h2>
        <button class="secondary" type="button" id="repeatedRunBtn">加载 Top/重复推荐</button>
      </div>
      <table>
        <thead><tr><th>视频</th><th>UP 主</th><th>曝光</th><th>重复</th><th>点击</th><th>CTR</th></tr></thead>
        <tbody id="repeatedRows"></tbody>
      </table>
    </section>`;
}

function dataScript() {
  return `
    const batchState = { page: 1, pageSize: 20, hasMore: false, loaded: false };
    const sampleState = { page: 1, pageSize: 25, hasMore: false, loaded: false };
    function setStatus(id, text, error = false) {
      const node = $(id);
      if (!node) return;
      node.textContent = text;
      node.className = error ? 'error' : 'muted';
    }
    function emptyRow(columns, text) {
      return '<tr><td class="muted" colspan="' + columns + '">' + esc(text) + '</td></tr>';
    }
    async function refresh() {
      return loadSummary();
    }
    async function loadSummary() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      setMessage('正在刷新概览。');
      const summary = await api('/api/reports/summary');
      metric('batchCount', summary.batchCount);
      metric('eventCount', summary.eventCount);
      metric('duplicateCount', summary.duplicateEventCount);
      metric('sampleCount', summary.sampleCount);
      setMessage('概览已刷新。');
    }
    async function loadConfig() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      setStatus('configStatus', '加载中');
      try {
        const config = await api('/api/config');
        $('configView').textContent = JSON.stringify(config.materialized, null, 2);
        setStatus('configStatus', '已加载');
        setMessage('配置已加载。');
      } catch (error) {
        setStatus('configStatus', '加载失败：' + error.message, true);
        throw error;
      }
    }
    function renderBatchRows(items) {
      $('batchRows').innerHTML = items.length
        ? items.map((item) =>
          '<tr><td>' + esc(fmt(item.receivedAt)) + '</td><td>' + esc(item.batchId) + '</td><td>' + esc(item.clientId) + '</td><td>' + esc(item.eventCount) + '</td><td>' + esc(item.duplicateEventCount || 0) + '</td></tr>'
        ).join('')
        : emptyRow(5, '无数据');
    }
    function updateBatchPager() {
      $('batchPageInfo').textContent = batchState.loaded
        ? '第 ' + batchState.page + ' 页' + (batchState.hasMore ? '' : ' / 最后一页')
        : '第 1 页';
      $('batchPrevBtn').disabled = !batchState.loaded || batchState.page <= 1;
      $('batchNextBtn').disabled = !batchState.loaded || !batchState.hasMore;
    }
    async function loadBatches(resetPage = false) {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      batchState.pageSize = Number($('batchPageSize').value);
      if (resetPage) batchState.page = 1;
      const offset = (batchState.page - 1) * batchState.pageSize;
      setStatus('batchStatus', '加载中');
      try {
        const batches = await api('/api/reports/batches?includeTotal=0&limit=' + batchState.pageSize + '&offset=' + offset);
        batchState.loaded = true;
        batchState.hasMore = batches.hasMore === true;
        renderBatchRows(batches.items || []);
        updateBatchPager();
        setStatus('batchStatus', '已加载');
        setMessage('最近批次已加载。');
      } catch (error) {
        setStatus('batchStatus', '加载失败：' + error.message, true);
        throw error;
      }
    }
    function sampleQuery() {
      return '&q=' + encodeURIComponent($('queryInput').value.trim())
        + '&feedback=' + encodeURIComponent($('feedbackFilter').value)
        + '&sort=' + encodeURIComponent($('sampleSort').value);
    }
    function renderSampleRows(items) {
      $('sampleRows').innerHTML = items.length
        ? items.map((item) =>
          '<tr><td>' + esc(item.title || item.id) + '<div class="muted">' + esc(item.bvid || item.id || '') + '</div></td><td>' + esc(item.upName || '') + '</td><td>' + esc(item.seenCount || 0) + '</td><td>' + esc(item.clickCount || 0) + '</td><td>' + esc(item.feedback || 'unset') + '</td><td>' + esc(fmt(item.lastSeenAt)) + '</td></tr>'
        ).join('')
        : emptyRow(6, '无数据');
    }
    function updateSamplePager() {
      $('samplePageInfo').textContent = sampleState.loaded
        ? '第 ' + sampleState.page + ' 页' + (sampleState.hasMore ? '' : ' / 最后一页')
        : '第 1 页';
      $('samplePrevBtn').disabled = !sampleState.loaded || sampleState.page <= 1;
      $('sampleNextBtn').disabled = !sampleState.loaded || !sampleState.hasMore;
    }
    async function loadSamples(resetPage = false) {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      sampleState.pageSize = Number($('samplePageSize').value);
      if (resetPage) sampleState.page = 1;
      const offset = (sampleState.page - 1) * sampleState.pageSize;
      setStatus('sampleStatus', '加载中');
      try {
        const samples = await api('/api/reports/samples?includeTotal=0&limit=' + sampleState.pageSize + '&offset=' + offset + sampleQuery());
        sampleState.loaded = true;
        sampleState.hasMore = samples.hasMore === true;
        renderSampleRows(samples.items || []);
        updateSamplePager();
        setStatus('sampleStatus', '已加载');
        setMessage('聚合样本已加载。');
      } catch (error) {
        setStatus('sampleStatus', '加载失败：' + error.message, true);
        throw error;
      }
    }
    function markBatchControlsChanged() {
      batchState.page = 1;
      if (batchState.loaded) setStatus('batchStatus', '每页数量已更改，点击“加载最近批次”更新。');
      updateBatchPager();
    }
    function markSampleFiltersChanged() {
      sampleState.page = 1;
      if (sampleState.loaded) setStatus('sampleStatus', '筛选已更改，点击“应用筛选”更新。');
      updateSamplePager();
    }
    $('summaryRefreshBtn').addEventListener('click', () => loadSummary().catch((error) => setMessage(error.message, true)));
    $('configLoadBtn').addEventListener('click', () => loadConfig().catch((error) => setMessage(error.message, true)));
    $('batchLoadBtn').addEventListener('click', () => loadBatches(true).catch((error) => setMessage(error.message, true)));
    $('batchPageSize').addEventListener('change', markBatchControlsChanged);
    $('batchPrevBtn').addEventListener('click', () => {
      if (!batchState.loaded || batchState.page <= 1) return;
      batchState.page -= 1;
      loadBatches(false).catch((error) => setMessage(error.message, true));
    });
    $('batchNextBtn').addEventListener('click', () => {
      if (!batchState.loaded || !batchState.hasMore) return;
      batchState.page += 1;
      loadBatches(false).catch((error) => setMessage(error.message, true));
    });
    $('sampleLoadBtn').addEventListener('click', () => loadSamples(true).catch((error) => setMessage(error.message, true)));
    $('sampleApplyBtn').addEventListener('click', () => loadSamples(true).catch((error) => setMessage(error.message, true)));
    $('queryInput').addEventListener('input', markSampleFiltersChanged);
    $('feedbackFilter').addEventListener('change', markSampleFiltersChanged);
    $('sampleSort').addEventListener('change', markSampleFiltersChanged);
    $('samplePageSize').addEventListener('change', markSampleFiltersChanged);
    $('samplePrevBtn').addEventListener('click', () => {
      if (!sampleState.loaded || sampleState.page <= 1) return;
      sampleState.page -= 1;
      loadSamples(false).catch((error) => setMessage(error.message, true));
    });
    $('sampleNextBtn').addEventListener('click', () => {
      if (!sampleState.loaded || !sampleState.hasMore) return;
      sampleState.page += 1;
      loadSamples(false).catch((error) => setMessage(error.message, true));
    });
    $('exportBtn').addEventListener('click', () => {
      download('/api/reports/samples?limit=10000&export=1' + sampleQuery(), 'tabulabili-samples.json')
        .catch((error) => setMessage(error.message, true));
    });
    updateBatchPager();
    updateSamplePager();`;
}

function analyticsScript() {
  return `
    function pct(value) {
      return (Number(value || 0) * 100).toFixed(2) + '%';
    }
    function avg(value) {
      const number = Number(value || 0);
      return Number.isFinite(number) && number > 0 ? number.toFixed(1) : '';
    }
    function emptyRow(columns, text = '无数据') {
      return '<tr><td class="muted" colspan="' + columns + '">' + esc(text) + '</td></tr>';
    }
    function renderRows(rows, columns, render) {
      return rows && rows.length ? rows.map(render).join('') : emptyRow(columns);
    }
    function dimensionRows(rows) {
      return renderRows(rows, 6, (row) =>
        '<tr><td>' + esc(row.key) + '</td><td>' + esc(row.impressions) + '</td><td>' + esc(row.clicks) + '</td><td>' + esc(pct(row.ctr)) + '</td><td>' + esc(pct(row.negativeFeedbackRate)) + '</td><td>' + esc(avg(row.avgPosition)) + '</td></tr>'
      );
    }
    const analyticsFilters = [
      ['mode', 'modeFilter'],
      ['source', 'sourceFilter'],
      ['category', 'categoryFilter'],
      ['feedback', 'analyticsFeedbackFilter'],
      ['clientId', 'clientFilter']
    ];
    function analyticsParams(section) {
      const params = new URLSearchParams();
      params.set('days', $('daysInput').value || '30');
      params.set('tzOffsetMinutes', String(-new Date().getTimezoneOffset()));
      if (section) params.set('section', section);
      for (const item of analyticsFilters) {
        const value = $(item[1]).value.trim();
        if (value) params.set(item[0], value);
      }
      return params.toString();
    }
    const analyticsLoaded = { overview: false, dimensions: false, top: false };
    function setAnalyticsStatus(id, text, error = false) {
      const node = $(id);
      if (!node) return;
      node.textContent = text;
      node.className = error ? 'error' : 'muted';
    }
    async function refresh() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      setAnalyticsStatus('analyticsStatus', '未加载');
      setAnalyticsStatus('dimensionsStatus', '未加载');
      setAnalyticsStatus('topStatus', '未加载');
      $('trendRows').innerHTML = emptyRow(5, '未加载');
      $('topUpRows').innerHTML = emptyRow(6, '未加载');
      $('modeRows').innerHTML = emptyRow(6, '未加载');
      $('sourceRows').innerHTML = emptyRow(6, '未加载');
      $('categoryRows').innerHTML = emptyRow(6, '未加载');
      $('positionRows').innerHTML = emptyRow(6, '未加载');
      $('repeatedRows').innerHTML = emptyRow(6, '未加载');
      setMessage('点击“生成分析”后读取实时分析数据。');
    }
    function renderOverview(result) {
      const metrics = result.metrics || {};
      const hasRepeatRate = Object.hasOwn(metrics, 'repeatImpressionRate');
      metric('metricSamples', metrics.sampleCount);
      metric('metricUps', metrics.distinctUpCount);
      metric('metricImpressions', metrics.impressionCount);
      metric('metricClicks', metrics.clickCount);
      metric('metricCtr', pct(metrics.ctr));
      metric('metricFeedbackRate', pct(metrics.feedbackRate));
      metric('metricNegativeRate', pct(metrics.negativeFeedbackRate));
      metric('metricRepeatRate', hasRepeatRate ? pct(metrics.repeatImpressionRate) : '-');
      $('trendRows').innerHTML = renderRows(result.trends, 5, (row) =>
        '<tr><td>' + esc(row.date) + '</td><td>' + esc(row.impressions) + '</td><td>' + esc(row.clicks) + '</td><td>' + esc(pct(row.ctr)) + '</td><td>' + esc(row.feedbacks) + '</td></tr>'
      );
    }
    function renderDimensions(result) {
      const dimensions = result.dimensions || {};
      $('modeRows').innerHTML = dimensionRows(dimensions.modes || result.modes || []);
      $('sourceRows').innerHTML = dimensionRows(dimensions.sources || result.sources || []);
      $('categoryRows').innerHTML = dimensionRows(dimensions.categories || result.categories || []);
      $('positionRows').innerHTML = dimensionRows(dimensions.positions || result.positions || []);
    }
    function renderTop(result) {
      const top = result.top || {};
      $('topUpRows').innerHTML = renderRows(result.topUps || top.ups, 6, (row) =>
        '<tr><td>' + esc(row.upName || row.key) + '</td><td>' + esc(row.sampleCount) + '</td><td>' + esc(row.seenCount) + '</td><td>' + esc(row.clickCount) + '</td><td>' + esc(pct(row.ctr)) + '</td><td>' + esc(pct(row.negativeFeedbackRate)) + '</td></tr>'
      );
      $('repeatedRows').innerHTML = renderRows(result.repeatedSamples || top.repeatedSamples, 6, (row) =>
        '<tr><td>' + esc(row.title || row.bvid || row.sampleId) + '<div class="muted">' + esc(row.bvid || row.sampleId) + '</div></td><td>' + esc(row.upName || '') + '</td><td>' + esc(row.impressions) + '</td><td>' + esc(row.repeatImpressionCount) + '</td><td>' + esc(row.clicks) + '</td><td>' + esc(pct(row.ctr)) + '</td></tr>'
      );
    }
    async function loadAnalyticsSection(section, statusId, render, loadedMessage) {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      setAnalyticsStatus(statusId, '加载中');
      let result;
      try {
        result = await api('/api/reports/analytics?' + analyticsParams(section));
      } catch (error) {
        setAnalyticsStatus(statusId, '加载失败：' + error.message, true);
        throw error;
      }
      render(result);
      analyticsLoaded[section] = true;
      setAnalyticsStatus(statusId, '已加载');
      setMessage(loadedMessage);
    }
    function markAnalyticsFiltersChanged() {
      if (analyticsLoaded.overview) setAnalyticsStatus('analyticsStatus', '筛选已更改，点击“生成分析”更新。');
      if (analyticsLoaded.dimensions) setAnalyticsStatus('dimensionsStatus', '筛选已更改，点击“加载维度对比”更新。');
      if (analyticsLoaded.top) setAnalyticsStatus('topStatus', '筛选已更改，点击“加载 Top/重复推荐”更新。');
    }
    $('analyticsRunBtn').addEventListener('click', () => {
      loadAnalyticsSection('overview', 'analyticsStatus', renderOverview, '分析概览已生成。')
        .catch((error) => setMessage(error.message, true));
    });
    $('dimensionsRunBtn').addEventListener('click', () => {
      loadAnalyticsSection('dimensions', 'dimensionsStatus', renderDimensions, '维度对比已加载。')
        .catch((error) => setMessage(error.message, true));
    });
    $('topRunBtn').addEventListener('click', () => {
      loadAnalyticsSection('top', 'topStatus', renderTop, 'Top/重复推荐已加载。')
        .catch((error) => setMessage(error.message, true));
    });
    $('repeatedRunBtn').addEventListener('click', () => {
      loadAnalyticsSection('top', 'topStatus', renderTop, 'Top/重复推荐已加载。')
        .catch((error) => setMessage(error.message, true));
    });
    $('exportAnalyticsBtn').addEventListener('click', () => {
      download('/api/reports/analytics?' + analyticsParams(), 'tabulabili-analytics.json')
        .catch((error) => setMessage(error.message, true));
    });
    ['daysInput', 'modeFilter', 'analyticsFeedbackFilter'].forEach((id) => {
      $(id).addEventListener('change', markAnalyticsFiltersChanged);
    });
    ['sourceFilter', 'categoryFilter', 'clientFilter'].forEach((id) => {
      $(id).addEventListener('change', markAnalyticsFiltersChanged);
      $(id).addEventListener('input', markAnalyticsFiltersChanged);
    });`;
}

export { adminPage };
