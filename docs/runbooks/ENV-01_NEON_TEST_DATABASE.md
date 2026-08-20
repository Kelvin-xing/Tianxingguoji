# ENV-01 Neon 合成测试数据库运行手册

## 1. 目的与当前边界

> **单角色裁决（2026-08-20）**：local、Vercel test 和 AWS production 的唯一 runtime login
> role 为 `tianxing_app`。本手册中 `env01_migration_login`、`rds_iam` 及其他 operator/group role
> 只代表历史 ENV-01C migration 运行记录，不得作为新的运行时或 one-role baseline 依据。新的独立合同见
> `db/baselines/one-role/manifest.json`，当前状态为 `executable-unapplied`：代码已生成并验算，但尚未执行。

本手册记录 `txgj_env01_test` 的 bootstrap 状态，以及后续 migration 和纯合成 seed 顺序。bootstrap 已按独立审批完成；当前仍未授权执行 migration/seed、修改 Vercel 或部署。

固定目标：

- Neon Project：`neon-cordovan-prism`（Project ID `tiny-shadow-03951882`）
- Branch：`main`
- Region：AWS `us-east-1`
- Database：`txgj_env01_test`
- runtime / baseline login：`tianxing_app`
- endpoint：Neon direct endpoint；hostname 不得包含 `-pooler`
- TLS：证书校验必须开启，`rejectUnauthorized=true`

`neondb` 保留，不删除、不清理。所有数据必须为合成数据。

当前状态（截至 2026-08-19）：

- 历史 bootstrap 已确认 `txgj_env01_test` 和旧 operator 角色曾存在；这些角色不属于当前单角色合同；
- 当前 baseline runner 只接受 `tianxing_app` 的 Direct endpoint；没有执行 baseline、migration 或 seed；
- 上一次 apply 已获批准并执行，但业务 SQL 失败；只读证据为 0 ledger rows、0 public tables、0 migration roles、0 stale dry-run schemas；
- 上一次失败留下的 exact empty tool metadata 已按独立审批完成受控 cleanup；
- cleanup 后由独立新连接确认 `migration` schema/ledger 均不存在、public tables 为 0、migration roles 为 0、stale dry-run schemas 为 0；
- 最近一次真实事务 dry-run 在事务开始前的 preflight inspection 因 metadata SQL 使用 PostgreSQL 保留字别名而停止，未执行 27 个 SQL、DDL 或 DML；现已改用安全别名，并将 preflight/postflight inspection 异常固定为脱敏结构化 evidence；
- 单角色 baseline 的离线生成、manifest 哈希和事务模拟已通过；真实数据库 dry-run、apply、seed dry-run/apply 均未执行。

## 2. 审批门

以下历史 bootstrap 项已经用户逐项批准并验收，但不再作为当前单角色执行入口：

1. Neon SQL Editor 的执行身份为 `neondb_owner`。
2. 创建 `env01_migration_login`。
3. 授予 `rds_iam WITH ADMIN OPTION`。
4. 创建 `txgj_env01_test`。
5. 首次初始化 `env01_migration_login` 密码。

当前单角色动作仍必须分别获得用户明确批准，前一项通过不自动批准后一项：

1. 单角色 baseline dry-run。
2. 单角色 baseline apply。
3. synthetic seed dry-run。
4. synthetic seed apply。

上一次 metadata cleanup 已作为独立审批完成，不授权当前 baseline dry-run 或 apply。baseline preflight
继续拒绝非空 public schema、已有 marker 或异常 owner；runner 不会自动 `DROP`。历史 ledger/residue 的清理结论来自上一次独立 postcheck，不由当前 one-role marker 取代。

密码和连接串绝不能进入 Git 或 GitHub。允许操作员在 Neon Console 查看，并保存在本机 Git 已忽略且权限为 `0600` 的操作员文件中。migration secret 仍不得出现在聊天、截图、命令输出、应用环境或 Vercel 环境中，也不得放入命令行参数、终端历史或可复用 SQL 文件。第 4.1 节记录的首次初始化是唯一的 SQL Editor 明文例外。

## 3. 本地无连接计划

此命令验证独立 one-role manifest、28 个 generated SQL（27 个源迁移转换结果加 1 个 hardening 文件），并回溯验证历史 manifest 与所有源 SHA-256；不读取环境文件，也不连接数据库：

```bash
pnpm db:plan:neon-test
```

预期：JSON 只包含 baseline id、源/生成文件数量、manifest SHA-256、事务合同、独立 marker 和 `status`。

## 4. 已验收的 Bootstrap 操作

### 4.1 首次密码初始化例外

Neon 对 SQL 创建且初始为 `PASSWORD NULL` 的角色执行控制面密码 reset 时，与本机 `psql` 18 的 client-hash 初始化路径不兼容。用户明确接受该次 bootstrap 风险后，已在 Neon SQL Editor 中以 `neondb_owner` 身份一次性执行明文密码初始化，操作形态如下：

```sql
ALTER ROLE env01_migration_login PASSWORD '<ONE_TIME_OPERATOR_SECRET>';
```

`<ONE_TIME_OPERATOR_SECRET>` 只是占位符，实际密码不得写入本手册、Git、GitHub、聊天、截图或命令输出。该例外只适用于首次初始化，不得扩展为日常登录、密码轮换、migration、seed 或其他角色管理方式。

### 4.2 历史 migration login（仅存档）

该步骤已经验收，但角色只属于历史 ENV-01C 操作记录；当前 baseline 不使用它，也不要求重新创建：

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

### 4.3 历史 Database bootstrap（仅存档）

该步骤已经验收。`CREATE DATABASE` 不属于 migration 事务；后续代码只把该空库作为
`tianxing_app` owner 的单角色 baseline 目标，不再使用旧 migration login：

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

由用户在本机编辑 `ONE_ROLE_BASELINE_DATABASE_URL`。URL 必须：

- 使用 `postgresql:`；
- user 为 `tianxing_app`；
- database 为 `txgj_env01_test`；
- hostname 匹配 Neon Direct 格式 `ep-*.(c-<数字>.)?us-east-1.aws.neon.tech`，允许 Neon 当前的 cell 标签（例如 `c-2`），且 endpoint ID 不含 `-pooler`；
- 显式端口 `5432`；
- 不含 query 或 hash；
- 密码非空。

该文件不得加载到 Next.js 或 Vercel。不得设置 `DATABASE_URL` 或 `MIGRATION_DATABASE_URL`。

独立 Direct `psql` 登录不是 baseline 的必要 gate；如需单独验证，使用本机 libpq/`psql` 连接
`tianxing_app`，密码只允许交互式输入，连接参数必须同时保留 `sslmode=verify-full` 和已经验证的系统 CA 路径：

```bash
psql "host=<DIRECT_HOST> port=5432 dbname=txgj_env01_test user=tianxing_app sslmode=verify-full sslrootcert=system"
```

该命令成功只代表外部 Direct baseline login 可用，不代表 baseline dry-run、baseline apply 或任何 seed 已经执行或通过。

## 6. Migration 顺序

未来获得逐项批准后的命令：

```bash
pnpm db:baseline:neon-test:dry-run
pnpm db:baseline:neon-test
```

runner 在连接后强制检查：

- database/user/owner 精确匹配为 `txgj_env01_test` / `tianxing_app`；
- `tianxing_app` 为可登录、非 superuser、不可 CREATEDB/CREATEROLE/INHERIT/REPLICATION/BYPASSRLS；
- public schema 中没有业务对象，独立 baseline marker 不存在；
- RLS/SECURITY DEFINER hardening 计数处于空库预期状态；
- 同一事务取得 advisory lock 后、首个 generated SQL 前，再次执行同样的 preflight，避免检查与执行之间的状态竞争。

baseline 执行策略固定为单事务、transaction-scoped advisory lock、每个生成文件的 SHA-256 复核和独立 marker；runner 在执行前后都重新验证 manifest。

baseline dry-run 不使用 `node-pg-migrate dryRun`，因为该模式只打印 SQL，不能证明冻结 SQL 文件可由 PostgreSQL 执行。新 dry-run 使用一个显式事务和 transaction-scoped advisory lock，严格按 baseline manifest 顺序执行 28 个生成文件；每个文件在执行前后都重新读取并校验 SHA-256，并把整个文件作为一次 query 交给 PostgreSQL，不自行拆分 SQL。无论成功或失败都只执行 `ROLLBACK`，不执行 `COMMIT`，也不创建历史 migration ledger。事务结束后使用独立连接复验 public objects、baseline marker、RLS 和 SECURITY DEFINER 状态均与 preflight 空状态一致。

preflight、rollback verification 和 postflight 的 manifest/database inspection 均使用固定 `failure_stage`，只保留可验证的 migration name（若已确定）和合法 SQLSTATE；PostgreSQL message、detail、query、where、stack、hostname、连接串和 secret 不进入 CLI evidence。

### 6.1 历史 ENV-01C apply 事故与 metadata 分类（仅存档）

以下内容描述旧的多角色 `node-pg-migrate` 运行记录，不是当前单角色 baseline 的执行合同；
它保留在本手册中用于解释历史残留和 cleanup 证据。

`node-pg-migrate@9.0.0` 会在其 single-transaction `BEGIN` 之前创建 `migration` schema 并确保 `migration.schema_migrations` 存在。因此，上一次业务 SQL 失败并回滚后，仍留下了工具 metadata：空 ledger table、对应 sequence、index 和 primary-key constraint。0 ledger rows、0 public tables 和 0 migration roles 证明业务变更已回滚，但不代表数据库完全回到 preflight 状态。

该 residue 随后已通过独立审批的受控 cleanup 移除，并由独立新连接取得 schema/ledger absent、0 public tables、0 migration roles 和 0 stale dry-run schemas 的 postcheck。该完成事实不能作为后续 dry-run、apply 或 seed 的授权。

失败后的只读分类固定为：

- 完全无 `migration` schema/owner、ledger、metadata objects、class owners、外部用户依赖、public tables 和 migration roles：`clean`；
- 只有 `migration` schema、0-row `schema_migrations` 和该表唯一预期的 table/sequence/index/PK，schema 及全部 class objects 均由 `env01_migration_login` 拥有，外部用户依赖为 0，且 public tables 和 migration roles 均为 0：`metadata_cleanup_required`；
- ledger 非空、存在 public table/role、schema 或 class owner 错误、外部用户依赖非 0、对象集合不精确或出现其他 residue：回滚验证失败，必须架构升级。

`metadata_cleanup_required` 只表示 business rollback passed；它不会触发自动清理。清理需要独立审批，清理前 preflight 必须继续 fail closed。

失败证据只输出固定 failure stage、manifest 中的 migration name（能够确定时）和合法 PostgreSQL SQLSTATE/code。不得输出数据库 message、query、detail、stack、hostname、连接串或 secret。若 migration 执行和独立 rollback/state verification 同时失败，输出必须同时保留两份脱敏证据，并以 rollback/state verification failure 为最高优先级。

apply 成功预期：

- `migration.schema_migrations` 为 27 条且顺序与 manifest 完全一致；
- `migration` schema 和全部 ledger class objects 均由 `env01_migration_login` 拥有，metadata 外部用户依赖为 0；
- public tables 为 63；
- 最后一项为 `202608180120_028_expand_database_test_identity`；
- migration 028 SHA-256 为 `a03e584fac57648abdc4049dbd05e00c35d2ec1a3fc3b06297b4b757574332bb`；
- migration 创建的角色均不属于 `neon_superuser`，且无 superuser/createdb/createrole/replication/bypassrls 属性。

apply 失败时 runner 使用独立连接验证 ledger rows、public tables、migration roles、schema/class owners、外部用户依赖和 `migration` schema 对象集合，并只接受 `clean` 或 exact empty tool metadata 两种分类。前者停止且不重试；后者停止并等待独立 cleanup 审批。其他状态均按回滚不完整处理并立即升级。

## 7. 纯合成 Seed

未来获得逐项批准后的命令：

```bash
pnpm db:seed:neon-test:dry-run
pnpm db:seed:neon-test
```

seed 只在 one-role marker 的 id、transform version、baseline manifest SHA-256 和 source count 全部匹配，且所有 seed 必需表均存在时运行。public 表总数按实际 baseline 读取，不再硬编码为 63；seed 会逐表拒绝任何非固定 synthetic fixture 的业务行，并在事务内锁定本 seed 涉及的表。业务数据必须处于以下两种状态之一：

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
  "baseline_id": "tianxing-one-role-v1",
  "canonical_login_role": "tianxing_app",
  "source_migrations": 27,
  "generated_files": 28,
  "manifest_sha256": "<BASELINE_MANIFEST_SHA256>",
  "transaction_contract": {
    "single_transaction": true,
    "advisory_lock": "transaction-scoped",
    "dry_run": "rollback",
    "apply": "commit"
  },
  "marker": "installed",
  "status": "pass"
}
```

Seed 示例：

```json
{
  "mode": "apply",
  "endpoint_kind": "neon-direct",
  "canonical_login_role": "tianxing_app",
  "tls": { "verified": true, "reject_unauthorized": true },
  "baseline": {
    "id": "tianxing-one-role-v1",
    "transform_version": "one-role-transform-v1",
    "source_migration_count": 27,
    "manifest_sha256": "<BASELINE_MANIFEST_SHA256>"
  },
  "marker": { "before": "verified", "after": "verified" },
  "public_table_count": "<OBSERVED_COUNT>",
  "database_isolation": {
    "model": "single-owner-role",
    "credential_table_owner_access_is_residual_risk": true
  },
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

后续真实连接获批后，使用源码中的 `validateNeonTestRuntimeBoundary()` 校验以下单角色证据合同。此模板只是预期合同，不代表本轮已经连接或验证：

```json
{
  "user_name": "tianxing_app",
  "database_owner": "tianxing_app",
  "login": true,
  "superuser": false,
  "create_database": false,
  "create_role": false,
  "inherit": false,
  "replication": false,
  "bypass_rls": false,
  "credential_table_owner": "tianxing_app",
  "credential_table_owner_access_is_residual_risk": true,
  "status": "pass"
}
```

单角色 owner 仍可执行 DDL，也能直接读取其拥有的 credential table；`FORCE ROW LEVEL SECURITY`、安全的 `SECURITY DEFINER` 和应用层授权只能缩小风险，不能在同一数据库凭据泄露后提供角色隔离。

证据不得包含 hostname、连接串、密码、Token、API Key、数据库行内容或 email。异常输出只允许脱敏后的单行消息，不输出 stack trace。

## 9. 回滚与停止条件

- bootstrap 任一步异常：停止；不自动删除 Database/Role。
- migration 失败且状态完全干净：记录 business rollback passed，随后停止，不重试。
- migration 失败且只有 exact empty tool metadata：记录 business rollback passed + metadata cleanup required；停止且不得自动 `DROP`，等待独立 cleanup 审批。
- migration 失败且存在业务对象、ledger rows、migration roles 或非精确 metadata：按回滚不完整处理，立即升级给架构师；不得人工清理。
- seed 失败：事务 `ROLLBACK` 后停止；不得跳过检查、手工补数据或将部分 seed 当作幂等成功。
- 已执行 migration 后不修改历史 migration；修复只能使用后续经批准的追加迁移。
- Vercel、identity/application/provision login 和部署属于后续独立审批，不在本手册当前执行范围。
