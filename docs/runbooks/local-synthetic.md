# Local Synthetic Runtime Runbook

## 目的与边界

本手册用于在开发机器上启动 Release 1 的本地依赖：PostgreSQL 17、
LocalStack S3/SQS 和 ClamAV。环境只允许确定性合成数据，不连接 Neon、
AWS、Vercel 或其他外部业务系统。

本地模式必须显式设置 `APP_RUNTIME_MODE=local-synthetic` 和
`AUTH_MODE=local-synthetic`。应用在
`NODE_ENV=production`、模式缺失或端点不是回环地址时拒绝加载本地配置。
生产 RDS 配置和现有 `/api/v1/health` 契约不受本手册影响。

`AUTH_MODE` 是服务端身份适配器开关：`local-synthetic` 显示本地角色登录，
`cognito` 关闭本地角色入口并使用 Cognito Managed Login。切换后必须重启 Next.js；
浏览器不能修改该值。生产环境使用 `local-synthetic` 会 fail closed。

## 运行资源

| 服务 | 本机端口 | 本地用途 |
|---|---:|---|
| PostgreSQL 17.10 | `127.0.0.1:5432` | 已重放 Release 1 迁移，后续保存合成业务数据 |
| LocalStack S3/SQS | `127.0.0.1:4566` | 模拟私有文档对象存储、扫描队列和死信队列 |
| ClamAV 1.4.5 | `127.0.0.1:3310` | 为后续扫描 Worker 提供 `clamd` 协议 |

Compose 首次创建以下本地资源：

- PostgreSQL 数据库 `tianxing`、迁移账号和无表权限的健康探测账号；
- 启用版本控制的 S3 桶 `tianxing-local-documents`；
- SQS 队列 `tianxing-local-document-scan`；
- 死信队列 `tianxing-local-document-scan-dlq`，主队列在三次失败后转入；
- ClamAV 守护进程和病毒特征库。

这些名称、密码和 `test` AWS 凭据只适用于回环网络，不能复制到其他环境。

## 前置条件

需要可用的 Docker CLI、Docker Compose v2 和一个本机容器运行时。项目计划选择
Colima，但本手册不负责安装或修改容器运行时。ClamAV 官方建议为扫描进程预留
足够内存；容器运行时资源不足时，它可能长时间启动或被系统终止。

## 首次启动

在仓库根目录执行：

```sh
cp .env.local.example .env.local
cp .env.migration.local.example .env.migration.local
pnpm local:up
pnpm local:ps
```

`local:up` 使用 `docker compose ... up -d --wait`，只有 Compose 认为依赖已就绪
后才返回成功。ClamAV 首次加载特征库通常比另外两个服务慢。

然后启动 Next.js：

```sh
pnpm db:plan:local
pnpm db:migrate:local:dry-run
pnpm db:migrate:local
pnpm db:seed:local-identity
pnpm dev
```

打开 `http://localhost:3000/login`，选择 Founder、Admin、Advisor、Data reviewer
或 Contractor，再点击“使用本地角色登入”。本地身份和会话保存在 PostgreSQL；
只要数据库卷仍存在且 Session 未过期或撤销，重启开发服务器不会使它失效。

检查原有存活接口：

```sh
curl --fail http://127.0.0.1:3000/api/v1/health
```

检查本地依赖接口：

```sh
curl --fail http://127.0.0.1:3000/api/v1/local/readiness
```

全部可用时，第二个接口返回 `status: ready`，并将 `postgresql`、
`postgresql_identity`、`localstack_s3`、`localstack_sqs` 和 `clamav` 标为 `ready`。
其中 `postgresql` 只检查健康账号连通性，`postgresql_identity` 还会检查受限身份账号、
五个合成角色和 Session schema。任一依赖不可用时
返回 HTTP 503 和经过白名单过滤的状态；响应不会包含连接串、端点或原始错误。
非本地模式访问该路径返回 HTTP 404。

## 资源核验

容器运行后可执行以下只读检查：

```sh
docker compose -f compose.local.yml exec localstack \
  awslocal s3api get-bucket-versioning --bucket tianxing-local-documents

docker compose -f compose.local.yml exec localstack \
  awslocal sqs get-queue-url --queue-name tianxing-local-document-scan

docker compose -f compose.local.yml exec localstack \
  awslocal sqs get-queue-url --queue-name tianxing-local-document-scan-dlq
```

PostgreSQL 的 Compose 健康检查执行 `pg_isready`；应用 readiness 另外使用
`tianxing_health` 执行 `SELECT 1`。LocalStack 的 Compose 健康检查要求桶、主队列
和死信队列都已存在。应用通过 LocalStack 健康 API 检查 S3/SQS 服务状态。
ClamAV 应用探测发送官方 `zPING\0` 命令并要求 `PONG`。

## 数据库迁移

启动 Compose 不会自动执行 `db/migrations`。首次创建空库后，按顺序执行：

```sh
pnpm db:plan:local
pnpm db:migrate:local:dry-run
pnpm db:migrate:local
pnpm db:seed:local-identity
```

迁移进程只读取被 Git 忽略的 `.env.migration.local`，Next.js 继续只读取
`.env.local`，因此应用进程不持有迁移 owner 凭据。runner 只接受非生产
`local-synthetic` 模式、回环端点、`tianxing` 数据库和 `tianxing_migration` 用户，
并在连接前验证 `db/migrations/manifest.json` 的有序 SHA-256 清单。

`dry-run` 会创建空的 `migration.schema_migrations` 跟踪表，但不执行业务 SQL。
`apply` 使用 advisory lock、5 秒 statement/lock timeout 和单事务；重复执行在完整
ledger 上安全返回 no-op。历史迁移一旦应用便不得修改，修复必须新增迁移。

2026-08-17 已从空库应用最初 15 份迁移；2026-08-18 再追加应用两份身份迁移，当前
ledger 为 17，public schema 仍有 61 张表。尚未重新执行“17 份迁移从空库完整重放”，
因此不能把增量应用记录描述成新的空库恢复证据。

`db:seed:local-identity` 同时读取 `.env.local` 和 `.env.migration.local`，只接受固定回环
数据库、`local-synthetic` 非生产模式和本地专用账号。它可以重复执行，不会重置数据库
或删除 Session；发现固定身份资料漂移时会失败，而不是静默覆盖。

## 停止与重置

保留数据卷并停止服务：

```sh
pnpm local:down
```

删除 PostgreSQL 命名卷会清空本地数据库，属于破坏性操作。本手册不把该动作放入
项目脚本；执行前必须再次确认目标只属于 `tianxing-local` 且不含真实数据。
LocalStack 在当前免费本地配置中不启用授权版持久化；容器重建后，ready hook 会
重新创建空桶和队列，因此只能存放可随时重建的合成测试数据。

## 当前验证状态

2026-08-17 已安装 Colima、Docker CLI 和 Docker Compose，并启动名为 `tianxing`
的 Colima profile（4 CPU、8 GiB 内存、40 GiB 磁盘）。PostgreSQL、LocalStack 和
ClamAV 容器均为 `healthy`，以下实机检查通过：

- `tianxing_health` 执行 `SELECT 1`；
- S3 桶版本控制状态为 `Enabled`，主队列和死信队列可读取；
- ClamAV `zPING\0` 返回 `PONG`；
- `/api/v1/health` 与 `/api/v1/local/readiness` 返回 HTTP 200，后者将四项依赖标为
  `ready`；
- 首页返回 HTTP 200，12 项本地底座聚焦测试通过。

本地底座状态为 `local_identity_postgresql_validated`。本地角色登录、HttpOnly opaque
session、`/api/v1/auth/me`、Next.js 重启后复用同一 Session 和登出撤销已经端到端通过；
readiness 的五项依赖均为 `ready`。其他领域 runtime 和 Worker 尚未接通，因此这不代表
Release 1 的业务 API 已经端到端可用。
