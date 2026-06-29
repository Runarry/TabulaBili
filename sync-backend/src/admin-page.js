function adminPage(activePage = 'data') {
  const page = ['analytics', 'up-profiles', 'sync'].includes(activePage) ? activePage : 'data';
  const body = page === 'analytics' ? analyticsBody() : (page === 'up-profiles' ? upProfilesBody() : (page === 'sync' ? syncBody() : dataBody()));
  const script = page === 'analytics' ? analyticsScript() : (page === 'up-profiles' ? upProfilesScript() : (page === 'sync' ? syncScript() : dataScript()));
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
    button, input, select, textarea { font: inherit; }
    input, select, textarea { padding: 9px 10px; border: 1px solid #c9d1dc; border-radius: 6px; background: white; box-sizing: border-box; }
    textarea { min-height: 90px; resize: vertical; }
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
        <a class="${page === 'up-profiles' ? 'active' : ''}" href="/up-profiles">UP画像</a>
        <a class="${page === 'sync' ? 'active' : ''}" href="/sync">同步</a>
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

function upProfilesBody() {
  return `
    <section>
      <div class="toolbar">
        <h2>UP画像采集</h2>
        <input class="grow" id="upImportInput" placeholder="输入 UID，支持逗号或换行分隔">
        <button type="button" id="upImportBtn">导入 UID</button>
        <button class="secondary" type="button" id="collectorRunBtn">运行一批采集</button>
      </div>
      <p class="muted" id="upActionStatus">未执行</p>
    </section>
    <section>
      <div class="toolbar">
        <h2>目标列表</h2>
        <input class="grow" id="upQueryInput" placeholder="搜索 UID / 昵称 / 摘要">
        <select id="upSort">
          <option value="updated">最近更新</option>
          <option value="followers">粉丝数</option>
          <option value="videos">视频数</option>
          <option value="collected">最近采集</option>
          <option value="name">昵称</option>
        </select>
        <select id="upPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option></select>
        <button class="secondary" type="button" id="upLoadBtn">加载列表</button>
      </div>
      <p class="muted" id="upListStatus">未加载</p>
      <table>
        <thead><tr><th>UP</th><th>状态</th><th>粉丝/视频</th><th>画像摘要</th><th>操作</th></tr></thead>
        <tbody id="upRows"><tr><td class="muted" colspan="5">未加载</td></tr></tbody>
      </table>
      <div class="pager">
        <button class="secondary" type="button" id="upPrevBtn">上一页</button>
        <span class="muted" id="upPageInfo">第 1 页</span>
        <button class="secondary" type="button" id="upNextBtn">下一页</button>
      </div>
    </section>
    <section>
      <div class="toolbar">
        <h2>画像详情</h2>
        <span class="muted" id="upDetailTitle">未选择</span>
      </div>
      <pre id="upDetailView">{}</pre>
    </section>`;
}

function syncBody() {
  return `
    <section>
      <div class="toolbar">
        <h2>数据同步</h2>
        <button class="secondary" type="button" id="syncManifestBtn">读取源端</button>
        <button type="button" id="syncPullBtn">开始拉取</button>
        <button class="secondary" type="button" id="syncContinueBtn" disabled>继续拉取</button>
        <button class="secondary" type="button" id="syncClearBtn">清空结果</button>
      </div>
      <div class="table-grid">
        <div class="table-panel">
          <h3>源端</h3>
          <div class="toolbar">
            <input class="grow" id="syncSourceUrl" placeholder="源后端 URL">
            <input class="grow" id="syncSourceSecret" type="password" placeholder="源端密钥；留空则使用当前密钥" autocomplete="off">
          </div>
          <div class="toolbar">
            <select id="syncLimit">
              <option value="100">100 条/页</option>
              <option value="200" selected>200 条/页</option>
              <option value="500">500 条/页</option>
              <option value="1000">1000 条/页</option>
            </select>
            <input id="syncMaxPages" type="number" min="1" max="500" value="50" placeholder="最大页数">
          </div>
          <p class="muted" id="syncSourceStatus">未读取</p>
        </div>
        <div class="table-panel">
          <h3>数据集</h3>
          <div class="toolbar" id="syncDatasetList"></div>
          <textarea id="syncCursorsInput" placeholder='续跑游标 JSON，例如 {"report_events":"400"}'></textarea>
        </div>
      </div>
    </section>
    <section>
      <div class="toolbar">
        <h2>同步结果</h2>
        <span class="muted" id="syncResultStatus">未执行</span>
      </div>
      <div class="grid">
        <div class="metric"><span>读取</span><strong id="syncReadCount">0</strong></div>
        <div class="metric"><span>写入</span><strong id="syncWrittenCount">0</strong></div>
        <div class="metric"><span>跳过</span><strong id="syncSkippedCount">0</strong></div>
        <div class="metric"><span>错误</span><strong id="syncErrorCount">0</strong></div>
      </div>
      <table>
        <thead><tr><th>数据集</th><th>页数</th><th>读取</th><th>写入</th><th>新增</th><th>更新</th><th>跳过</th><th>错误</th></tr></thead>
        <tbody id="syncStatsRows"><tr><td class="muted" colspan="8">未执行</td></tr></tbody>
      </table>
      <pre id="syncResultView">{}</pre>
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

function upProfilesScript() {
  return `
    const upState = { page: 1, pageSize: 20, hasMore: false, loaded: false };
    function setUpStatus(id, text, error = false) {
      const node = $(id);
      if (!node) return;
      node.textContent = text;
      node.className = error ? 'error' : 'muted';
    }
    function emptyUpRow(text) {
      return '<tr><td class="muted" colspan="5">' + esc(text) + '</td></tr>';
    }
    async function postApi(path, body = {}) {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + state.secret,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error([payload.message || payload.error || text || response.statusText, payload.hint].filter(Boolean).join('。'));
        error.payload = payload;
        throw error;
      }
      return payload;
    }
    async function refresh() {
      return loadUps(true);
    }
    function upParams() {
      const params = new URLSearchParams();
      params.set('includeTotal', '0');
      params.set('limit', String(upState.pageSize));
      params.set('offset', String((upState.page - 1) * upState.pageSize));
      const q = $('upQueryInput').value.trim();
      if (q) params.set('q', q);
      const sort = $('upSort').value;
      if (sort) params.set('sort', sort);
      return params.toString();
    }
    function updateUpPager() {
      $('upPageInfo').textContent = upState.loaded
        ? '第 ' + upState.page + ' 页' + (upState.hasMore ? '' : ' / 最后一页')
        : '第 1 页';
      $('upPrevBtn').disabled = !upState.loaded || upState.page <= 1;
      $('upNextBtn').disabled = !upState.loaded || !upState.hasMore;
    }
    function renderUpRows(items) {
      $('upRows').innerHTML = items.length ? items.map((item) => {
        const target = item.target || {};
        return '<tr>'
          + '<td><strong>' + esc(item.name || target.name || item.mid) + '</strong><div class="muted">' + esc(item.mid) + '</div></td>'
          + '<td>' + esc(target.status || '') + '<div class="muted">' + esc(target.lastErrorType || '') + '</div></td>'
          + '<td>' + esc(item.followerCount || 0) + '<div class="muted">视频 ' + esc(item.videoCount || 0) + '</div></td>'
          + '<td>' + esc(item.summary || '') + '</td>'
          + '<td><button class="secondary" type="button" data-action="collect" data-mid="' + esc(item.mid) + '">采集</button> '
          + '<button class="secondary" type="button" data-action="portrait" data-mid="' + esc(item.mid) + '">LLM</button> '
          + '<button class="secondary" type="button" data-action="detail" data-mid="' + esc(item.mid) + '">详情</button></td>'
          + '</tr>';
      }).join('') : emptyUpRow('无数据');
    }
    async function loadUps(resetPage = false) {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      upState.pageSize = Number($('upPageSize').value);
      if (resetPage) upState.page = 1;
      setUpStatus('upListStatus', '加载中');
      const result = await api('/api/up-profiles?' + upParams());
      upState.loaded = true;
      upState.hasMore = result.hasMore === true;
      renderUpRows(result.items || []);
      updateUpPager();
      setUpStatus('upListStatus', '已加载');
      setMessage('UP画像列表已加载。');
    }
    async function importUps() {
      const mids = $('upImportInput').value.trim();
      if (!mids) {
        setUpStatus('upActionStatus', '请输入 UID。', true);
        return;
      }
      setUpStatus('upActionStatus', '导入中');
      const result = await postApi('/api/up-targets/import', { mids });
      setUpStatus('upActionStatus', '已导入 ' + result.imported + ' 个，已存在 ' + result.existing + ' 个。');
      await loadUps(true);
    }
    async function runCollector() {
      setUpStatus('upActionStatus', '采集中');
      const result = await postApi('/api/collector/run', { maxTargets: 1, includeArchives: false, maxPages: 0, maxVideos: 5, requestIntervalMs: 3000 });
      setUpStatus('upActionStatus', '采集完成：' + (result.results || []).length + ' 个目标。');
      await loadUps(false);
    }
    async function collectOne(mid) {
      setUpStatus('upActionStatus', '采集中：' + mid);
      try {
        await postApi('/api/up-targets/' + encodeURIComponent(mid) + '/collect', { includeArchives: false, maxPages: 0, maxVideos: 5, requestIntervalMs: 3000 });
        setUpStatus('upActionStatus', '采集完成：' + mid);
      } catch (error) {
        setUpStatus('upActionStatus', '采集失败：' + error.message, true);
      } finally {
        await loadUps(false);
      }
    }
    async function generatePortrait(mid) {
      setUpStatus('upActionStatus', 'LLM 分析中：' + mid);
      try {
        await postApi('/api/up-profiles/' + encodeURIComponent(mid) + '/portrait/generate', {});
        setUpStatus('upActionStatus', 'LLM 分析完成：' + mid);
      } catch (error) {
        setUpStatus('upActionStatus', 'LLM 分析失败：' + error.message, true);
      }
      await loadDetail(mid);
      await loadUps(false);
    }
    async function loadDetail(mid) {
      $('upDetailTitle').textContent = mid;
      const detail = await api('/api/up-profiles/' + encodeURIComponent(mid));
      $('upDetailView').textContent = JSON.stringify(detail, null, 2);
    }
    $('upImportBtn').addEventListener('click', () => importUps().catch((error) => setMessage(error.message, true)));
    $('collectorRunBtn').addEventListener('click', () => runCollector().catch((error) => setMessage(error.message, true)));
    $('upLoadBtn').addEventListener('click', () => loadUps(true).catch((error) => setMessage(error.message, true)));
    $('upQueryInput').addEventListener('input', () => {
      upState.page = 1;
      if (upState.loaded) setUpStatus('upListStatus', '筛选已更改，点击“加载列表”更新。');
      updateUpPager();
    });
    $('upSort').addEventListener('change', () => loadUps(true).catch((error) => setMessage(error.message, true)));
    $('upPageSize').addEventListener('change', () => loadUps(true).catch((error) => setMessage(error.message, true)));
    $('upPrevBtn').addEventListener('click', () => {
      if (!upState.loaded || upState.page <= 1) return;
      upState.page -= 1;
      loadUps(false).catch((error) => setMessage(error.message, true));
    });
    $('upNextBtn').addEventListener('click', () => {
      if (!upState.loaded || !upState.hasMore) return;
      upState.page += 1;
      loadUps(false).catch((error) => setMessage(error.message, true));
    });
    $('upRows').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const mid = button.getAttribute('data-mid');
      const action = button.getAttribute('data-action');
      if (action === 'collect') collectOne(mid).catch((error) => setMessage(error.message, true));
      if (action === 'portrait') generatePortrait(mid).catch((error) => setMessage(error.message, true));
      if (action === 'detail') loadDetail(mid).catch((error) => setMessage(error.message, true));
    });
    updateUpPager();`;
}

function syncScript() {
  return `
    const syncDatasets = [
      'config',
      'report_batches',
      'report_events',
      'report_samples',
      'daily_metrics',
      'up_targets',
      'up_profile_snapshots',
      'up_videos',
      'video_metric_snapshots',
      'collector_runs',
      'up_portraits'
    ];
    const syncDatasetLabels = {
      config: '配置',
      report_batches: '批次',
      report_events: '事件',
      report_samples: '样本',
      daily_metrics: '日报',
      up_targets: 'UP目标',
      up_profile_snapshots: 'UP资料',
      up_videos: 'UP视频',
      video_metric_snapshots: '视频指标',
      collector_runs: '采集记录',
      up_portraits: '画像'
    };
    const syncState = { lastResult: null, lastNext: null };
    function setSyncStatus(id, text, error = false) {
      const node = $(id);
      if (!node) return;
      node.textContent = text;
      node.className = error ? 'error' : 'muted';
    }
    function sourceBaseUrl() {
      return $('syncSourceUrl').value.trim();
    }
    function sourceSecret() {
      return $('syncSourceSecret').value.trim() || state.secret;
    }
    function sourceApiUrl(path) {
      const base = sourceBaseUrl();
      if (!base) throw new Error('请输入源后端 URL。');
      const url = new URL(base);
      url.hash = '';
      url.search = '';
      url.pathname = url.pathname.replace(/\\/+$/, '') + path;
      return url.toString();
    }
    async function postJson(path, body = {}) {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + state.secret,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const error = new Error(payload.message || payload.error || text || response.statusText);
        error.payload = payload;
        throw error;
      }
      return payload;
    }
    function renderDatasetList(available = syncDatasets) {
      const availableSet = new Set(available);
      $('syncDatasetList').innerHTML = syncDatasets.map((dataset) => {
        const disabled = availableSet.has(dataset) ? '' : ' disabled';
        const checked = availableSet.has(dataset) ? ' checked' : '';
        return '<label><input type="checkbox" class="sync-dataset" value="' + esc(dataset) + '"' + checked + disabled + '> ' + esc(syncDatasetLabels[dataset] || dataset) + '</label>';
      }).join('');
    }
    function selectedDatasets() {
      return [...document.querySelectorAll('.sync-dataset')]
        .filter((node) => node.checked && !node.disabled)
        .map((node) => node.value);
    }
    function parseCursors() {
      const text = $('syncCursorsInput').value.trim();
      if (!text) return {};
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function buildPullBody(useNext = false) {
      const datasets = useNext && syncState.lastNext ? syncState.lastNext.datasets : selectedDatasets();
      if (!datasets.length) throw new Error('请选择数据集。');
      return {
        sourceUrl: sourceBaseUrl(),
        sourceSecret: sourceSecret(),
        limit: Number($('syncLimit').value || 200),
        maxPages: Number($('syncMaxPages').value || 50),
        datasets,
        cursors: useNext && syncState.lastNext ? syncState.lastNext.cursors : parseCursors()
      };
    }
    function emptyStatsRow(text) {
      return '<tr><td class="muted" colspan="8">' + esc(text) + '</td></tr>';
    }
    function renderSyncResult(result) {
      syncState.lastResult = result;
      syncState.lastNext = result && result.next || null;
      const total = result && result.stats && result.stats.total || {};
      metric('syncReadCount', total.read || 0);
      metric('syncWrittenCount', total.written || 0);
      metric('syncSkippedCount', total.skipped || 0);
      metric('syncErrorCount', total.errorCount || 0);
      const datasets = result && result.stats && result.stats.datasets || {};
      const names = syncDatasets.filter((name) => Object.hasOwn(datasets, name));
      $('syncStatsRows').innerHTML = names.length ? names.map((name) => {
        const row = datasets[name] || {};
        return '<tr><td>' + esc(syncDatasetLabels[name] || name) + '<div class="muted">' + esc(name) + '</div></td>'
          + '<td>' + esc(row.pages || 0) + '</td>'
          + '<td>' + esc(row.read || 0) + '</td>'
          + '<td>' + esc(row.written || 0) + '</td>'
          + '<td>' + esc(row.inserted || 0) + '</td>'
          + '<td>' + esc(row.updated || 0) + '</td>'
          + '<td>' + esc(row.skipped || 0) + '</td>'
          + '<td>' + esc(row.errorCount || 0) + '</td></tr>';
      }).join('') : emptyStatsRow('无数据');
      $('syncResultView').textContent = JSON.stringify(result || {}, null, 2);
      $('syncContinueBtn').disabled = !syncState.lastNext;
      if (syncState.lastNext) {
        $('syncCursorsInput').value = JSON.stringify(syncState.lastNext.cursors || {}, null, 2);
        setSyncStatus('syncResultStatus', '未完成，可继续拉取。');
      } else if (result) {
        setSyncStatus('syncResultStatus', '已完成。');
      }
    }
    async function loadSourceManifest() {
      const url = sourceApiUrl('/api/sync/export');
      setSyncStatus('syncSourceStatus', '读取中');
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + sourceSecret() } });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(payload.message || payload.error || text || response.statusText);
      renderDatasetList(payload.datasets || syncDatasets);
      setSyncStatus('syncSourceStatus', '已读取：v' + (payload.version || 1) + '，' + (payload.datasets || []).length + ' 个数据集。');
      setMessage('源端数据集已读取。');
    }
    async function pullSync(useNext = false) {
      setSyncStatus('syncResultStatus', useNext ? '继续拉取中' : '拉取中');
      const result = await postJson('/api/sync/pull', buildPullBody(useNext));
      renderSyncResult(result);
      setMessage(result.complete ? '同步完成。' : '同步未完成，可继续拉取。');
    }
    function clearSyncResult() {
      syncState.lastResult = null;
      syncState.lastNext = null;
      metric('syncReadCount', 0);
      metric('syncWrittenCount', 0);
      metric('syncSkippedCount', 0);
      metric('syncErrorCount', 0);
      $('syncStatsRows').innerHTML = emptyStatsRow('未执行');
      $('syncResultView').textContent = '{}';
      $('syncCursorsInput').value = '';
      $('syncContinueBtn').disabled = true;
      setSyncStatus('syncResultStatus', '未执行');
    }
    async function refresh() {
      renderDatasetList(syncDatasets);
      clearSyncResult();
      setMessage('同步页已就绪。');
    }
    $('syncManifestBtn').addEventListener('click', () => {
      loadSourceManifest().catch((error) => {
        setSyncStatus('syncSourceStatus', '读取失败：' + error.message, true);
        setMessage(error.message, true);
      });
    });
    $('syncPullBtn').addEventListener('click', () => {
      pullSync(false).catch((error) => {
        setSyncStatus('syncResultStatus', '同步失败：' + error.message, true);
        $('syncResultView').textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
        setMessage(error.message, true);
      });
    });
    $('syncContinueBtn').addEventListener('click', () => {
      pullSync(true).catch((error) => {
        setSyncStatus('syncResultStatus', '续跑失败：' + error.message, true);
        $('syncResultView').textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
        setMessage(error.message, true);
      });
    });
    $('syncClearBtn').addEventListener('click', clearSyncResult);
    renderDatasetList(syncDatasets);`;
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
