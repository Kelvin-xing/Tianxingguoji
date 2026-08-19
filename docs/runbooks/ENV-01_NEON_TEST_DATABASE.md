# ENV-01 Neon 合成测试数据库运行手册

## 1. 目的与当前边界

本手册记录 `txgj_env01_test` 的 bootstrap 状态，以及后续 migration 和纯合成 seed 顺序。bootstrap 已按独立审批完成；当前仍未授权执行 migration/seed、修改 Vercel 或部署。

固定目标：

- Neon Project：`neon-cordovan-prism`（Project ID `tiny-shadow-03951882`）
- Branch：`main`
- Region：AWS `us-east-1`
- Database：`txgj_env01_test`
- migration login：`env01_migration_login`
- endpoint：Neon direct endpoint；hostname 不得包含 `-pooler`
- TLS：证书校验必须开启，`rejectUnauthorized=true`

`neondb` 保留，不删除、不清理。所有数据必须为合成数据。

当前状态（截至 2026-08-19）：

- Neon SQL Editor 已确认以 `neondb_owner` 身份执行；
- `txgj_env01_test`、`env01_migration_login`、角色授权和首次密码初始化已验收；
- 本机通过外部 Direct endpoint 使用 `env01_migration_login` 登录尚未确认；
- migration dry-run/apply 和 seed dry-run/apply 均未执行。

## 2. 审批门

以下 bootstrap 项已经用户逐项批准并验收：

1. Neon SQL Editor 的执行身份为 `neondb_owner`。
2. 创建 `env01_migration_login`。
3. 授予 `rds_iam WITH ADMIN OPTION`。
4. 创建 `txgj_env01_test`。
5. 首次初始化 `env01_migration_login` 密码。

以下动作仍必须分别获得用户明确批准，前一项通过不自动批准后一项：

1. migration dry-run。
2. migration apply。
3. seed dry-run。
4. seed apply。

密码和连接串绝不能进入 Git 或 GitHub。允许操作员在 Neon Console 查看，并保存在本机 Git 已忽略且权限为 `0600` 的操作员文件中。migration secret 仍不得出现在聊天、截图、命令输出、应用环境或 Vercel 环境中，也不得放入命令行参数、终端历史或可复用 SQL 文件。第 4.1 节记录的首次初始化是唯一的 SQL Editor 明文例外。

## 3. 本地无连接计划

此命令只读取 `db/migrations/manifest.json` 和 27 个 SQL 文件，重新计算 SHA-256，不读取环境文件，也不连接数据库：

```bash
pnpm db:plan:neon-test
```

预期：JSON 只包含目标逻辑标识、TLS 状态、manifest 版本/数量/SHA-256、迁移名称与哈希、事务策略和 `status`。

## 4. 已验收的 Bootstrap 操作

### 4.1 首次密码初始化例外

Neon 对 SQL 创建且初始为 `PASSWORD NULL` 的角色执行控制面密码 reset 时，与本机 `psql` 18 的 client-hash 初始化路径不兼容。用户明确接受该次 bootstrap 风险后，已在 Neon SQL Editor 中以 `neondb_owner` 身份一次性执行明文密码初始化，操作形态如下：

```sql
ALTER ROLE env01_migration_login PASSWORD '<ONE_TIME_OPERATOR_SECRET>';
```

`<ONE_TIME_OPERATOR_SECRET>` 只是占位符，实际密码不得写入本手册、Git、GitHub、聊天、截图或命令输出。该例外只适用于首次初始化，不得扩展为日常登录、密码轮换、migration、seed 或其他角色管理方式。

### 4.2 创建 migration login

该步骤已经验收。migration login 的固定属性和授权为：

```sql
CREATE ROLE env01_migration_login
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  CREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD NULL;

GRANT rds_iam TO env01_migration_login WITH ADMIN OPTION;
```

不得授予 `neon_superuser`、其他角色成员关系或对象权限。

### 4.3 创建 Database

该步骤已经验收。`CREATE DATABASE` 不属于 migration 事务，固定目标为：

```sql
CREATE DATABASE txgj_env01_test OWNER env01_migration_login;
```

异常时停止，不自行 `DROP DATABASE`、`DROP ROLE` 或修改权限。

## 5. 本地 secret 文件

创建 Git 已忽略的操作员文件：

```bash
cp .env.migration.neon-test.example .env.migration.neon-test
chmod 600 .env.migration.neon-test
```

由用户在本机编辑 `TEST_MIGRATION_DATABASE_URL`。URL 必须：

- 使用 `postgresql:`；
- user 为 `env01_migration_login`；
- database 为 `txgj_env01_test`；
- hostname 匹配 `ep-*.us-east-1.aws.neon.tech` 且不含 `-pooler`；
- 显式端口 `5432`；
- 不含 query 或 hash；
- 密码非空。

该文件不得加载到 Next.js 或 Vercel。不得设置 `DATABASE_URL` 或 `MIGRATION_DATABASE_URL`。

本机 Direct 连接仍是待确认状态。使用本机 libpq/`psql` 18 验证时，密码只允许交互式输入，连接参数必须同时保留 `sslmode=verify-full` 和已经验证的系统 CA 路径：

```bash
psql "host=<DIRECT_HOST> port=5432 dbname=txgj_env01_test user=env01_migration_login sslmode=verify-full sslrootcert=system"
```

该命令成功只代表外部 Direct migration login 可用，不代表 migration dry-run、migration apply 或任何 seed 已经执行或通过。

## 6. Migration 顺序

未来获得逐项批准后的命令：

```bash
pnpm db:migrate:neon-test:dry-run
pnpm db:migrate:neon-test
```

runner 在连接后强制检查：

- database/user/owner 精确匹配；
- migration role 属性和 `rds_iam` ADMIN OPTION；
- migration role 与 `rds_iam` 均不属于 `neon_superuser`；
- public 表为 0、正式 ledger 不存在；
- migration 将创建的 7 个角色不存在；
- 不存在上一次遗留的 ENV-01 dry-run schema。

执行策略固定为 `node-pg-migrate@9.0.0`、`checkOrder=true`、`singleTransaction=true`、`advisoryLockMode=fail`、`noLock=false`。runner 在执行前后都重新验证 manifest。

dry-run 使用唯一临时 ledger schema；它不执行业务 SQL，结束时只删除本次创建的临时 schema，并验证正式 ledger、public 表和 migration roles 仍为空。若临时 schema 清理失败，停止，不继续 apply。

apply 成功预期：

- `migration.schema_migrations` 为 27 条且顺序与 manifest 完全一致；
- public tables 为 63；
- 最后一项为 `202608180120_028_expand_database_test_identity`；
- migration 028 SHA-256 为 `a03e584fac57648abdc4049dbd05e00c35d2ec1a3fc3b06297b4b757574332bb`；
- migration 创建的角色均不属于 `neon_superuser`，且无 superuser/createdb/createrole/replication/bypassrls 属性。

apply 失败时 runner 验证正式 `migration` ledger schema 不存在、ledger 行仍为 0、public 表仍为 0、migration roles 不存在。若未完整回滚，立即停止；不得重试或人工清理。

## 7. 纯合成 Seed

未来获得逐项批准后的命令：

```bash
pnpm db:seed:neon-test:dry-run
pnpm db:seed:neon-test
```

seed 只在完整 27 条 ledger、63 张 public 表时运行，并在事务内锁定本 seed 涉及的表。业务数据必须处于以下两种状态之一：

- 所有 public 业务表为空：允许首次写入；
- public 中只存在本手册固定 UUID 的完整 ENV01 seed，且逐字段、manifest hash、school hash、approved 状态和 synthetic-only 标记全部一致：允许幂等复验，不重复写入。

任何部分 seed、额外业务行、固定 UUID 内容漂移或 hash/状态不一致都会失败。所有首次写入位于一个 `SERIALIZABLE` 单事务中；dry-run 最终 `ROLLBACK`，并验证回滚后状态与运行前完全一致。apply 后由 owner 重新验证完整固定内容。

首版固定内容：

| 数据 | 数量 |
| --- | ---: |
| Organization | 1 |
| User / Membership / RoleBinding | 5 / 5 / 5 |
| Student / Guardian / Relationship | 2 / 2 / 2 |
| approved assessment manifest / fields | 1 / 15 |
| School / active snapshot / records | 3 / 1 / 3 |

seed 不创建密码、verifier、`identity_database_test_credentials`、Session、Case、Document、Portal key、Audit 或 Outbox 证据。Case 留给浏览器端到端验收创建。

## 8. 安全证据模板

Migration 示例（所有值均为非秘密元数据）：

```json
{
  "mode": "apply",
  "endpoint_kind": "neon-direct",
  "target_database": "txgj_env01_test",
  "migration_login": "env01_migration_login",
  "tls": { "verified": true, "reject_unauthorized": true },
  "manifest": {
    "version": 1,
    "count": 27,
    "sha256": "<MANIFEST_SHA256>",
    "migrations": [{ "name": "<ORDERED_NAME>", "sha256": "<SHA256>" }]
  },
  "ledger": { "before": 0, "after": 27 },
  "public_table_count": { "before": 0, "after": 63 },
  "transaction_policy": {
    "tool": "node-pg-migrate",
    "version": "9.0.0",
    "check_order": true,
    "single_transaction": true,
    "advisory_lock_mode": "fail",
    "no_lock": false
  },
  "status": "pass"
}
```

Seed 示例：

```json
{
  "mode": "apply",
  "endpoint_kind": "neon-direct",
  "target_database": "txgj_env01_test",
  "migration_login": "env01_migration_login",
  "tls": { "verified": true, "reject_unauthorized": true },
  "manifest": { "version": 1, "count": 27, "sha256": "<MANIFEST_SHA256>" },
  "ledger": { "before": 27, "after": 27 },
  "public_table_count": { "before": 63, "after": 63 },
  "seed": {
      "version": "env01-neon-release1-v1",
      "synthetic_only": true,
      "manifest_content_sha256": "<MANIFEST_CONTENT_SHA256>",
      "school_snapshot_manifest_sha256": "<SCHOOL_SNAPSHOT_MANIFEST_SHA256>",
      "rows": {
      "organizations": 1,
      "users": 5,
      "memberships": 5,
      "role_bindings": 5,
      "students": 2,
      "guardians": 2,
      "relationships": 2,
      "assessment_manifests": 1,
      "manifest_fields": 15,
      "schools": 3,
      "school_snapshots": 1,
      "school_records": 3
    }
  },
  "status": "pass"
}
```

后续 application/identity login 创建并单独批准连接后，使用源码中的
`validateNeonTestRuntimeBoundary()` 校验以下 future evidence contract。此模板只是预期合同，不代表本轮已经连接或验证：

```json
{
  "identity": {
    "member_of_expected_group": true,
    "can_read_credentials": true,
    "can_write_business_data": false,
    "can_run_ddl": false
  },
  "application": {
    "member_of_expected_group": true,
    "can_read_business_data": true,
    "can_write_business_data": true,
    "can_read_credentials": false,
    "can_run_ddl": false
  },
  "status": "pass"
}
```

证据不得包含 hostname、连接串、密码、Token、API Key、数据库行内容或 email。异常输出只允许脱敏后的单行消息，不输出 stack trace。

## 9. 回滚与停止条件

- bootstrap 任一步异常：停止；不自动删除 Database/Role。
- migration 失败且完整回滚：正式 `migration` ledger schema 不存在，且为 0 ledger、0 public tables、0 migration roles；随后停止，不重试。
- migration 未完整回滚：立即升级给架构师；不得人工清理。
- seed 失败：事务 `ROLLBACK` 后停止；不得跳过检查、手工补数据或将部分 seed 当作幂等成功。
- 已执行 migration 后不修改历史 migration；修复只能使用后续经批准的追加迁移。
- Vercel、identity/application/provision login 和部署属于后续独立审批，不在本手册当前执行范围。
