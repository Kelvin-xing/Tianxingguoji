# ENV-01 Vercel Synthetic Test Runtime Plan

| Control | Value |
| --- | --- |
| Ticket | `ENV-01` Vercel synthetic database test runtime |
| Status | `planned_not_started` |
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

Vercel test 源码预期的变量名必须由后端 Slice 冻结并测试。至少包括：

- `APP_ENV=test`
- `APP_RUNTIME_MODE=test-database`
- `AUTH_MODE=database-test`
- test identity/application database URL
- bounded dependency timeout

变量值、供应商和 secret 不进入 Git。本票不自动调用 Vercel CLI，也不连接外部 PostgreSQL。

## 验收

- 合法环境矩阵与全部非法交叉组合测试通过。
- test URL 必须是 TLS、非 loopback、非默认数据库、非 production allowlist；身份和应用账号分离。
- password verifier、失败计数、锁定、成功清零、并发登录、session replace/revoke/expiry 均有测试。
- database-test 登录表单不能提交 role；local 登录不能提交 email/password 作为授权事实。
- 测试应用角色不能执行 migration DDL，identity role 不能写业务表，application role 不能读 credential verifier。
- Node 22 TypeScript、聚焦测试、module boundary 和 `git diff --check` 通过。
- 外部 Vercel/数据库验收只有在 exact payload 获批后执行；届时必须记录 synthetic-only 数据证明和清理结果。

## 交付顺序

1. 后端只读设计，架构师审核。
2. 后端实现并合并独立 PR。
3. 前端从最新 `main` 实现并合并独立 PR。
4. 架构师做本地配置和浏览器验收。
5. 用户批准 exact Vercel/test database payload 后，才配置外部环境、迁移、provision 和远程验收。
