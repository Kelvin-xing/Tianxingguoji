# LOCAL-02 Database Migration Implementation Record

| Control | Value |
|---|---|
| Date | 2026-08-17 |
| Status | `local_schema_runtime_validated` |
| Scope | Release 1 的 15 份 PostgreSQL 迁移、本地 runner、ledger 和权限验证 |
| Data | 空库结构与事务内合成测试；没有业务数据 |
| External action | 无 Neon、AWS、Vercel、Cloudflare 或部署操作；代码提交与推送按用户确认另行执行 |

## 结果

新增有序迁移 SHA-256 清单 `db/migrations/manifest.json`、空库 planner snapshot、独立
迁移环境示例和 `scripts/db/run-local-migrations.ts`。Next.js 的 `.env.local` 不含迁移
owner 凭据；迁移命令只读取被 Git 忽略的 `.env.migration.local`。

本地 runner 在连接前和连接后双重 fail closed：只允许非生产 `local-synthetic`、
回环端点、数据库 `tianxing`、用户 `tianxing_migration`，并验证 SQL 文件集合、顺序、
SHA-256、数据库身份、ledger 前缀及空库条件。node-pg-migrate 只通过 `*.sql` glob 加载
迁移，使用 advisory lock、5 秒 statement/lock timeout 和单事务。

15 份迁移已应用到本地 PostgreSQL 17.10。`migration.schema_migrations` 有 15 条记录，
public schema 有 61 张表。重复 apply 选择 0 个迁移并安全 no-op。

## 权限证据

- `tianxing_app`、`platform_billing`、`platform_billing_reader`、`tianxing_health` 均不是
  superuser，没有 `CREATEDB`、`CREATEROLE` 或 `BYPASSRLS`。
- `tianxing_app` 可以连接数据库，但不能在 public schema 建表。
- `tianxing_health` 不能读取 `identity_users`。
- membership、role binding、session、CRM、Case 和 Document 等租户表已启用 RLS。
- `tianxing_migration` 是本地容器专用 owner；它的凭据不进入应用环境。

## 已执行验证

```text
empty migration plan: pass, 15 pending, 0 findings
local migration and drift tests: 16/16 passed
focused TypeScript check: passed
node-pg-migrate dry-run: 15 selected, ledger 0, public tables 0
node-pg-migrate apply: 15 selected, ledger 15, public tables 61
repeat apply: 0 selected, ledger 15, public tables 61
real PostgreSQL constraint tests: 36/36 passed
local readiness after migration: HTTP 200, all four dependencies ready
git diff --check: passed
```

首次 dry-run 在读取 `README.md` 时于业务 SQL 前失败；修正为 `*.sql` glob 后通过。
真实约束测试首次暴露 `case-schema.test.ts` 将 `Client` 误写为 type-only import；修正测试
导入后 36 项全部通过。临时库 `tianxing_schema_test` 已确认无连接并删除。

## 剩余 Gate

迁移只建立结构，没有插入组织、用户、角色绑定或会话，也没有为 `tianxing_app` 设置
本地凭据。随后完成的 [`LOCAL-03_IDENTITY_MODE.md`](LOCAL-03_IDENTITY_MODE.md) 已提供
仅在 `local-synthetic` 可用的进程内合成身份和 session 入口，但数据尚未写入 PostgreSQL，
因此不能声称本地身份持久化或任何 Release 1 业务能力已端到端可用。
