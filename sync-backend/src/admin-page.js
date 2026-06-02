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
    .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
    .bar { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(120px, 3fr) 64px; gap: 10px; align-items: center; margin: 8px 0; font-size: 13px; }
    .bar-track { height: 10px; background: #edf0f4; border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: #2563eb; }
    @media (max-width: 760px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      header { display: block; }
      .login { margin-top: 12px; }
      .toolbar input, .toolbar select, .toolbar button { width: 100%; }
      .bar { grid-template-columns: 1fr; gap: 4px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>TabulaBili Sync</h1>
      <div class="muted">配置同步与推荐数据上报后台</div>
      <nav>
        <a class="${page === 'data' ? 'active' : ''}" href="/data">数据</a>
        <a class="${page === 'analytics' ? 'active' : ''}" href="/analytics">分析</a>
      </nav>
    </div>
    <form class="login" id="loginForm">
      <input id="secretInput" type="password" placeholder="服务密钥" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
  </header>
  <main>
    <p id="message" class="muted"></p>
    ${body}
  </main>
  <script>
    const state = { secret: localStorage.getItem('tabulabili_sync_secret') || '' };
    const $ = (id) => document.getElementById(id);
    $('secretInput').value = state.secret;
    function setMessage(text, error = false) {
      $('message').textContent = text;
      $('message').className = error ? 'error' : 'muted';
    }
    async function api(path) {
      const response = await fetch(path, { headers: { Authorization: 'Bearer ' + state.secret } });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
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
    $('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      state.secret = $('secretInput').value.trim();
      localStorage.setItem('tabulabili_sync_secret', state.secret);
      try {
        await fetch('/api/auth/check', { method: 'POST', headers: { Authorization: 'Bearer ' + state.secret } });
        await refresh();
      } catch (error) {
        setMessage('登录失败：' + error.message, true);
      }
    });
    ${script}
    refresh().catch(() => setMessage('请输入服务密钥。'));
  </script>
</body>
</html>`;
}

function dataBody() {
  return `
    <section>
      <h2>概览</h2>
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
        <button class="secondary" type="button" id="refreshBtn">刷新</button>
      </div>
      <pre id="configView">{}</pre>
    </section>
    <section>
      <div class="toolbar">
        <h2>最近批次</h2>
        <select id="batchPageSize"><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select>
      </div>
      <table>
        <thead><tr><th>时间</th><th>批次</th><th>设备</th><th>事件</th><th>重复</th></tr></thead>
        <tbody id="batchRows"></tbody>
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
        <button class="secondary" type="button" id="exportBtn">导出 JSON</button>
      </div>
      <table>
        <thead><tr><th>标题</th><th>UP 主</th><th>推荐</th><th>点击</th><th>标注</th><th>最近</th></tr></thead>
        <tbody id="sampleRows"></tbody>
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
        <button class="secondary" type="button" id="refreshBtn">刷新</button>
      </div>
      <div class="grid">
        <div class="metric"><span>样本</span><strong id="metricSamples">0</strong></div>
        <div class="metric"><span>推荐次数</span><strong id="metricImpressions">0</strong></div>
        <div class="metric"><span>点击次数</span><strong id="metricClicks">0</strong></div>
        <div class="metric"><span>已标注</span><strong id="metricFeedback">0</strong></div>
      </div>
    </section>
    <section>
      <h2>近期趋势</h2>
      <table>
        <thead><tr><th>日期</th><th>曝光</th><th>点击</th><th>标注</th></tr></thead>
        <tbody id="trendRows"></tbody>
      </table>
    </section>
    <section>
      <h2>Top UP</h2>
      <table>
        <thead><tr><th>UP 主</th><th>样本</th><th>推荐</th><th>点击</th></tr></thead>
        <tbody id="topUpRows"></tbody>
      </table>
    </section>
    <section>
      <h2>分布</h2>
      <div id="distributionView"></div>
    </section>`;
}

function dataScript() {
  return `
    const batchState = { page: 1, pageSize: 20, total: 0 };
    const sampleState = { page: 1, pageSize: 25, total: 0, q: '', feedback: 'all', sort: 'lastSeenAt' };
    function totalPages(state) {
      return Math.max(1, Math.ceil(state.total / state.pageSize));
    }
    async function refresh() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      const batchOffset = (batchState.page - 1) * batchState.pageSize;
      const sampleOffset = (sampleState.page - 1) * sampleState.pageSize;
      const sampleQuery = '&q=' + encodeURIComponent(sampleState.q)
        + '&feedback=' + encodeURIComponent(sampleState.feedback)
        + '&sort=' + encodeURIComponent(sampleState.sort);
      const [summary, config, batches, samples] = await Promise.all([
        api('/api/reports/summary'),
        api('/api/config'),
        api('/api/reports/batches?limit=' + batchState.pageSize + '&offset=' + batchOffset),
        api('/api/reports/samples?limit=' + sampleState.pageSize + '&offset=' + sampleOffset + sampleQuery)
      ]);
      metric('batchCount', summary.batchCount);
      metric('eventCount', summary.eventCount);
      metric('duplicateCount', summary.duplicateEventCount);
      metric('sampleCount', summary.sampleCount);
      $('configView').textContent = JSON.stringify(config.materialized, null, 2);
      batchState.total = batches.total;
      sampleState.total = samples.total;
      $('batchRows').innerHTML = batches.items.map((item) =>
        '<tr><td>' + esc(fmt(item.receivedAt)) + '</td><td>' + esc(item.batchId) + '</td><td>' + esc(item.clientId) + '</td><td>' + esc(item.eventCount) + '</td><td>' + esc(item.duplicateEventCount || 0) + '</td></tr>'
      ).join('');
      $('sampleRows').innerHTML = samples.items.map((item) =>
        '<tr><td>' + esc(item.title || item.id) + '<div class="muted">' + esc(item.bvid || item.id || '') + '</div></td><td>' + esc(item.upName || '') + '</td><td>' + esc(item.seenCount || 0) + '</td><td>' + esc(item.clickCount || 0) + '</td><td>' + esc(item.feedback || 'unset') + '</td><td>' + esc(fmt(item.lastSeenAt)) + '</td></tr>'
      ).join('');
      $('batchPageInfo').textContent = '第 ' + batchState.page + ' / ' + totalPages(batchState) + ' 页';
      $('samplePageInfo').textContent = '第 ' + sampleState.page + ' / ' + totalPages(sampleState) + ' 页';
      $('batchPrevBtn').disabled = batchState.page <= 1;
      $('batchNextBtn').disabled = batchState.page >= totalPages(batchState);
      $('samplePrevBtn').disabled = sampleState.page <= 1;
      $('sampleNextBtn').disabled = sampleState.page >= totalPages(sampleState);
      setMessage('已刷新。');
    }
    $('refreshBtn').addEventListener('click', () => refresh().catch((error) => setMessage(error.message, true)));
    $('batchPageSize').addEventListener('change', () => { batchState.pageSize = Number($('batchPageSize').value); batchState.page = 1; refresh().catch((error) => setMessage(error.message, true)); });
    $('batchPrevBtn').addEventListener('click', () => { batchState.page = Math.max(1, batchState.page - 1); refresh().catch((error) => setMessage(error.message, true)); });
    $('batchNextBtn').addEventListener('click', () => { batchState.page = Math.min(totalPages(batchState), batchState.page + 1); refresh().catch((error) => setMessage(error.message, true)); });
    let sampleSearchTimer = null;
    $('queryInput').addEventListener('input', () => {
      sampleState.q = $('queryInput').value.trim();
      sampleState.page = 1;
      clearTimeout(sampleSearchTimer);
      sampleSearchTimer = setTimeout(() => refresh().catch((error) => setMessage(error.message, true)), 220);
    });
    $('feedbackFilter').addEventListener('change', () => { sampleState.feedback = $('feedbackFilter').value; sampleState.page = 1; refresh().catch((error) => setMessage(error.message, true)); });
    $('sampleSort').addEventListener('change', () => { sampleState.sort = $('sampleSort').value; sampleState.page = 1; refresh().catch((error) => setMessage(error.message, true)); });
    $('samplePageSize').addEventListener('change', () => { sampleState.pageSize = Number($('samplePageSize').value); sampleState.page = 1; refresh().catch((error) => setMessage(error.message, true)); });
    $('samplePrevBtn').addEventListener('click', () => { sampleState.page = Math.max(1, sampleState.page - 1); refresh().catch((error) => setMessage(error.message, true)); });
    $('sampleNextBtn').addEventListener('click', () => { sampleState.page = Math.min(totalPages(sampleState), sampleState.page + 1); refresh().catch((error) => setMessage(error.message, true)); });
    $('exportBtn').addEventListener('click', () => {
      const query = '&q=' + encodeURIComponent(sampleState.q)
        + '&feedback=' + encodeURIComponent(sampleState.feedback)
        + '&sort=' + encodeURIComponent(sampleState.sort);
      window.open('/api/reports/samples?limit=10000&export=1&auth=' + encodeURIComponent(state.secret) + query, '_blank');
    });`;
}

function analyticsScript() {
  return `
    function bars(title, rows) {
      const max = Math.max(1, ...rows.map((row) => Number(row.count || row.seenCount || 0)));
      return '<h3>' + esc(title) + '</h3>' + rows.map((row) => {
        const value = Number(row.count || row.seenCount || 0);
        return '<div class="bar"><span>' + esc(row.key || row.upName || '') + '</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(value / max * 100) + '%"></div></div><strong>' + esc(value) + '</strong></div>';
      }).join('');
    }
    async function refresh() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const days = Number($('daysInput').value || 30);
      const result = await api('/api/reports/analytics?days=' + days + '&tzOffsetMinutes=' + tzOffsetMinutes);
      metric('metricSamples', result.metrics.sampleCount);
      metric('metricImpressions', result.metrics.impressionCount);
      metric('metricClicks', result.metrics.clickCount);
      metric('metricFeedback', result.metrics.feedbackCount);
      $('trendRows').innerHTML = result.trends.map((row) =>
        '<tr><td>' + esc(row.date) + '</td><td>' + esc(row.impressions) + '</td><td>' + esc(row.clicks) + '</td><td>' + esc(row.feedbacks) + '</td></tr>'
      ).join('');
      $('topUpRows').innerHTML = result.topUps.map((row) =>
        '<tr><td>' + esc(row.upName || row.key) + '</td><td>' + esc(row.sampleCount) + '</td><td>' + esc(row.seenCount) + '</td><td>' + esc(row.clickCount) + '</td></tr>'
      ).join('');
      $('distributionView').innerHTML = [
        bars('分类', result.categories || []),
        bars('来源', result.sources || []),
        bars('模式', result.modes || []),
        bars('反馈', result.feedback || [])
      ].join('');
      setMessage('已刷新。');
    }
    $('refreshBtn').addEventListener('click', () => refresh().catch((error) => setMessage(error.message, true)));
    $('daysInput').addEventListener('change', () => refresh().catch((error) => setMessage(error.message, true)));`;
}

export { adminPage };
