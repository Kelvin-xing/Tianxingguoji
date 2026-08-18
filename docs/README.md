# Tianxingguoji 工程文档索引

## 1. 用途与边界

本目录保存与当前代码版本绑定的实现记录、运行手册、安全模型和发布门禁。产品需求、领域术语、跨版本架构决策和研究位于同级工作区的 `txgj-doc` 文档目录。

本文只提供路由和状态解释，不改变各文档内部的约束，也不证明实现已经可运行。

## 2. 阅读顺序

处理一个功能或缺陷前按以下顺序读取：

1. `txgj-doc/PRD_IMPLEMENTATION_DECISIONS.md` 中对应决策。
2. `txgj-doc/PRD_PHASE_IMPLEMENTATION_PLAN.md` 中对应 ticket、依赖和验收项。
3. 当前接手范围先读取 `txgj-doc/TAKEOVER_PHASE0_SCOPE_BASELINE.zh-CN.md`；英文原文位于同仓库的 `TAKEOVER_PHASE0_SCOPE_BASELINE.md`。
4. 本目录中对应的 implementation record。
5. 相关领域契约、迁移和测试。
6. `evidence/` 和 `docs/release-evidence/` 中的实际证据与签署状态。

文件名或计划存在不代表 ticket 已经完成。必须读取文档中的 `Status`、`Local status`、未验证项和禁止声明。

## 3. 目录职责

| 目录 | 内容 | 权威边界 |
|---|---|---|
| `architecture/` | 当前代码版本的模块地图、分层和依赖门禁 | 描述实现边界，不替代 `txgj-doc` 的跨版本架构决策 |
| `implementation/` | 分票实现记录、局部契约、已运行检查和剩余 gate | 只对对应代码切片负责 |
| `runbooks/` | 认证、撤销、outbox、PII、region、restore、scan、telemetry 等操作手册 | 未实际演练的步骤不能声称可用 |
| `security/` | Release 1 threat model | 安全基线，不能被功能代码绕过 |
| `release-evidence/` | 人工 gate 和签署模板 | 未签署或缺字段时 fail closed |

本地 Release 1 运行底座的启动、检查和停止步骤见
[`runbooks/local-synthetic.md`](runbooks/local-synthetic.md)，对应实现记录为
[`implementation/LOCAL-01_SYNTHETIC_FOUNDATION.md`](implementation/LOCAL-01_SYNTHETIC_FOUNDATION.md)。
本地空库迁移执行与权限证据见
[`implementation/LOCAL-02_DATABASE_MIGRATION.md`](implementation/LOCAL-02_DATABASE_MIGRATION.md)。
身份模式开关、本地角色登录和 Cognito 回访登录边界见
[`implementation/LOCAL-03_IDENTITY_MODE.md`](implementation/LOCAL-03_IDENTITY_MODE.md)。
本地合成身份、最小权限数据库账号和持久化 Session 见
[`implementation/LOCAL-04_IDENTITY_POSTGRESQL.md`](implementation/LOCAL-04_IDENTITY_POSTGRESQL.md)。
当前模块分层、公开入口和兼容债务见
[`architecture/MODULE_MAP.md`](architecture/MODULE_MAP.md)。

仓库根目录的 `evidence/` 保存测试引用的机器可读 fixture 和 manifest，不应移动到 `docs/`。

## 4. Implementation 文档族

| 前缀 | 文件数 | 范围 | 整体解释 |
|---|---:|---|---|
| `P0-*` | 7 | Identity、CRM、Case、School、Task、Document、Audit 基础迁移与契约 | 多数为本地实现，数据库证据仍有缺口 |
| `P1-*` | 20 | 首条端到端纵向切片、认证、Case、文件、Task、通知和 rollback | 多数使用 synthetic adapter 或旧 Neon seam，不能等同生产运行时 |
| `P2-*` | 12 | Guardian、K12 catalogue、结果、Contractor、治理、Dashboard、Crawler 和 future scope | 本地契约较完整，RDS/浏览器证据不齐 |
| `P3-*` | 13 | 合成场景、重建、telemetry、生产源码、repositories、浏览器、安全、restore 和首案 gate | 当前 release blocker 集中区域 |
| `R1X-*` | 9 | Portal、PlatformBilling、运行组合和 AWS source foundation | 本地 contract/slice 存在，生产集成未获准；决策基线位于 `txgj-doc/decisions/` |

### 重复 ticket 编号

当前存在两个历史命名冲突：

- `P1-01_FRONTEND_CASE_WORKSPACE_PLAN.md`
- `P1-01_HK_STAGING_RUNTIME_PLAN.md`
- `P1-02_COGNITO_NEON_RUNTIME_INTEGRATION_PLAN.md`
- `P1-02_HK_RDS_PLAN.md`

在完成引用迁移前，不重命名这些文件。讨论、链接和开发票据必须使用完整文件名，不能只写 `P1-01` 或 `P1-02`。

## 5. 当前关键状态

以下是接手时必须知道的 release 状态，不替代各文件中的完整说明：

| 文档/门禁 | 当前状态 |
|---|---|
| `P3-02_SYNTHETIC_DETERMINISTIC_MATRIX_PLAN.md` | `needs_human`；本地矩阵有效，但 contract gaps 未关闭 |
| `P3-07_PRODUCTION_IAC_SOURCE_PLAN.md` | `needs_human`；没有 binary plan，也未请求 apply 权限 |
| `P3-08_CORE_POSTGRESQL_REPOSITORIES_PLAN.md` | `partial_local` |
| `P3-09_SUPPORTING_PRODUCTION_REPOSITORIES_PLAN.md` | `partial_local` |
| `P3-14_EMPTY_TENANT_BROWSER_PLAN.md` | 只有 source artifact；真实浏览器验收未完成 |
| `P3-16_SECURITY_RELIABILITY_PLAN.md` | 只有 source manifest/spec；生产 failure suite 未完成 |
| `P3-18_EMPTY_BASELINE_RESTORE_PLAN.md` | runbook 已升级；restore execution 未完成 |
| `P3-19_FIRST_CASE_DECISION_PLAN.md` | unsigned `no-go` |
| `release-evidence/phase3/first-case-go-no-go.md` | `no-go`，不授权任何真实案件 |
| `txgj-doc/decisions/R1X-DECISION-BASELINE-20260812.md` | 当前本地 Portal/Billing 实现基线；真实启用仍需独立 gate |

当前接手阶段不运行云端验证，也不把 `partial_local`、`implemented_local` 或测试 fixture 描述为 production-ready。

## 6. 状态解释

| 常见状态 | 含义 |
|---|---|
| `implemented_local` / `implemented_with_synthetic_adapter` | 本地契约或纯逻辑存在，外部运行时可能仍缺失 |
| `partial_local` | 只实现了部分 owning interface 或 repository |
| `source artifact authored` / `source_only` | 只有源码、计划或验证器，没有真实执行证据 |
| `pending_*_evidence` | 不能把未执行的数据库、浏览器、云端或恢复检查推定为通过 |
| `needs_human` | 有明确未决 gate，必须人工决定或提供外部证据 |
| `no-go` | 相关功能或生产动作不得启用 |

## 7. 文档与代码同步规则

- implementation record 必须说明实际修改、实际测试和未验证范围。
- 不修改已经应用的历史 migration；修复使用新的追加 migration。
- 不手工修改 evidence 使测试通过。
- 测试 fixture、source manifest、截图模板和未签署表单都不是运行证据。
- 文档中的云命令不构成执行授权。
- 移动文档前必须检查测试、脚本和其他文档中的硬编码路径。
- 完成一个 ticket 时更新对应文档，不创建同编号的平行版本。

## 8. 当前接手状态

- 身份术语位于 `txgj-doc/product/IDENTITY_CONTEXT.md`。
- 2026 年 6 月的历史设计已移至 `txgj-doc/archive/legacy-design/`。
- 两个非路由 `page 2.tsx` preview/mock 副本已删除；可复用 UI 要点保存在本地执行计划中。
- 源码已按 `domain / application / infrastructure` 分层，跨模块访问统一通过根级门面，并由架构测试扫描真实 import。
- 当前接手范围与推进边界记录在 `txgj-doc/TAKEOVER_PHASE0_SCOPE_BASELINE.md`，本目录不保存平行副本。
- README 根文档仍是 create-next-app 默认内容；是否重写留待后续单独确认。

阶段 1 本地底座已完成：依赖、schema、确定性合成身份和持久化 Session 均已验证。
下一步进入阶段 2，先选择并实现首个内部 ERP API v1 纵向闭环。
云端、真实数据、提交、推送和部署仍需独立授权。
