# Cloudflare 后端统计与分析完善规划

## 目标

将当前 `sync-backend` 从“个人配置同步与基础数据上报后台”完善为“可长期运行、可解释、可扩展的推荐数据分析后端”。

规划重点：

- 修正分析时间口径，保证“近 7/30/90 天”等筛选结果语义一致。
- 结构化关键事件字段，减少依赖 `raw_json/json` 全量扫描。
- 补齐推荐分析需要的核心指标，例如 CTR、反馈率、屏蔽率、重复推荐率、位置效果和模式对比。
- 优化 Cloudflare D1 查询路径，控制 Worker CPU、D1 读取量和长期运行成本。
- 改造管理后台，使其从“数据查看页”升级为“可筛选、可钻取、可导出的分析面板”。
- 建立数据保留、迁移、隐私与测试机制，避免后续统计能力继续堆在临时逻辑上。

## 当前现状

### 已有能力

- 扩展端通过 `sync-common.js` 构造上报批次，事件包含 `impression`、`click`、`feedback` 三类。
- `background.js` 已具备上报队列、手动上报、定时上报、失败重试和队列长度控制。
- 后端 API 已有：
  - `POST /api/reports`
  - `GET /api/reports/summary`
  - `GET /api/reports/batches`
  - `GET /api/reports/samples`
  - `GET /api/reports/analytics`
- Cloudflare Worker 入口使用 D1，Node 本地服务使用 SQLite，另有 memory storage 用于测试。
- 后端已有 `batches`、`events`、`samples` 三类数据：
  - `batches` 保存上报批次。
  - `events` 保存事件明细。
  - `samples` 保存视频级聚合结果。
- `/analytics` 页面已经显示基础指标、近期趋势、Top UP 和简单分布。
- 现有测试覆盖基础路由、D1 schema、幂等写入、样本聚合和基础 analytics。

### 主要问题

1. 分析时间口径不一致

   当前 `getReportAnalytics()` 只按时间过滤 `events`，但 `samples` 是全量读取。结果是 `trends` 大体代表所选时间范围，而 `sampleCount`、`impressionCount`、`clickCount`、`feedbackCount`、`topUps`、`categories` 等指标混入历史累计数据。

2. D1 字段结构化不足

   `events` 表中关键维度仍主要在 `raw_json`：

   - `eventKind`
   - `mode`
   - `source`
   - `category`
   - `position`
   - `feedback`
   - `bvid`
   - `upMid`
   - `upName`

   这会导致后续统计不得不读取大量 JSON 到 Worker 中再聚合，数据增长后会拖累 D1 读取量和 Worker CPU。

3. 指标偏“计数”，缺少“判断价值”

   目前能回答“有多少数据”，但还不能很好回答：

   - 哪种模式更有效？
   - 哪个来源点击率更高？
   - 哪些 UP 被频繁推荐但很少点击？
   - 哪些分类容易被屏蔽或不喜欢？
   - 推荐位置对点击影响如何？
   - 哪些视频或 UP 发生重复推荐？

4. 管理后台偏轻量

   当前页面适合验证部署和查看基础数据，但缺少：

   - 时间范围选择。
   - 多维筛选。
   - 指标卡片中的比率指标。
   - 图表。
   - 从聚合维度钻取样本。
   - CSV 导出。

5. 数据治理不足

   目前缺少：

   - schema version。
   - 显式迁移记录。
   - 数据保留策略。
   - 清理接口。
   - 按 `clientId` 隔离或筛选。
   - 后台导出避免泄露密钥的机制。

## 设计原则

- 先保证统计口径正确，再扩展指标。
- 优先使用 D1 SQL 聚合，避免 Worker 全量拉取 JSON 后计算。
- 保留原始 JSON，便于兼容旧数据和未来字段回溯。
- 对扩展端上报协议保持向后兼容，不要求用户立即升级全部客户端。
- 新字段通过自动 schema migration 增量添加，避免破坏现有部署。
- 所有指标明确分母、时间范围和过滤条件，避免管理页展示不可解释数字。
- 后台页面继续保持单 Worker 自托管，不引入复杂前端构建链。

## 阶段 1：修正统计口径与事件结构化

### 目标

让 `/api/reports/analytics?days=...` 的所有返回结果都严格代表指定时间范围，并为后续 SQL 聚合打基础。

### 数据表调整

为 `events` 增加结构化列：

```sql
alter table events add column event_kind text not null default 'impression';
alter table events add column mode text not null default '';
alter table events add column source text not null default '';
alter table events add column category text not null default '';
alter table events add column feedback text not null default '';
alter table events add column position integer not null default 0;
alter table events add column bvid text not null default '';
alter table events add column up_name text not null default '';
alter table events add column up_mid text not null default '';
```

建议索引：

```sql
create index if not exists idx_events_kind_captured_at on events(event_kind, captured_at);
create index if not exists idx_events_mode_captured_at on events(mode, captured_at);
create index if not exists idx_events_source_captured_at on events(source, captured_at);
create index if not exists idx_events_category_captured_at on events(category, captured_at);
create index if not exists idx_events_client_captured_at on events(client_id, captured_at);
create index if not exists idx_events_sample_captured_at on events(sample_id, captured_at);
```

为 `samples` 增加结构化列：

```sql
alter table samples add column first_seen_at text not null default '';
alter table samples add column last_clicked_at text not null default '';
alter table samples add column feedback_updated_at text not null default '';
```

建议索引：

```sql
create index if not exists idx_samples_first_seen_at on samples(first_seen_at);
create index if not exists idx_samples_up_mid on samples(up_mid);
create index if not exists idx_samples_category on samples(category);
```

### 代码调整

- 在 `D1Storage.ensureSchema()` 和 `SQLiteStorage.ensureSchema()` 中补齐新增列与索引。
- 抽取 `toEventRow(event, batch, receivedAt)`，统一事件字段落库逻辑。
- 写入 `events` 时同时写结构化列和 `raw_json`。
- `MemoryStorage` 保持兼容，但测试数据也应使用相同字段语义。
- `getReportAnalytics()` 不再读取全量 `samples` 后直接聚合。
- 对时间范围内的指标优先从 `events` 查询：
  - 曝光数：`event_kind = 'impression'`
  - 点击数：`event_kind = 'click'`
  - 反馈数：`event_kind = 'feedback'`
  - 样本数：时间范围内出现过的 `sample_id` 去重

### API 行为调整

`GET /api/reports/analytics` 保持现有参数：

- `days`
- `tzOffsetMinutes`

新增可选参数：

- `clientId`
- `mode`
- `source`
- `category`
- `feedback`

第一阶段可以先实现参数解析和 SQL where 构造，管理页暂不全部使用。

### 验收标准

- 近 7 天、近 30 天、近 90 天指标不会混入范围外事件。
- 老数据没有结构化列时，schema 自动补列。
- 新写入事件在 D1/SQLite 中可以直接通过结构化列查询。
- 现有测试全部通过。
- 新增测试覆盖：
  - 范围外历史事件不会进入 analytics。
  - `samples` 全量历史不会污染范围内指标。
  - 结构化列写入正确。

## 阶段 2：补齐核心分析指标

### 目标

从“计数报表”升级为“能判断推荐质量的分析报表”。

### 新增指标

概览指标：

- `impressionCount`：曝光事件数。
- `clickCount`：点击事件数。
- `feedbackCount`：反馈事件数。
- `distinctSampleCount`：出现过的视频数。
- `distinctUpCount`：出现过的 UP 数。
- `ctr`：`clickCount / impressionCount`。
- `feedbackRate`：`feedbackCount / impressionCount`。
- `negativeFeedbackRate`：`(dislike + blocked) / impressionCount`。
- `repeatImpressionRate`：重复曝光占比。

重复推荐定义建议：

- 对同一 `sample_id`，时间范围内曝光次数大于 1。
- `repeatImpressionCount = sum(impressionCount - 1)`。
- `repeatImpressionRate = repeatImpressionCount / impressionCount`。

维度指标：

- 按 `mode`：
  - 曝光、点击、CTR、反馈率、负反馈率、平均位置。
- 按 `source`：
  - 曝光、点击、CTR、反馈率。
- 按 `category`：
  - 曝光、点击、CTR、负反馈率。
- 按 `upMid/upName`：
  - 视频数、曝光、点击、CTR、反馈、负反馈、重复曝光。
- 按 `positionBucket`：
  - `1`
  - `2-3`
  - `4-6`
  - `7-10`
  - `11+`

### API 拆分

当前 `/api/reports/analytics` 可以继续作为兼容接口，但建议内部拆分为更清晰的返回结构：

```json
{
  "range": {
    "days": 30,
    "sinceIso": "2026-05-04T00:00:00.000Z",
    "tzOffsetMinutes": 480
  },
  "metrics": {},
  "trends": [],
  "dimensions": {
    "modes": [],
    "sources": [],
    "categories": [],
    "positions": [],
    "feedback": []
  },
  "top": {
    "ups": [],
    "samples": [],
    "repeatedSamples": []
  }
}
```

后续也可以拆成多个端点：

- `GET /api/reports/analytics/overview`
- `GET /api/reports/analytics/trends`
- `GET /api/reports/analytics/dimensions`
- `GET /api/reports/analytics/top`

在数据量不大时保留一个端点即可；当管理页需要局部刷新时再拆。

### SQL 聚合建议

趋势：

```sql
select
  substr(datetime(captured_at, ?), 1, 10) as date,
  sum(case when event_kind = 'impression' then 1 else 0 end) as impressions,
  sum(case when event_kind = 'click' then 1 else 0 end) as clicks,
  sum(case when event_kind = 'feedback' then 1 else 0 end) as feedbacks
from events
where captured_at >= ?
group by date
order by date asc;
```

维度：

```sql
select
  mode as key,
  sum(case when event_kind = 'impression' then 1 else 0 end) as impressions,
  sum(case when event_kind = 'click' then 1 else 0 end) as clicks,
  sum(case when event_kind = 'feedback' then 1 else 0 end) as feedbacks,
  avg(case when event_kind = 'impression' and position > 0 then position end) as avgPosition
from events
where captured_at >= ?
group by mode
order by impressions desc
limit ?;
```

Top UP：

```sql
select
  coalesce(nullif(up_mid, ''), up_name, 'unknown') as key,
  max(up_name) as upName,
  count(distinct sample_id) as sampleCount,
  sum(case when event_kind = 'impression' then 1 else 0 end) as impressions,
  sum(case when event_kind = 'click' then 1 else 0 end) as clicks,
  sum(case when feedback in ('dislike', 'blocked') then 1 else 0 end) as negativeFeedbacks
from events
where captured_at >= ?
group by key
order by impressions desc
limit ?;
```

### 验收标准

- 管理页能展示 CTR、反馈率、负反馈率、重复推荐率。
- `mode/source/category/up/position` 维度都能返回曝光、点击、CTR。
- 除样本详情外，主分析接口不依赖全量 JSON 扫描。
- 新增指标有单元测试覆盖分母为 0、负反馈、重复曝光、范围过滤等边界。

## 阶段 3：管理后台分析页升级

### 目标

让 `/analytics` 成为实际可用的分析面板，而不是基础数据验证页。

### 页面结构

建议页面分区：

1. 顶部筛选栏

   - 时间范围：7 / 30 / 90 天，自定义起止日期可后置。
   - 模式：全部 / pure / mixed / fusion / origin / refresh。
   - 来源：全部 / clean / origin / mixed_clean / mixed_origin / fusion_clean 等。
   - 分类。
   - 反馈。
   - clientId。

2. 概览指标卡

   - 曝光。
   - 点击。
   - CTR。
   - 反馈率。
   - 负反馈率。
   - 重复推荐率。
   - 视频数。
   - UP 数。

3. 趋势图

   - 曝光、点击、反馈按天。
   - CTR 按天。

4. 维度对比

   - 模式对比。
   - 来源对比。
   - 分类对比。
   - 位置段对比。

5. 榜单与钻取

   - 高频推荐 UP。
   - 高 CTR UP。
   - 高负反馈 UP。
   - 重复推荐视频。
   - 点击多的视频。
   - 被标注 dislike/blocked 的视频。

6. 导出

   - 当前筛选条件下导出样本 CSV。
   - 当前筛选条件下导出分析 JSON。

### UI 实现约束

- 保持当前无构建链的 Worker 内嵌 HTML/JS 方式，避免引入前端构建复杂度。
- 图表优先使用轻量原生 SVG 或 CSS 表格条形图；如果引入图表库，必须评估 Worker 响应体体积。
- 保持移动端可用，但优先满足桌面分析场景。
- 表格列需要可扫描：
  - 曝光
  - 点击
  - CTR
  - 反馈
  - 负反馈
  - 平均位置

### 验收标准

- 用户能在页面上按时间范围切换，并看到所有指标同步变化。
- Top UP 和分类榜单不只显示计数，还显示 CTR 和负反馈率。
- 点击榜单项可以跳转到 `/data` 样本筛选，或通过 API 拉取对应样本。
- CSV 导出不通过 URL 暴露 `auth` 密钥。

## 阶段 4：样本查询与钻取增强

### 目标

让聚合样本页支持从分析结果回看具体视频和事件背景。

### `GET /api/reports/samples` 增强

新增过滤参数：

- `clientId`
- `mode`
- `source`
- `category`
- `upMid`
- `upName`
- `minSeenCount`
- `minClickCount`
- `since`
- `until`
- `hasFeedback`

新增排序：

- `ctr`
- `negativeFeedback`
- `repeatCount`
- `firstSeenAt`
- `lastClickedAt`

注意：如果排序字段不是 `samples` 表结构化列，需要先明确是否从事件聚合计算，避免误导。

### 新增事件详情接口

建议新增：

```http
GET /api/reports/samples/:sampleId/events
```

查询参数：

- `limit`
- `offset`
- `eventKind`
- `days`

用途：

- 查看某个视频何时被推荐。
- 查看点击发生在第几次推荐之后。
- 查看反馈前后的推荐变化。

如果不想引入路径参数解析，也可以使用：

```http
GET /api/reports/events?sampleId=...
```

### 验收标准

- 从分析页 Top UP 可以钻取到对应 UP 的样本列表。
- 从样本列表可以查看某个视频的事件时间线。
- 分页、搜索、筛选组合在 D1 和 SQLite 中行为一致。

## 阶段 5：数据保留、迁移与运维

### 目标

保证长期部署后数据量、隐私和 schema 演进可控。

### Schema migration

新增 `schema_migrations` 表：

```sql
create table if not exists schema_migrations (
  version integer primary key,
  name text not null,
  applied_at text not null
);
```

迁移策略：

- `ensureSchema()` 只负责创建基础表。
- `runMigrations()` 负责增量补列、补索引、回填结构化字段。
- 每个 migration 必须幂等。
- D1 和 SQLite 共享 migration 定义，存储层只适配执行方式。

初始 migration 建议：

- `1_base_tables`
- `2_structured_event_columns`
- `3_sample_timestamps`
- `4_backfill_event_columns_from_json`

### 数据保留

新增配置项：

- `retentionDays`：默认 365，可设置 30/90/180/365/0。
- `0` 表示不自动清理。

新增管理 API：

```http
POST /api/reports/cleanup
```

请求体：

```json
{
  "before": "2026-01-01T00:00:00.000Z",
  "dryRun": true
}
```

清理范围：

- 删除 `events.captured_at < before`。
- 删除过旧 `batches.received_at < before`。
- 对 `samples` 不直接删除，除非没有任何事件关联，或提供单独压缩策略。

### 数据压缩

后续可增加每日汇总表：

```sql
create table if not exists daily_metrics (
  date text not null,
  client_id text not null default '',
  mode text not null default '',
  source text not null default '',
  category text not null default '',
  impressions integer not null default 0,
  clicks integer not null default 0,
  feedbacks integer not null default 0,
  negative_feedbacks integer not null default 0,
  primary key (date, client_id, mode, source, category)
);
```

当事件明细超过保留期时，可以保留汇总表用于长期趋势。

### 安全与隐私

- 导出接口不要使用 `?auth=` 传密钥，改为 fetch 携带 Authorization 后生成 Blob 下载。
- 管理页保存在 localStorage 的 secret 仍有风险，但个人自托管可以接受；README 应明确说明。
- 上报字段保持白名单，不接收任意大对象。
- 限制单批次事件数和单事件 JSON 长度。
- 对 `clientId` 提供筛选，但不要默认显示过长完整 ID，可截断展示。

### 验收标准

- 新部署和旧部署都能自动完成 schema 初始化。
- migration 重复运行不会破坏数据。
- cleanup dry run 能返回预计删除数量。
- cleanup 实际执行后 summary 和 analytics 保持一致。
- README 包含数据保留、备份和隐私说明。

## 阶段 6：性能优化与汇总表

### 触发条件

当满足任一条件时进入该阶段：

- `events` 超过 100,000 行。
- `/api/reports/analytics` 响应超过 1 秒。
- D1 读取量明显升高。
- 管理页常用筛选需要多次重复聚合。

### 优化方向

1. 每日汇总

   - 写入事件时同步更新每日汇总，或者通过定时任务批量更新。
   - 维度至少包括 `date/clientId/mode/source/category`。

2. Top 表缓存

   - 缓存近 7/30/90 天 Top UP、Top sample。
   - 适合在管理页频繁打开时减少重复 group by。

3. 查询分页优化

   - 对大 offset 分页逐步改为 cursor 分页。
   - 样本列表保留 offset 兼容，但新增 `cursor`。

4. Worker 响应控制

   - 限制 `limit`。
   - 对图表接口只返回必要字段。
   - 导出接口单独处理，不和页面 API 混用。

### 验收标准

- 100,000 事件级别下，概览和趋势接口能稳定返回。
- 管理页首次加载不依赖多个大 SQL 串行查询。
- 汇总表和原始事件在测试中可以对账。

## 推荐实施顺序

1. 阶段 1：修正口径和结构化字段。
2. 阶段 2：补核心指标。
3. 阶段 3：升级分析页。
4. 阶段 4：增强样本查询和事件钻取。
5. 阶段 5：补 migration、cleanup 和隐私治理。
6. 阶段 6：在数据量增长后引入汇总表和缓存。

不建议一开始就做阶段 6。当前项目更需要先让指标可信、接口边界清楚、页面能解释数据。

## 第一轮开发任务拆分

### 任务 1：事件结构化落库

文件：

- `sync-backend/src/storage/d1.js`
- `sync-backend/src/storage/sqlite.js`
- `sync-backend/src/report-aggregate.js`
- `sync-backend/test/d1-storage.test.js`
- `sync-backend/test/report.test.js`

工作：

- 新增 `toEventRow()`。
- D1/SQLite 写入事件时保存结构化列。
- 补齐 schema 和索引。
- 测试结构化字段写入。

验收：

- `npm test` 通过。
- D1 fake 测试能查询到新增列。

### 任务 2：analytics 时间口径修正

文件：

- `sync-backend/src/storage/helpers.js`
- `sync-backend/src/storage/d1.js`
- `sync-backend/src/storage/sqlite.js`
- `sync-backend/src/storage/memory.js`
- `sync-backend/test/report.test.js`

工作：

- 所有 analytics 指标基于同一个范围过滤。
- 明确 `sampleCount` 改为 `distinctSampleCount`，保留旧字段兼容时需注明语义。
- 增加范围外事件测试。

验收：

- 近 7 天不会统计 30 天前的样本累计曝光。
- API 返回中包含 `range` 元信息。

### 任务 3：新增比率指标

文件：

- `sync-backend/src/storage/helpers.js`
- `sync-backend/src/admin-page.js`
- `sync-backend/test/report.test.js`

工作：

- 增加 `ctr`、`feedbackRate`、`negativeFeedbackRate`、`repeatImpressionRate`。
- 管理页展示百分比，保留原始计数。
- 分母为 0 时返回 `0`，不要返回 `NaN`。

验收：

- 测试覆盖点击率、负反馈率、重复推荐率。
- 页面显示格式稳定，例如 `12.34%`。

### 任务 4：维度对比 SQL 化

文件：

- `sync-backend/src/storage/d1.js`
- `sync-backend/src/storage/sqlite.js`
- `sync-backend/src/storage/helpers.js`
- `sync-backend/test/d1-storage.test.js`

工作：

- D1/SQLite 使用 SQL group by 输出 modes/sources/categories/positions。
- MemoryStorage 使用 JS 逻辑保持测试便利。
- 统一返回字段：`key/impressions/clicks/feedbacks/ctr/feedbackRate/negativeFeedbackRate/avgPosition`。

验收：

- D1 和 MemoryStorage 同一输入返回核心字段一致。

### 任务 5：后台页面改造第一版

文件：

- `sync-backend/src/admin-page.js`

工作：

- 分析页增加 CTR、反馈率、负反馈率、重复推荐率卡片。
- 分布区域改为维度指标表，不只显示 bar count。
- 时间范围切换后所有区域同步刷新。
- 导出改为 Authorization fetch + Blob 下载。

验收：

- `/analytics` 页面可以看出不同模式/来源的点击效果差异。
- 不再生成包含 `auth` 参数的导出 URL。

## 测试计划

每个阶段至少运行：

```bash
cd sync-backend
npm test
```

建议新增测试类别：

- 事件结构化写入测试。
- analytics 时间范围过滤测试。
- 比率指标边界测试。
- D1/SQLite 查询一致性测试。
- 管理页 HTML smoke test。
- cleanup dry run 和实际删除测试。

## README 更新计划

需要在 `sync-backend/README.md` 补充：

- 统计分析字段说明。
- API 返回指标语义。
- 数据保留策略。
- D1 成本和数据量建议。
- 备份与恢复说明。
- 隐私说明。

## 风险与取舍

- D1 不适合无限明细事件长期保留，因此必须有保留或汇总策略。
- Worker 内嵌管理页易维护但交互能力有限，复杂图表不要过早引入。
- 事件字段结构化后仍需保留 `raw_json`，否则旧数据和未来字段难以回溯。
- `sampleCount` 语义需要谨慎迁移，避免用户误解历史累计和时间范围内去重。
- 如果未来支持多用户，当前单 `SYNC_SECRET` 模型需要升级为用户级 token 和权限模型；当前规划仍按个人自托管设计。
