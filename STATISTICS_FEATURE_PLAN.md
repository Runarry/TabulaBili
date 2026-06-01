# 信息统计功能方案

日期：2026-06-01

## 需求背景

希望在扩展内记录 B 站首页推荐流中的视频与 UP 主信息，后续导出给其他软件分析，判断哪些 UP 主、标题主题或推荐类型符合个人偏好，再反向辅助扩展的内容屏蔽规则。

本方案暂不考虑以下功能：

- 观看时长统计
- 点赞、收藏、投币等账号行为统计
- 自动偏好评分或自动屏蔽

第一阶段只做本地推荐样本采集、显式标注、导出和屏蔽联动。

## 可行性分析

### 结论

该需求可行，且适合在当前项目结构中实现。

当前扩展已经在 `content-main.js` 中劫持 B 站首页 feed 接口，并在响应阶段解析 `data.item`，用于融合模式、屏蔽规则过滤和补足推荐内容。信息统计可以复用这个入口，在推荐内容进入页面前做字段白名单提取。

同时，`content-main.js` 运行在页面 MAIN world，不能直接访问扩展存储；项目已经存在 `content-main.js` 与 `content.js` 之间的事件桥接模式，例如设置同步和网络准备事件。统计数据也可以沿用这一方式：

1. `content-main.js` 从 feed 响应中提取推荐样本。
2. 通过 `window.dispatchEvent` 把样本批量发给 `content.js`。
3. `content.js` 使用 `browser.storage.local` / `chrome.storage.local` 写入本地。
4. `options.html` / `options.js` 读取本地样本，展示、标注、导出、生成屏蔽规则。

### 不需要新增权限

现有权限包含：

- `storage`
- `declarativeNetRequest`
- `host_permissions` 覆盖 `api.bilibili.com` 和 `www.bilibili.com`

本地统计、导出和设置页展示都可以在现有权限内完成。因为不向外部服务器上传数据，仍可维持当前 `data_collection_permissions.required = ["none"]` 的隐私定位。

### 主要风险

1. 存储容量增长
   `storage.local` 不适合无限保存原始推荐流。需要限制字段、限制天数、限制最大样本数。

2. 重复样本
   首页刷新、换一换、补足请求、融合模式双分支都可能带来重复视频。需要用 `bvid`、`aid`、`uri` 或组合 key 做去重。

3. 字段结构不稳定
   B 站 feed item 字段可能变化。提取逻辑要容错，缺失字段不能影响首页加载。

4. 隐私边界
   统计会保存推荐标题、UP 主、推荐理由等内容。必须默认关闭或提供明确开关，并提供清空数据能力。

5. 性能影响
   不能在每条 item 上立刻写 storage。应按 feed 响应批量写入，并在 `content.js` 中做短延迟合并。

## 功能范围

### 第一阶段目标

1. 增加“本地分析模式”开关，默认关闭。
2. 开启后记录首页 feed 推荐样本。
3. 支持最近推荐样本列表。
4. 支持按 UP 主聚合统计。
5. 支持给样本或 UP 主做显式标注。
6. 支持导出 CSV 和 JSONL。
7. 支持从统计页一键添加 UP 主屏蔽规则。
8. 支持清空统计数据。

### 暂不做

- 视频页观看时长
- 点赞、收藏、投币、评论等账号行为读取
- 自动推断“喜欢 / 不喜欢”
- 自动生成复杂屏蔽规则
- 云同步或远程上传

## 数据采集设计

### 采集入口

推荐在 `content-main.js` 的两个位置采集：

1. `filterFeedResponse(response, originalArgs, originalUrl, currentMode)`
   这里能拿到最终参与展示的 feed items，以及屏蔽后结果。

2. `fetchFusionFeedResponse(args, requestUrl)`
   融合模式中可以标记样本来源为 `origin` 或 `clean`，用于后续分析推荐差异。

采集时必须保证失败不影响原有 feed 响应。统计逻辑只能作为旁路执行。

### 样本字段白名单

建议每条推荐样本保存以下字段：

```json
{
  "id": "BVxxxx",
  "capturedAt": "2026-06-01T12:00:00.000Z",
  "dateKey": "2026-06-01",
  "mode": "fusion",
  "source": "clean",
  "position": 3,
  "bvid": "BVxxxx",
  "aid": "123456",
  "uri": "https://www.bilibili.com/video/BVxxxx",
  "title": "视频标题",
  "upName": "UP主名",
  "upMid": "123456",
  "category": "科技",
  "duration": 420,
  "reason": "推荐理由",
  "stats": {
    "view": 100000,
    "like": 5000,
    "danmaku": 800
  },
  "feedback": "unset",
  "tags": []
}
```

字段说明：

- `id`：样本主键，优先使用 `bvid`，其次 `aid`，再其次 `uri`。
- `capturedAt`：采集时间。
- `dateKey`：按天统计用，格式 `YYYY-MM-DD`。
- `mode`：当时扩展模式，取值为 `pure`、`refresh`、`mixed`、`fusion`、`origin`。
- `source`：推荐来源，取值为 `clean`、`origin`、`mixed_clean`、`mixed_origin`、`refill`、`unknown`。
- `position`：在本次响应中的位置。
- `feedback`：用户显式标注，取值为 `unset`、`like`、`dislike`、`blocked`、`neutral`。
- `tags`：用户自定义标签，第一版可以先保留字段但不做复杂 UI。

不建议保存完整原始 item。原始响应中可能包含推荐链路、实验字段、追踪字段和大量与分析无关的内容。

### 点击行为

点击行为可作为弱信号，但不直接等同于喜欢。

第一版可以记录：

```json
{
  "sampleId": "BVxxxx",
  "clickedAt": "2026-06-01T12:05:00.000Z",
  "clickCount": 1
}
```

实现方式：

1. `content.js` 在 `www.bilibili.com` 首页监听指向 `/video/` 的链接点击。
2. 从 URL 中提取 `BV` 号。
3. 更新对应样本的 `clickCount` 与 `lastClickedAt`。

注意：点击只用于导出和聚合展示，不自动改变 `feedback`。

## 存储设计

### Storage keys

建议新增以下 key：

```text
bili_analysis_enabled
bili_analysis_samples_v1
bili_analysis_feedback_v1
bili_analysis_settings_v1
```

### `bili_analysis_enabled`

布尔值，控制是否启用本地分析模式。默认 `false`。

### `bili_analysis_samples_v1`

推荐样本数组。为控制规模，建议只保存白名单字段。

默认限制：

- 保留最近 30 天
- 最多 5000 条样本
- 同一视频重复出现时合并为一条，并增加 `seenCount`
- 保留 `firstSeenAt` 和 `lastSeenAt`

合并后的样本结构建议：

```json
{
  "id": "BVxxxx",
  "firstSeenAt": "2026-06-01T12:00:00.000Z",
  "lastSeenAt": "2026-06-01T18:00:00.000Z",
  "seenCount": 4,
  "modes": {
    "fusion": 3,
    "refresh": 1
  },
  "sources": {
    "clean": 2,
    "origin": 2
  },
  "positions": [3, 8, 11, 2],
  "bvid": "BVxxxx",
  "aid": "123456",
  "uri": "https://www.bilibili.com/video/BVxxxx",
  "title": "视频标题",
  "upName": "UP主名",
  "upMid": "123456",
  "category": "科技",
  "duration": 420,
  "reason": "推荐理由",
  "stats": {
    "view": 100000,
    "like": 5000,
    "danmaku": 800
  },
  "clickCount": 0,
  "lastClickedAt": "",
  "feedback": "unset",
  "tags": []
}
```

### `bili_analysis_feedback_v1`

可选。若担心样本清理时丢失人工标注，可把反馈独立保存。

```json
{
  "BVxxxx": {
    "feedback": "dislike",
    "tags": ["标题党"],
    "updatedAt": "2026-06-01T20:00:00.000Z"
  }
}
```

第一版也可以直接把 `feedback` 写入样本对象，后续再拆分。

### `bili_analysis_settings_v1`

```json
{
  "retentionDays": 30,
  "maxSamples": 5000,
  "captureClicks": true
}
```

## UI 设计

### Popup

弹窗只展示轻量入口，不承载完整统计。

建议新增内容：

- “本地分析”状态：已关闭 / 已开启
- 今日采集样本数
- “查看统计”按钮，打开 options 页面

避免弹窗过高，主要统计页放在 options。

### Options 页面

在现有设置页新增“信息统计”区域。

建议分为四个面板：

1. 本地分析模式
   - 开关
   - 保留天数
   - 最大样本数
   - 清空统计数据

2. 概览
   - 总样本数
   - 今日新增
   - 近 7 天新增
   - 已标注喜欢 / 不喜欢 / 屏蔽
   - 点击过的视频数

3. UP 主统计
   - UP 主名
   - 推荐次数
   - 点击次数
   - 不喜欢次数
   - 最近出现时间
   - 操作：标注、屏蔽 UP

4. 最近推荐样本
   - 时间
   - 标题
   - UP 主
   - 模式
   - 来源
   - 推荐次数
   - 点击次数
   - 标注按钮
   - 屏蔽 UP 按钮

### 显式标注

标注按钮建议提供：

- 喜欢
- 不喜欢
- 一般
- 加入屏蔽
- 清除标注

第一版只修改本地样本的 `feedback` 字段，不自动影响推荐。点击“加入屏蔽”时才写入现有 `bili_block_rules`。

## 导出设计

### CSV

适合表格软件、LLM 工具和手工分析。

建议列：

```text
id,bvid,aid,title,upName,upMid,category,duration,firstSeenAt,lastSeenAt,seenCount,clickCount,lastClickedAt,feedback,modeCounts,sourceCounts,reason,view,like,danmaku,uri
```

### JSONL

适合脚本、批处理和其他分析工具。

每行一个样本对象：

```json
{"id":"BVxxxx","title":"视频标题","upName":"UP主名","seenCount":4,"feedback":"unset"}
```

### 导出隐私提示

导出前提示：

```text
导出的文件包含你的首页推荐标题、UP 主和人工标注，仅保存在本地。请确认后再分享给其他软件。
```

## 与屏蔽规则联动

当前项目已有两类规则：

- `up_name_exact`
- `title_regex`

第一版优先联动 `up_name_exact`。

操作流程：

1. 用户在 UP 主统计或样本列表中点击“屏蔽 UP”。
2. 读取 `bili_block_rules`。
3. 如果不存在同名 UP 主规则，则追加：

```json
{
  "id": "generated-id",
  "type": "up_name_exact",
  "pattern": "UP主名",
  "enabled": true,
  "createdAt": "2026-06-01T12:00:00.000Z",
  "source": "analysis"
}
```

4. 保存后触发现有 B 站标签页刷新逻辑。
5. 样本反馈更新为 `blocked`。

第一版不建议自动生成标题正则。标题正则误伤概率较高，应由用户手工整理。

## 实现步骤

### 阶段 1：数据通路

1. 在 `content-main.js` 增加推荐样本提取函数。
2. 在 feed 响应处理后派发 `tabula_analysis_samples` 事件。
3. 在 `content.js` 增加事件监听，读取 `bili_analysis_enabled`。
4. 开启时批量写入 `storage.local`。
5. 实现去重、合并、保留天数、最大样本数裁剪。

### 阶段 2：设置页统计 UI

1. 在 `options.html` 增加信息统计面板。
2. 在 `options.js` 增加读取、聚合和渲染逻辑。
3. 增加分析模式开关、清空按钮、保留天数和最大样本数设置。
4. 增加最近样本列表。
5. 增加 UP 主聚合列表。

### 阶段 3：标注与屏蔽联动

1. 实现样本反馈更新。
2. 实现 UP 主聚合反馈统计。
3. 实现一键添加 UP 主屏蔽规则。
4. 复用现有 `queueBiliTabsRefresh()` 让屏蔽规则生效。

### 阶段 4：导出

1. 实现 CSV 导出。
2. 实现 JSONL 导出。
3. 导出前展示隐私提示。
4. 文件名建议：

```text
tabulabili-analysis-2026-06-01.csv
tabulabili-analysis-2026-06-01.jsonl
```

## 推荐代码结构

为了避免 `options.js` 继续膨胀，建议新增两个文件：

```text
analysis-store.js
analysis-export.js
```

用途：

- `analysis-store.js`：样本归一化、合并、裁剪、聚合。
- `analysis-export.js`：CSV、JSONL 序列化与下载。

但如果希望第一版改动最小，也可以先把逻辑放进 `content.js` 和 `options.js`，后续再拆分。

## 验收标准

1. 默认安装后不会记录推荐样本。
2. 开启本地分析模式后，刷新 B 站首页能记录推荐样本。
3. 样本只包含白名单字段，不保存完整原始响应。
4. 同一视频重复出现时会合并 `seenCount`，不会无限重复膨胀。
5. 设置页能看到总样本数、今日新增、UP 主推荐排行和最近推荐样本。
6. 用户可以给样本标注喜欢、不喜欢、一般、屏蔽。
7. 用户可以从统计页一键添加 UP 主屏蔽规则。
8. 可以导出 CSV 和 JSONL。
9. 可以一键清空统计数据。
10. 统计功能异常时不影响首页推荐流加载和现有模式切换。

## 建议的 MVP 边界

建议第一版只实现以下内容：

- 本地分析模式开关
- 推荐样本采集与合并
- UP 主聚合统计
- 最近样本列表
- 显式标注
- 一键屏蔽 UP
- CSV / JSONL 导出
- 清空统计数据

不做观看时长、点赞收藏和自动评分，可以明显降低权限、隐私和实现复杂度，也更符合“先导出给其他软件分析，再手工反哺屏蔽规则”的使用方式。
