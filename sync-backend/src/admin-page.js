function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TabulaBili Sync</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #19202a; }
    header, main { max-width: 1120px; margin: 0 auto; padding: 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    button, input { font: inherit; }
    input { padding: 9px 10px; border: 1px solid #c9d1dc; border-radius: 6px; background: white; }
    button { padding: 9px 12px; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
    button.secondary { background: #485465; }
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
    .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
    .muted { color: #667085; }
    .error { color: #b42318; }
    @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } header { display: block; } .login { margin-top: 12px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>TabulaBili Sync</h1>
      <div class="muted">配置同步与推荐数据上报后台</div>
    </div>
    <form class="login" id="loginForm">
      <input id="secretInput" type="password" placeholder="服务密钥" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>
  </header>
  <main>
    <p id="message" class="muted"></p>
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
        <h2 style="flex:1">服务端配置</h2>
        <button class="secondary" type="button" id="refreshBtn">刷新</button>
      </div>
      <pre id="configView">{}</pre>
    </section>
    <section>
      <h2>最近批次</h2>
      <table>
        <thead><tr><th>时间</th><th>批次</th><th>设备</th><th>事件</th></tr></thead>
        <tbody id="batchRows"></tbody>
      </table>
    </section>
    <section>
      <div class="toolbar">
        <h2 style="flex:1">聚合样本</h2>
        <input id="queryInput" placeholder="搜索标题/UP/BV">
        <button class="secondary" type="button" id="exportBtn">导出 JSON</button>
      </div>
      <table>
        <thead><tr><th>标题</th><th>UP 主</th><th>推荐</th><th>最近</th></tr></thead>
        <tbody id="sampleRows"></tbody>
      </table>
    </section>
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

    async function refresh() {
      if (!state.secret) {
        setMessage('请输入服务密钥。');
        return;
      }
      const [summary, config, batches, samples] = await Promise.all([
        api('/api/reports/summary'),
        api('/api/config'),
        api('/api/reports/batches?limit=20'),
        api('/api/reports/samples?limit=50&q=' + encodeURIComponent($('queryInput').value.trim()))
      ]);
      $('batchCount').textContent = summary.batchCount;
      $('eventCount').textContent = summary.eventCount;
      $('duplicateCount').textContent = summary.duplicateEventCount;
      $('sampleCount').textContent = summary.sampleCount;
      $('configView').textContent = JSON.stringify(config.materialized, null, 2);
      $('batchRows').innerHTML = batches.items.map((item) =>
        '<tr><td>' + fmt(item.receivedAt) + '</td><td>' + item.batchId + '</td><td>' + item.clientId + '</td><td>' + item.eventCount + '</td></tr>'
      ).join('');
      $('sampleRows').innerHTML = samples.items.map((item) =>
        '<tr><td>' + (item.title || item.id) + '<div class="muted">' + (item.bvid || '') + '</div></td><td>' + (item.upName || '') + '</td><td>' + item.seenCount + '</td><td>' + fmt(item.lastSeenAt) + '</td></tr>'
      ).join('');
      setMessage('已刷新。');
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
    $('refreshBtn').addEventListener('click', () => refresh().catch((error) => setMessage(error.message, true)));
    $('queryInput').addEventListener('change', () => refresh().catch((error) => setMessage(error.message, true)));
    $('exportBtn').addEventListener('click', () => {
      window.open('/api/reports/samples?limit=10000&export=1&auth=' + encodeURIComponent(state.secret), '_blank');
    });
    refresh().catch(() => setMessage('请输入服务密钥。'));
  </script>
</body>
</html>`;
}

export { adminPage };
