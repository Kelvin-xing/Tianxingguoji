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

示例文件使用明确的本地占位密码 `not-a-secret`。如需替换，请同时更新
`.env.local` 中的 `LOCAL_SYNTHETIC_POSTGRES_PASSWORD`、数据库 URL，以及
`.env.migration.local` 中的 operator URL；这些本机文件均被 Git 忽略。

`local:up` 使用 `.env.local` 向 Compose secret 提供密码，PostgreSQL 容器只通过
`POSTGRES_PASSWORD_FILE` 读取它。命令随后执行 `docker compose ... up -d --wait`；只有 Compose 认为依赖已就绪
后才返回成功。ClamAV 首次加载特征库通常比另外两个服务慢。

然后启动 Next.js：

```sh
pnpm db:plan:local
pnpm db:baseline:local:dry-run
pnpm db:baseline:local
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
`postgresql_identity`、`postgresql_application`、`localstack_s3`、`localstack_sqs` 和
`clamav` 标为 `ready`。三个 PostgreSQL 检查都使用同一个 `tianxing_app` 连接：基础检查
验证连接身份，`postgresql_identity` 检查 identity seed 和 Session schema，
`postgresql_application` 检查学生和 approved manifest 数据。任一依赖不可用时
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

PostgreSQL 的 Compose 健康检查执行 `pg_isready`；应用 readiness 使用同一个
`tianxing_app` 连接执行身份和数据检查。LocalStack 的 Compose 健康检查要求桶、主队列
和死信队列都已存在。应用通过 LocalStack 健康 API 检查 S3/SQS 服务状态。
ClamAV 应用探测发送官方 `zPING\0` 命令并要求 `PONG`。

## 数据库迁移

启动 Compose 不会自动执行数据库 baseline。当前仓库已经生成独立的单角色 baseline；它不修改历史
`db/migrations`，也不会自动连接数据库：

```sh
pnpm db:baseline:plan
pnpm db:baseline:local:dry-run
pnpm db:baseline:local
pnpm db:seed:local-identity
pnpm db:seed:local-release1
```

baseline runner 只接受被 Git 忽略的 `.env.migration.local`，并要求 URL、数据库和
`tianxing_app` 完全匹配；Next.js 只读取 `.env.local`，应用进程不持有 operator 文件。
历史 runner 使用过的 `tianxing_migration` 仅作为旧实机记录，不能作为新合同。

baseline `dry-run` 在单事务中执行 28 个生成文件并回滚；它不会留下历史
`migration.schema_migrations`，只在 apply 时写入独立的 `tianxing_baseline.installations` marker。
apply 使用 advisory lock、超时和单事务；已安装 marker 与 manifest 不匹配时会拒绝重复安装。
历史迁移一旦应用便不得修改，修复必须新增迁移或重新生成经过审查的 baseline。

旧本地数据库曾按历史 migration ledger 应用过结构；该状态不等于当前 one-role baseline
已安装。单角色 baseline 目标要求空的 public schema 和不存在的 baseline marker，必须在
明确批准后针对目标库重新验收。

两个 local seed 都先验证 baseline marker、owner 属性和固定合成数据，再在同一 `tianxing_app` 连接内写入；
它们会显式设置 `app.organization_id`/`app.actor_user_id`，以适配 FORCE RLS。seed 仍是独立操作，未因
baseline 代码生成而自动执行。

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
的 Colima profile（4 CPU、8 GiB 内存、40 GiB 磁盘）。以下是历史实机记录；单角色改造后
需要重新执行本地 baseline 验收：

- 旧 `tianxing_health` 检查仅属于历史记录，不再作为运行时账号；新检查统一使用 `tianxing_app`；
- S3 桶版本控制状态为 `Enabled`，主队列和死信队列可读取；
- ClamAV `zPING\0` 返回 `PONG`；
- `/api/v1/health` 与 `/api/v1/local/readiness` 返回 HTTP 200，后者将六项依赖标为
  `ready`；
- 首页返回 HTTP 200，12 项本地底座聚焦测试通过。

当前源码状态为 `one_role_baseline_unapplied`。本轮只做了离线生成、哈希、事务模拟和聚焦测试；没有连接
数据库，也没有执行 baseline 或 seed，因此不能把历史实机记录当作当前单角色状态。其他领域 runtime 和
Worker 尚未接通，因此这不代表 Release 1 的业务 API 已经端到端可用。
