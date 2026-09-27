# 地震台站数据质量检测服务

纯后端 Node.js + TypeScript + Fastify 服务，面向地震台站观测数据接入与质量检测。

## 能力

- 台站档案管理
- **可配置的质量规则版本**：采样完整性、削顶、时间同步阈值与问题标签随版本发布，支持发布 / 停用 / 列表查询
- 观测摘要批量接入，接入时关联规则版本，评分、问题标签与逐项扣分明细均基于该版本并快照留存
- 质量评分与问题标签（同一版本内口径一致）
- 按台站 / 分数 / 规则版本查询观测记录
- 生成时间窗口质量报告，报告固化规则版本、阈值、标签，可说明评分依据；支持按已停用版本做历史追溯

## 质量规则版本

不同科研项目可发布各自的规则版本（如 `1.0.0`、`2.0.0`），阈值字段：

| 字段 | 含义 |
| --- | --- |
| `minSamples` / `minWindowSeconds` | 采样完整性：绝对值优先，否则按采样率 × 窗口秒数换算 |
| `maxPeakAmplitude` | 削顶峰值上限 |
| `maxAbsTimingOffsetMs` | 时间同步允许偏差（毫秒） |
| `scorePenaltyPerIssue` / `maxTimingPenalty` | 评分扣分参数 |

版本行为约定：

- **发布**：`POST /api/quality/rules`，版本号全局唯一，发布内容不可变；服务内置 `1.0.0` 开箱可用
- **停用**：`POST /api/quality/rules/:version/disable`，停用后拒绝用于新观测接入，但历史观测与报告仍按该版本追溯
- **接入解析**：请求可显式传 `ruleVersion`（或 `project` 匹配项目规则）；缺省取最新 active 版本
- **报告解析**：缺省取 active 版本，可显式指定已停用版本；报告只聚合同一版本的观测，其他版本观测计入 `excludedOtherVersionCount`
- **明确报错**（不静默回退）：
  - `404 RULE_VERSION_NOT_FOUND` 版本不存在
  - `409 RULE_VERSION_EXISTS` 版本号重复发布
  - `409 RULE_VERSION_DISABLED` 用已停用版本接入新观测
  - `409 NO_ACTIVE_RULE_VERSION` 无版本时缺省接入 / 出报告

### 主要接口

- `GET/POST /api/quality/rules`、`GET /api/quality/rules/:version`、`POST /api/quality/rules/:version/disable`
- `POST /api/observations/ingest`（可带 `ruleVersion`、`project`）
- `GET /api/observations?ruleVersion=...`
- `POST /api/quality/reports/run`（可带 `ruleVersion`）、`GET /api/quality/reports?ruleVersion=...`

## 启动

```bash
npm install
npm run dev
```

默认端口：`4301`。当前使用内存存储，后续可替换 PostgreSQL/时序数据库，并接入 Kafka、SeedLink 或对象存储。
