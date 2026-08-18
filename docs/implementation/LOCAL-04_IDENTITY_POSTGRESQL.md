# LOCAL-04 PostgreSQL Local Identity Implementation Record

| Control | Value |
|---|---|
| Date | 2026-08-18 |
| Status | `local_identity_postgresql_validated` |
| Scope | 确定性合成身份、最小权限 PostgreSQL Repository、持久化本地 Session |
| Data | 1 个合成组织、5 个 `.invalid` 合成用户；无真实用户或业务资料 |
| External action | 无云端、Cognito、部署、提交或推送操作 |

## 结果

本地模式不再使用进程内身份仓库。`scripts/db/seed-local-identity.ts` 以本地迁移
owner 幂等创建 `tianxing_local_identity`，写入固定 organization、user、membership
和 role binding，并验证账号权限。运行账号只能读取身份基线，只能对
`identity_sessions` 执行 `SELECT / INSERT / UPDATE`；membership、role binding 和
session 继续由 organization RLS 限制。

迁移 `017` 为 `identity_sessions` 增加 `session_kind`，允许本地 Session 在不伪造
Cognito token 的情况下保持 active；默认值仍是 `cognito`，现有 Cognito 写入不变。
真实 PostgreSQL 测试发现历史校验 trigger 的 `FOR SHARE` 需要额外表写权限，因此追加
迁移 `018` 将该校验函数设为固定 `search_path` 的 `SECURITY DEFINER`，并撤销 PUBLIC
执行权。没有修改已经应用的历史迁移，也没有向运行账号授予用户或组织写权限。

`IdentityRuntime` 根据 `AUTH_MODE` 选择适配器：`local-synthetic` 使用受限 PostgreSQL
Repository；`cognito` 继续使用原有 Cognito/PostgreSQL 路径。本地 Session 保存
SHA-256 secret hash，不保存浏览器 secret，也不保存 provider token。重复登录同一角色
会在同一事务内撤销旧 Session。

## 已执行验证

- migration manifest、追加迁移契约和架构门禁通过；当前 ledger 为 17，public 表仍为 61；
- seed 连续执行两次均通过，结果保持 1 个 organization、5 个 user、5 个 membership、
  5 个 role binding；
- 真实 PostgreSQL 集成测试覆盖五种角色、连接池重建后的读取、无 provider token 和撤销；
- HTTP 登录返回 303，`/api/v1/auth/me` 返回固定 Founder actor；
- 停止并重新启动 Next.js 后，重启前的同一 Cookie 再次调用 `/api/v1/auth/me` 返回 200；
- 登出后同一 Cookie 返回 401；`/api/v1/local/readiness` 的五项依赖均为 `ready`。

## 剩余 Gate

这只关闭本地 Identity 持久化，不代表 Access、CRM、Case、Task、Document 或 Worker
runtime 已经接通。真实 Cognito 邀请激活、香港 RDS 和生产 composition root 仍需独立
批准和证据。当前下一开发切片应选择首个内部 ERP 纵向闭环，并在 Assessment 写入前
关闭 16 个旧字段与 15 个正式 schema 字段的产品决策缺口。
