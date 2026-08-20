# ENV-01 Vercel Synthetic Test Runtime Plan

| Control | Value |
| --- | --- |
| Ticket | `ENV-01` Vercel synthetic database test runtime |
| Status | `implemented_one_role_baseline_unapplied` |
| Decision | `DEC-070` |
| Data | 仅独立测试 PostgreSQL 中的确定性合成数据 |
| External state | 本票先做源码与本地测试；Vercel 配置、外部数据库、migration/seed/provision 需要 exact payload 单独批准 |

## 目标

建立三个互斥环境组合，并使 Vercel 在 `NODE_ENV=production` 下作为测试环境运行：

```text
development / local-synthetic / local-synthetic
test        / test-database   / database-test
production  / production-aws  / cognito
```

Vercel 测试用户使用 email/password 登录，密码 verifier、identity、membership、role 和 session 均由
独立测试 PostgreSQL 管理。浏览器不接收数据库账号，不允许选择 role，也不能把 Vercel 测试系统解释为生产。
local、Vercel test 与 AWS production 使用同一个 canonical PostgreSQL login role `tianxing_app`，但每个环境的
连接串和密码仍然隔离。

## 后端切片

1. 新增统一环境组合 parser，冻结 `APP_ENV`、`APP_RUNTIME_MODE`、`AUTH_MODE` 合法矩阵和稳定错误变量。
2. 抽取 database-backed application runner，使现有 local API v1 composition 可在 `test-database` 使用
   TLS 远程 PostgreSQL，同时保持 local loopback 和 AWS production fail-closed 边界。
3. 追加 migration：versioned test credential verifier、失败/锁定状态，以及 `database_test` session kind；
   不修改既有 migration。
4. 新增 `DatabaseTestLoginService` 与 PostgreSQL repository。使用 Node `scrypt`、timing-safe compare、
   constant-shape denial、事务锁定失败计数和 opaque session。
5. 新增独立 test provision CLI。明文密码只从一次性进程输入读取；只接受 synthetic `.invalid` 邮箱；
   migration owner 不进入 Web runtime。
6. 更新 `/api/v1/auth/login` POST：local 仍接 role，database-test 只接 email/password，Cognito 仍走 PKCE。
7. 增加配置、service、repository、route、migration、provision 和 session 聚焦测试。

后端不得修改登录页面、通用表单样式、Sidebar 或其他前端消费者。

## 前端切片

后端冻结表单合同和稳定错误码后：

1. 登录页按 `AUTH_MODE` 渲染三种互斥入口。
2. `database-test` 只显示 email/password；使用正确 autocomplete，提交期间禁用并保持稳定布局。
3. 所有无效凭据显示同一用户文案，不展示异常、SQL、配置名、账号存在性或 lockout 内部状态。
4. local role selector 继续只在本机开发模式出现；Cognito 生产文案和入口保持不变。
5. 覆盖 keyboard、screen reader label、mobile、loading、invalid/session-expired/configuration 状态。

前端不得增加 role 参数、在 localStorage/sessionStorage 保存密码、绕过 `/api/v1/auth/login`、读取数据库
连接信息或自行实现 credential 校验。

## 配置合同

ENV-01A 已冻结以下三组合法组合，任何交叉组合均抛出统一的
`RuntimeEnvironmentConfigurationError`，其稳定错误码为 `RUNTIME_CONFIGURATION_INVALID`；`VERCEL_ENV`
只描述托管位置，不能决定业务环境：

| APP_ENV | NODE_ENV | APP_RUNTIME_MODE | AUTH_MODE | VERCEL | VERCEL_ENV |
| --- | --- | --- | --- | --- | --- |
| `development` | `development` | `local-synthetic` | `local-synthetic` | 不得存在 | 不得存在 |
| `test` | `production` | `test-database` | `database-test` | `1` | `preview` 或 `production` |
| `production` | `production` | `production-aws` | `cognito` | 不得存在 | 不得存在 |

Vercel test Web runtime 的变量合同为：

- `APP_ENV=test`
- `NODE_ENV=production`
- `APP_RUNTIME_MODE=test-database`
- `AUTH_MODE=database-test`
- `VERCEL=1`
- `VERCEL_ENV=preview|production`
- `TEST_DATABASE_EXPECTED_NAME`
- `TEST_DATABASE_URL`
- `TEST_DATABASE_CONNECTION_TIMEOUT_MS`
- `TEST_DATABASE_STATEMENT_TIMEOUT_MS`
- `TEST_DATABASE_POOL_MAX=1`

该 URL 必须使用 `postgresql:`、非 loopback/非 IP host 和数据库名；数据库名必须等于
`TEST_DATABASE_EXPECTED_NAME`，且不能是 `postgres`、`template0`、`template1` 或 `tianxing`。URL 不得带
query/hash，解码后的 login user 必须严格为 `tianxing_app`，不能使用 migration、provision 或 NOLOGIN group
role。TLS 始终使用 `rejectUnauthorized=true`，不提供关闭开关。

`TEST_DATABASE_CONNECTION_TIMEOUT_MS` 允许 `250..5000`，
`TEST_DATABASE_STATEMENT_TIMEOUT_MS` 允许 `1000..10000`；Web runtime 与 provision CLI 共用该边界。

Web runtime 明确拒绝 `DATABASE_URL`、migration/provision URL 和任意 `LOCAL_SYNTHETIC_*`。外部供应商 CA、
URL query、pooler 特例和大于 1 的连接池均延后到 ENV-01B，不在源码中预留隐式 fallback。
`production / production-aws / cognito` 组合按 identity、application、provision、migration 的固定顺序拒绝任意
非空 test database URL，不允许生产进程静默携带测试数据库凭据。

## ENV-01A 已实现边界

- CRM `StudentRead` 以及 Cases `CaseWorkspace`、`CaseTransition`、`SchoolTarget` 四个现有 runtime 已改用
  通用 application tenant runner；local 入口继续兼容，`production-aws` 不会误用 test adapter。
- local readiness 继续分别检查 PostgreSQL 基础连接、identity seed 和 application data；三个 PostgreSQL 检查
  共享同一个 `LOCAL_SYNTHETIC_DATABASE_URL`，并都确认 `current_user = tianxing_app`。API 的原有
  `postgresql_identity`、`postgresql_application` dependency key 保持不变。
- Portal/Billing production composition 继续保留 discovery、tenant、billing writer、aggregate reader 的职责
  边界，但所有数据库 adapter 都从同一个 `DATABASE_URL` 读取 `tianxing_app`；`platform_billing_approver` 仍是
  业务授权角色，不是数据库 login role。
- application/identity 每次事务只校验 `current_user = tianxing_app`；运行时不再依赖 `pg_has_role` 或测试 group
  role。migration 028 的历史角色语义保持不变，不被本轮 one-role 合同伪装成已迁移。
- migration 028 追加 `identity_database_test_credentials`、`database_test` session kind、每用户最多一个 active
  database-test session、direct privilege revoke 和 `SECURITY DEFINER` 函数；未修改任何既有 migration。
- `DatabaseTestLoginService` 使用代码 registry 中唯一的 `scrypt-v1`：`N=32768`、`r=8`、`p=1`、
  `keyLength=64`、`salt=32`、`maxmem=64MiB`。未知或格式错误账号仍执行 dummy verifier 和等长
  `timingSafeEqual`；真实 credential 通过 verifier version CAS 防止 rotation 竞态，并在凭据行锁内原子完成失败
  计数、锁定、成功清零和 session replace。失败计数与成功清零不改变 verifier version。
- 锁定合同为 15 分钟窗口内 5 次失败后锁定 15 分钟。停用、锁定、未知、非法字段和 role 注入对外统一为
  `authentication_failed`。
- `complete_login` 与 `resolve_session` 仅使用调用者时间拒绝超过 5 分钟的严重时钟偏差；校验后锁定窗口、
  session 过期、敏感操作时限以及所有状态时间均使用 PostgreSQL `transaction_timestamp()` 的事务权威值。
- `POST /api/v1/auth/login` 的 database-test 模式只接受
  `application/x-www-form-urlencoded` 的唯一 `email`/`password` 字段，流式正文上限 4 KiB；成功 303 到
  `/today`。配置错误映射 `configuration`，数据库断连、timeout 和意外 Repository 错误映射
  `service_unavailable`。local role 和 Cognito 分支保持原有输入语义。
- provision CLI 已切换到 `tianxing_app`，只调用 baseline 安装的受保护 verifier 函数；它不会创建 User、Membership、Role
  或业务数据。密码只从标准输入读取，并在使用后清零。

## One-role baseline

`db/baselines/one-role/` 是独立的可执行 baseline/manifest 目录，供空 Neon test、本地数据库和未来 AWS bootstrap 使用。
它不修改、覆盖或冒充 `db/migrations/manifest.json` 的历史 27 条 migration；生成器固定校验全部来源 SHA-256，并对
008、011、012、013、025、028 做六个明确的单角色变换，其余 21 个来源逐字复制。025 变换仅在 baseline 总事务内，
于创建 transition-facts guard trigger 前临时向 `tianxing_app` 授予 `TRIGGER`，创建后立即撤销；最终 runtime ACL
不会扩大。当前 manifest 为 `executable-unapplied`，仅表示代码已准备好，尚未对任何数据库执行。

单角色成为表 owner 会绕过普通 owner RLS 检查，因此 baseline 对全部已启用 RLS 的 public 表执行 `FORCE ROW LEVEL
SECURITY`；`SECURITY DEFINER` 函数固定 `search_path`、撤销 PUBLIC 执行权并只授予 `tianxing_app`。同一角色仍拥有
credential 表，不能把这种 owner 能力描述成数据库级隔离；seed 和 runtime 必须显式设置租户上下文。

变量值、供应商和 secret 不进入 Git。本票不自动调用 Vercel CLI，也不连接外部 PostgreSQL。

## ENV-01B exact-payload gate

ENV-01A 完成不表示 Vercel 测试环境可用。以下事项必须等待供应商和 exact payload 获批：

- 托管 PostgreSQL 供应商、region、CA、direct/pooled URL 形态和 serverless 多实例连接上限。
- 既有 migration 中 `rds_iam`、`CREATE ROLE`、`ALTER ROLE` 对供应商权限模型的兼容性。
- canonical `tianxing_app` 的外部 URL/密码隔离、连接上限与最小权限证明；不再创建独立 migration、identity、
  application 或 provision runtime login role。
- 外部 baseline apply、synthetic-only User/Membership/Role seed、credential provision 和 Vercel variables。
- Deployment Protection、测试数据隔离证明、浏览器登录、session replace/revoke/expiry 和清理证据。

数据库 identity login 凭据一旦泄露，数据库无法独立证明 Node 已完成 scrypt。该 test-only residual risk 只能通过
synthetic-only 数据、最小 group 权限、每次 session 的 User/Membership/Role 复查和 Deployment Protection 降低，
不能宣称由 ENV-01A 消除。

## 验收

- 合法环境矩阵与全部非法交叉组合测试通过。
- test URL 必须是 TLS、非 loopback、非默认数据库、非 production allowlist，且 login user 严格为
  `tianxing_app`；环境密码隔离但不创建第二个数据库角色。
- password verifier、失败计数、锁定、成功清零、并发登录、session replace/revoke/expiry 均有测试。
- database-test 登录表单不能提交 role；local 登录不能提交 email/password 作为授权事实。
- one-role baseline 的静态生成、哈希、事务、RLS/SECURITY DEFINER 合同必须通过；真实数据库 dry-run、apply 和 seed
  仍须分别取得批准并记录证据。credential 表的 owner residual risk 必须保留在验收记录中。
- Node 22 TypeScript、聚焦测试、module boundary 和 `git diff --check` 通过。
- 外部 Vercel/数据库验收只有在 exact payload 获批后执行；届时必须记录 synthetic-only 数据证明和清理结果。

## 交付顺序

1. 后端只读设计，架构师审核。
2. 后端实现并合并独立 PR。
3. 前端从最新 `main` 实现并合并独立 PR。
4. 架构师做本地配置和浏览器验收。
5. 用户批准 exact Vercel/test database payload 后，才配置外部环境、迁移、provision 和远程验收。
