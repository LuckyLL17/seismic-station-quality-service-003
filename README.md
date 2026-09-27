# 地震台站数据质量检测服务

纯后端 Node.js + TypeScript + Fastify 服务，面向地震台站观测数据接入与质量检测。

## 能力

- 台站档案管理
- **可配置、可版本化的质量规则**（采样完整性、波形削顶、时间同步阈值与问题标签）
- 观测摘要批量接入，评分时绑定规则版本并记录版本快照
- 质量评分与问题标签（标签由规则版本定义）
- 按台站/分数/规则版本查询观测记录
- 生成时间窗口质量报告，按规则版本分组并附带阈值、标签、版本状态，支持历史追溯

## 启动

```bash
npm install
npm run dev
```

默认端口：`4301`。当前使用内存存储，后续可替换 PostgreSQL/时序数据库，并接入 Kafka、SeedLink 或对象存储。

## 质量规则版本

不同科研项目的完整性、削顶、时间同步口径不同，阈值不再硬编码在接入逻辑中，
而是以「质量规则版本」为单一事实来源：观测接入、质量分、问题标签、报告全部关联同一版本。

规则版本发布后**不可修改**（保证历史评分可复现），只能停用；停用后历史观测与报告仍可追溯，
但不能再用于新观测接入。服务启动时内置启用中的 `v1.0` 默认版本（沿用改造前口径）。

### 规则版本字段

| 字段 | 说明 |
| --- | --- |
| `version` | 版本号，如 `v2.0`，全局唯一 |
| `thresholds.minSampleWindowSec` | 采样窗口最少秒数，`samples < sampleRateHz × 该值` 判定不完整 |
| `thresholds.clippingAmplitude` | 削顶阈值，`peakAmplitude` 高于该值判定削顶 |
| `thresholds.timingOffsetToleranceMs` | 时间同步容忍毫秒数 |
| `thresholds.scorePenaltyPerIssue` | 每个命中问题的扣分 |
| `thresholds.maxTimingPenalty` | 同步偏差扣分上限（`min(|offset|, 上限)`） |
| `issueLabels` | 三类问题（`completeness`/`clipping`/`timing`）的展示标签，可按项目自定义 |
| `isDefault` / `status` | 是否默认版本、`active` 或 `inactive` |

评分公式：`max(0, 100 − 命中问题数 × scorePenaltyPerIssue − min(|timingOffsetMs|, maxTimingPenalty))`。

### API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET  /api/quality/rules?status=active` | 列出规则版本 |
| `GET  /api/quality/rules/:id` | 查询版本（`:id` 支持规则 ID 或版本号） |
| `POST /api/quality/rules` | 发布新版本（版本号冲突返回 409；首个版本自动设为默认，可用 `makeDefault` 指定） |
| `POST /api/quality/rules/:id/deactivate` | 停用版本（最后一个启用版本返回 409） |
| `POST /api/quality/rules/:id/default` | 将启用中的版本设为默认 |
| `POST /api/observations/ingest` | 接入观测；可传 `ruleVersionId`（ID 或版本号），缺省使用默认启用版本 |
| `GET  /api/observations?ruleVersionId=` | 按规则版本过滤观测 |
| `POST /api/quality/reports/run` | 生成报告；`ruleVersionId` 可选，缺省覆盖窗口内全部版本并分组 |
| `GET  /api/quality/reports?ruleVersionId=` | 查询历史报告 |

### 不存在 / 不可用版本的处理

- 接入或报告指定的版本不存在：`404`，错误体带回 `ruleVersionId`
- 用已停用版本接入新观测：`409`，提示改用启用版本
- 未指定版本且当前没有启用中的规则：`409`，提示先发布规则
- 报告允许按**已停用**版本生成（历史追溯），分组中带 `ruleStatus` 与当时阈值；
  若观测引用的版本已从规则库中消失，分组状态为 `unknown` 并回退使用观测上的标签快照
