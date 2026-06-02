# TabulaBili Sync Backend

自托管配置同步与推荐数据上报服务。后台使用一个服务密钥保护，适合个人部署。

## API

所有 `/api/*` 请求都需要：

```http
Authorization: Bearer <SYNC_SECRET>
```

- `POST /api/auth/check`
- `POST /api/config/sync`
- `GET /api/config`
- `POST /api/reports`
- `GET /api/reports/summary`
- `GET /api/reports/samples`
- `GET /api/reports/events?sampleId=<id>`
- `GET /api/reports/samples/<sampleId>/events`
- `GET /api/reports/batches`
- `GET /api/reports/analytics`
- `POST /api/reports/cleanup`

### 数据统计接口

`GET /api/reports/analytics` 支持：

- `days`：统计最近 1-90 天。
- `tzOffsetMinutes`：趋势日期使用的时区偏移。
- `clientId`、`mode`、`source`、`category`、`feedback`：维度筛选。

返回值中的核心指标：

- `impressionCount`：范围内曝光事件数。
- `clickCount`：范围内点击事件数。
- `feedbackCount`：范围内反馈事件数。
- `distinctSampleCount`：范围内出现过的视频数。
- `distinctUpCount`：范围内出现过的 UP 数。
- `ctr`：`clickCount / impressionCount`。
- `feedbackRate`：`feedbackCount / impressionCount`。
- `negativeFeedbackRate`：`dislike + blocked` 反馈占曝光比例。
- `repeatImpressionRate`：同一视频重复曝光占曝光比例。

`GET /api/reports/samples` 支持分页、搜索、标注筛选，并可按 `mode`、`source`、`category`、`upMid`、`upName`、`minSeenCount`、`minClickCount`、`since`、`until`、`hasFeedback` 过滤。排序支持 `lastSeenAt`、`seenCount`、`clickCount`、`ctr`、`negativeFeedback`、`repeatCount`、`firstSeenAt`、`lastClickedAt`。

### 数据保留与清理

后端不会自动删除数据。建议根据 D1/SQLite 数据量定期备份并清理旧明细事件。

清理接口默认 dry run，不会删除数据：

```http
POST /api/reports/cleanup
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{
  "before": "2026-01-01T00:00:00.000Z",
  "dryRun": true
}
```

确认返回的 `matched` 数量后，将 `dryRun` 设置为 `false` 才会删除：

- `events.captured_at < before` 的事件明细。
- `batches.received_at < before` 的批次记录。
- 没有任何剩余事件关联的样本聚合。

如果请求体不提供 `before`，可以提供 `retentionDays`，默认按 365 天计算清理边界。

### Schema 迁移

D1 和 SQLite 会在启动或首次访问时自动创建表、补齐缺失列和索引，并在 `schema_migrations` 中记录已应用版本。当前记录：

- `1 base_tables`
- `2 structured_event_columns`
- `3 sample_timestamps`

重复运行初始化是幂等的，不需要手动执行 SQL migration。

### 隐私说明

上报数据包含推荐视频 ID、标题、UP、分类、展示位置、点击与反馈等分析字段。服务使用单个 `SYNC_SECRET` 保护，适合个人自托管；不要与不可信用户共享后台地址或密钥。管理页会把密钥保存在浏览器 `localStorage`，公共设备上使用后应清除站点数据。

## Docker + SQLite

1. 修改 `docker-compose.yml` 中的 `SYNC_SECRET`。
2. 启动：

```bash
docker compose up -d --build
```

3. 打开 `http://localhost:8787`，输入服务密钥登录。

SQLite 数据保存在 `tabulabili-sync-data` volume 中。需要备份时备份 `/data/tabulabili-sync.db` 及同目录 WAL 文件。

## Cloudflare Worker + D1

1. 创建 D1 database：

```bash
npx wrangler d1 create tabulabili-sync
```

2. 在 Cloudflare Dashboard 的 Worker 设置中添加 D1 绑定：

- Binding name: `TABULABILI_SYNC_DB`
- D1 database: 选择刚创建的 `tabulabili-sync`

3. 在 Cloudflare Dashboard 的 Worker 环境变量中添加密钥：

- Variable name: `SYNC_SECRET`
- Value: 使用长随机字符串
- 建议设置为 Secret/Encrypted 类型

也可以用命令设置密钥：

```bash
npx wrangler secret put SYNC_SECRET
```

4. 部署：

```bash
npm install
npx wrangler deploy
```

D1 表和索引会在 Worker 首次访问时自动创建。旧 KV 数据不会自动迁移到 D1。

## Cloudflare Dashboard 纯后台部署

这个流程不需要把 D1 database id 或密钥写进 `wrangler.toml`。所有运行时配置都在 Cloudflare 后台完成。

### 1. 创建 D1

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages` -> `D1`。
3. 创建一个 database，例如 `tabulabili-sync`。

### 2. 创建 Worker

1. 进入 `Workers & Pages`。
2. 点击 `Create` -> `Worker`。
3. 创建 Worker，例如命名为 `tabulabili-sync`。
4. 暂时保留默认代码，后续用部署命令上传项目代码。

### 3. 绑定 D1

1. 打开刚创建的 Worker。
2. 进入 `Settings` -> `Bindings`。
3. 添加 `D1 database binding`。
4. 设置：

- Variable name: `TABULABILI_SYNC_DB`
- D1 database: 选择刚创建的 `tabulabili-sync`

### 4. 设置密钥

1. 仍在 Worker 的 `Settings` 页面。
2. 进入 `Variables and Secrets`。
3. 添加 Secret：

- Name: `SYNC_SECRET`
- Value: 使用长随机字符串

这个密钥就是后台页面登录密钥，也是扩展端同步密钥。

### 5. 上传 Worker 代码

在 `sync-backend/` 目录运行：

```bash
npm install
npx wrangler deploy
```

这里的 `wrangler.toml` 只提供 Worker 名称和入口文件。D1 绑定与 `SYNC_SECRET` 已经在 Cloudflare 后台设置，不需要写入配置文件。

### 6. 验证后台

1. 打开 Worker 地址，例如 `https://tabulabili-sync.<account>.workers.dev`。
2. 输入 `SYNC_SECRET` 登录。
3. `/data` 能看到配置、批次和样本，`/analytics` 能看到分析页面即部署成功。

### 7. 配置扩展

在扩展设置页的“同步与上报”区域填写：

- 后端 URL：Worker 地址，例如 `https://tabulabili-sync.<account>.workers.dev`
- 服务密钥：`SYNC_SECRET`
- 开启同步与上报
- 点击“立即同步”测试连接

## 扩展端配置

在扩展设置页的“同步与上报”区域填写：

- 后端 URL：Docker 示例 `http://localhost:8787`，Worker 示例 `https://<worker>.<account>.workers.dev`
- 服务密钥：部署时配置的 `SYNC_SECRET`
- 开启同步与上报
- 设置上报频率

未配置后端时，扩展仍保持原有本地设置、统计和导出能力。
