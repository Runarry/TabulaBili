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
- `POST /api/reports/bulk`
- `GET /api/reports/summary`
- `GET /api/reports/samples`
- `GET /api/reports/events?sampleId=<id>`
- `GET /api/reports/samples/<sampleId>/events`
- `GET /api/reports/batches`
- `GET /api/reports/analytics`
- `POST /api/reports/cleanup`
- `POST /api/up-targets/import`
- `GET /api/up-targets`
- `POST /api/up-targets/<mid>/collect`
- `POST /api/collector/run`
- `GET /api/up-profiles`
- `GET /api/up-profiles/<mid>`
- `POST /api/up-profiles/<mid>/portrait/generate`
- `GET /api/up-videos?mid=<mid>`

### 批量上报接口

`POST /api/reports/bulk` 可以在一次请求中提交多个原始上报批次，后台仍按每个 `batchId` 独立保存和去重。单次请求最多 50 个批次、2000 个事件；超出限制会返回 `400`。

```http
POST /api/reports/bulk
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{
  "batches": [
    {
      "batchId": "client:batch-hash",
      "clientId": "client",
      "capturedAt": "2026-06-01T00:00:00.000Z",
      "events": []
    }
  ]
}
```

返回值会汇总本次处理的批次数、事件数和重复数据，并在 `results` 中列出每个批次的保存结果。旧版后台不支持该接口时，扩展端会自动回退到 `POST /api/reports` 逐批上报。

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

`daily_metrics` 每日汇总表不会被 cleanup 删除，用于在清理明细事件后保留长期趋势基础数据。

### UP 主画像采集

后端提供独立的 UP 主画像采集链路。采集由后端主动执行，不依赖浏览器扩展参与；扩展端最多可以作为 UID/BVID 种子来源。当前实现优先面向 Node/Docker + SQLite 部署，Cloudflare Worker + D1 保持 schema 和 API 兼容，但不建议让 Worker 承担主动采集任务。

采集只读取 B站公开可见字段，不使用 Cookie，不绕过登录或风控。客户端封装了 User-Agent、Referer、超时、业务错误解析，并将 `-799`、`-352`、HTTP `412/429` 等错误分类为限频或风控失败。采集器会记录失败类型、失败消息、失败次数和 `nextCollectAfter`，遇到限频/风控会指数退避；单次任务也有最大 UP 数、最大页数和最大视频数限制，避免高频扫描。

默认采集策略是“资料优先、已知视频增强”：先抓 `card`、`relation/stat`、`space/navnum` 三个公开资料接口，再用目标的 `seedBvid` 以及历史推荐样本/已入库视频中的 BVID 补全视频详情和标签。默认不会访问 `/x/space/arc/search` 投稿列表，因为该接口即使单个 UP、无 Cookie、低频访问也可能返回 HTTP `412` 或 `-799`；投稿列表只作为显式开启的增强项使用。

推荐的最小流程：

```http
POST /api/up-targets/import
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{ "mids": ["12345", "67890"], "source": "manual", "seedBvid": "BV1xx411c7mD" }
```

随后低频触发一批到期任务：

```http
POST /api/collector/run
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{ "maxTargets": 1, "includeArchives": false, "maxPages": 0, "maxVideos": 10 }
```

也可以手动采集单个 UP：

```http
POST /api/up-targets/12345/collect
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{ "includeArchives": false, "maxPages": 0, "maxVideos": 10 }
```

如果确实需要从投稿列表发现新视频，可以在低频、很小页数下显式开启：

```http
POST /api/up-targets/12345/collect
Authorization: Bearer <SYNC_SECRET>
Content-Type: application/json

{ "includeArchives": true, "maxPages": 1, "pageSize": 5, "maxVideos": 5, "requestIntervalMs": 3000 }
```

这个模式命中风控时不会回滚已保存的 UP 基础资料；任务会标记为 `partial`，记录错误和退避时间，后续可重试或改用 BVID 种子。

查询画像与视频：

- `GET /api/up-targets`：目标 UID、采集状态、失败和退避信息。
- `GET /api/up-profiles`：UP 列表、粉丝/视频概览、画像摘要，支持 `q`、分页和排序。
- `GET /api/up-profiles/<mid>`：目标、最新基础资料、视频统计、规则画像和 LLM 画像。
- `GET /api/up-videos?mid=<mid>`：某 UP 的视频事实列表。

规则画像会基于已入库视频计算主分区、高频标签/关键词、发稿频率、近 7/30/90 天活跃度、中位/平均播放、爆款率、点赞/投币/收藏/评论/弹幕/分享率、系列化倾向和商业合作关键词线索。

### LLM Provider

LLM 分析使用 OpenAI-compatible Chat Completions 抽象，不把 DeepSeek 写死在业务逻辑里。模型输入只包含已采集的结构化事实、近期视频摘要和规则画像，不直接发送原始大 JSON。

环境变量：

```bash
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=<your-api-key>
LLM_MODEL=deepseek-chat
LLM_TIMEOUT_MS=30000
```

触发分析：

```http
POST /api/up-profiles/12345/portrait/generate
Authorization: Bearer <SYNC_SECRET>
```

结果保存到 `up_portraits`，字段包括 `summary`、`contentPositioning`、`audienceHypothesis`、`contentStyle`、`commercialFit`、`risks`、`evidence`、`provider`、`model`、`promptVersion` 和 `generatedAt`。其中 `audienceHypothesis` 明确要求模型按推断表述。LLM 调用失败会保存 `llm_error_type` 和 `llm_error_message`，不会删除已生成的规则画像，后续可以重试。

### Schema 迁移

D1 推荐在部署前执行 `migrations/` 目录下的迁移。运行时仍保留兼容性的自动创建和补齐逻辑，但只在写入、配置保存和清理这些会修改数据的路径上触发；读接口在空库或未建表时会直接返回空结果，不承担建表成本。Worker 同一 isolate 内只会初始化一次；如果 `schema_migrations` 已记录最新版本，会快速跳过完整 DDL/索引检查。SQLite 仍在启动时自动创建表、补齐缺失列和索引。当前记录：

- `1 base_tables`
- `2 structured_event_columns`
- `3 sample_timestamps`
- `4 daily_metrics`
- `5 analytics_indexes`
- `6 drop_events_up_name_index`
- `7 report_totals`
- `8 up_portrait_collector`

重复运行初始化是幂等的。新 D1 部署建议优先执行 migration，避免首次写入请求承担完整 schema 初始化成本。

### 性能说明

后端写入事件时会同步维护 `daily_metrics` 汇总表，维度包括 `date`、`clientId`、`mode`、`source` 和 `category`。Cloudflare D1 部署会使用 storage-level bulk 写入减少 D1 往返；`/api/reports/summary` 和 `/api/reports/analytics` 有短 TTL 内存缓存，写入或清理后会失效。`/api/reports/analytics` 在无反馈筛选时会优先使用 `daily_metrics` 提供概要计数，UTC 趋势也会使用 `daily_metrics`；Top UP、重复推荐、位置效果和钻取仍依赖明细事件。

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

部署时使用本地私有配置文件 `wrangler.local.toml`。仓库只提交 `wrangler.local.toml.example`，真实的 D1 `database_id` 不提交。

### 1. 创建 D1

创建 D1 database：

```bash
npx wrangler d1 create tabulabili-sync
```

记录命令输出中的 `database_id`。也可以在 Cloudflare Dashboard 的 `Workers & Pages` -> `D1` 页面创建或查看。

### 2. 准备本地部署配置

在 `sync-backend/` 目录复制示例配置：

```powershell
Copy-Item wrangler.local.toml.example wrangler.local.toml
```

然后编辑 `wrangler.local.toml`，把 `database_id` 改成真实 D1 ID：

```toml
[[d1_databases]]
binding = "TABULABILI_SYNC_DB"
database_name = "tabulabili-sync"
database_id = "<your-d1-database-id>"
```

`wrangler.local.toml` 已被 `.gitignore` 忽略，不要提交真实 D1 ID。

### 3. 设置密钥

使用同一个本地配置设置 Secret：

```bash
npx wrangler secret put SYNC_SECRET --config wrangler.local.toml
```

这个密钥就是后台页面登录密钥，也是扩展端同步密钥。

`wrangler.local.toml.example` 已包含：

```toml
[placement]
mode = "smart"
```

实际部署配置 `wrangler.local.toml` 也应保留该配置，让 Worker 根据 D1/后端访问模式自动优化运行位置。

### 4. 应用 D1 migration 并部署代码

在 `sync-backend/` 目录运行：

```bash
npm install
npm run migrate:remote
npm run deploy
```

`npm run deploy` 会执行：

```bash
npx wrangler deploy --config wrangler.local.toml
```

这样 D1 表/索引会先在远端创建，D1 binding 和 Smart Placement 配置会由本地 `wrangler.local.toml` 随部署一起提交，避免普通 `npx wrangler deploy` 用缺少 D1 的配置覆盖 Cloudflare 后台绑定。

### 5. 验证后台

1. 打开 Worker 地址，例如 `https://tabulabili-sync.<account>.workers.dev`。
2. 输入 `SYNC_SECRET` 登录。
3. `/data` 能看到配置、批次和样本，`/analytics` 能看到分析页面即部署成功。

D1 表和索引建议通过 migration 创建。写入事件、保存配置和清理数据时 Worker 会兜底初始化；只读报表接口在空库或未建表时返回空数据，不会自动建表。旧 KV 数据不会自动迁移到 D1。

### 6. 配置扩展

在扩展设置页的“同步与上报”区域填写：

- 后端 URL：Worker 地址，例如 `https://tabulabili-sync.<account>.workers.dev`
- 服务密钥：`SYNC_SECRET`
- 开启同步与上报
- 点击“立即同步”测试连接

### Dashboard 设置说明

Cloudflare Dashboard 可以用来查看 Worker、D1 和 Secret，但部署配置以 `wrangler.local.toml` 为准。不要再用只读取默认 `wrangler.toml` 的普通 `npx wrangler deploy`，否则仍可能覆盖远端 D1 绑定。

## 扩展端配置

在扩展设置页的“同步与上报”区域填写：

- 后端 URL：Docker 示例 `http://localhost:8787`，Worker 示例 `https://<worker>.<account>.workers.dev`
- 服务密钥：部署时配置的 `SYNC_SECRET`
- 开启同步与上报
- 设置上报频率

未配置后端时，扩展仍保持原有本地设置、统计和导出能力。
