# Local Synthetic Runtime Runbook

> **Current file-runtime boundary (2026-08-26).** LocalStack、ClamAV、本地文档
> Worker 和本地 S3/SQS 初始化已经停用。当前本地 Compose 只启动 PostgreSQL；
> 本地与 Vercel test/preview 共用同一组文档 API、版本、能力 URL、扫描状态和
> fail-closed 语义。由于真实 S3 尚未接入，非生产环境必须显式使用
> `DOCUMENT_TRANSPORT_MODE=deterministic-fake`，该假传输/假扫描只用于开发验证，
> 不代表生产存储或病毒扫描能力。

下方旧的 LocalStack/ClamAV 启动、资源核验和 Worker 命令仅作为历史记录保留，
不可再执行；它们不再是当前本地运行流程。

如果 `docker ps` 仍显示旧的 LocalStack 或 ClamAV 容器，那是变更前 Compose
创建的存量容器；修改 Compose 文件不会自动删除它们。确认无其他任务使用后，
再单独执行受控的容器清理。

## 当前启动流程

```sh
cp .env.local.example .env.local
pnpm local:up
pnpm local:ps
pnpm dev
```

`.env.local.example` 中的 `DOCUMENT_FAKE_*` 配置必须保留。文档接口会通过进程内
确定性假对象传输和假扫描器工作；未明确启用假模式时，传输、扫描和下载均失败关闭。
真实 S3 接入前，不得把假配置当作生产凭据或部署配置。

## 历史执行记录（已停用）

## 目的与边界

本节原用于在开发机器上启动 Release 1 的本地依赖：PostgreSQL 17、
LocalStack S3/SQS 和 ClamAV。环境只允许确定性合成数据，不连接 Neon、
AWS、Vercel 或其他外部业务系统。

本地模式必须显式设置 `APP_RUNTIME_MODE=local-synthetic` 和
`AUTH_MODE=database-test`。`local-synthetic` 在这里表示本机回环依赖和纯合成数据，
不再表示角色选择登录。应用在
`NODE_ENV=production`、模式缺失或端点不是回环地址时拒绝加载本地配置。
生产 RDS 配置和现有 `/api/v1/health` 契约不受本手册影响。

本地与 Vercel test 复用 `database-test` 邮箱、密码 verifier 和 opaque database Session，
但数据库端点严格隔离：本地只能连接 PostgreSQL loopback 且 `ssl=false`；Vercel test
只能连接独立远端测试库且强制 TLS。生产继续只允许 Cognito。浏览器不能提交 role、
organization_id 或跳转地址，组织和角色由服务端在验证 credential 后推导。

## 运行资源

| 服务 | 本机端口 | 本地用途 |
|---|---:|---|
| PostgreSQL 17.10 | `127.0.0.1:5432` | 由与 Vercel test 相同的 one-role baseline 安装，保存合成业务数据 |
| LocalStack S3/SQS | `127.0.0.1:4566` | 模拟私有文档对象存储、扫描队列和死信队列 |
| ClamAV 1.4.5 | `127.0.0.1:3310` | 为后续扫描 Worker 提供 `clamd` 协议 |

Compose 首次创建以下本地资源：

- PostgreSQL 数据库 `tianxing` 和唯一 login/owner `tianxing_app`；
- PostgreSQL 镜像的 `postgres` 角色只在首次初始化时充当 bootstrap superuser，初始化完成后固定为 `NOLOGIN`，不能作为应用或日常 operator 账号；
- 启用版本控制的 S3 桶 `tianxing-local-documents`；
- SQS 队列 `tianxing-local-document-scan`，固定 `VisibilityTimeout=180` 秒；初始化脚本每次运行都会重新锁定该值；
- 死信队列 `tianxing-local-document-scan-dlq`，主队列在三次接收失败后转入；
- ClamAV 守护进程和病毒特征库。

主队列策略固定为恰好两条、且都只允许向该队列执行 `sqs:SendMessage`：一条允许来自上述
精确 S3 桶和 LocalStack 账号的对象事件；另一条只允许固定 `test` 凭据对应的 LocalStack
账号 root principal，由有界的文档协调 Worker 重发已绑定的合成对象事件。两条授权都不使用
wildcard principal、action、resource 或 condition。

这些名称、密码、策略和 `test` AWS 凭据只适用于回环网络上的 `local-synthetic` 环境，不能复制到
其他环境。尤其不得把 LocalStack root principal 授权复制到 `production-aws`；生产队列策略必须
按独立架构、安全和最小权限审查重新设计。

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

依赖就绪后，先安装当前 one-role baseline、写入 Release 1 合成 seed，并 provision 本地测试身份：

```sh
pnpm db:plan:local
pnpm db:baseline:local:dry-run
ONE_ROLE_BASELINE_APPLY_CONFIRM=tianxing-one-role-v1 pnpm db:baseline:local
pnpm db:seed:local-release1
read -r -s 'LOCAL_DATABASE_TEST_PASSWORD?Local database-test password: '
printf '\n'
printf '%s\n' "$LOCAL_DATABASE_TEST_PASSWORD" \
  | pnpm db:provision:local-identity --email=founder@env01.test.invalid
LOCAL_DATABASE_TEST_PASSWORD=''
unset LOCAL_DATABASE_TEST_PASSWORD
```

密码由操作员隐藏输入，只通过标准输入传入，不得写入 Git、环境模板或命令参数。
`founder@env01.test.invalid` 是本地与 Vercel test 共用的固定纯合成 founder 标识；两个环境
使用不同的数据库 URL 和密码。

数据库、seed 和身份准备完成后，使用两个独立终端分别启动 Next.js 和 DOC-02 文档扫描 Worker。
两个命令都会读取仓库根目录的 `.env.local`；其中环境模板固定了 Release 1 合成组织 UUID 和非用户
Worker 上下文 UUID，它们不是登录身份，也不能替代用户权限检查。

终端 A：

```sh
pnpm dev
```

终端 B：

```sh
pnpm worker:documents:local
```

Worker 输出 `document-worker-ready` 后才表示已取得本地队列并可以接收 DOC-02 扫描事件。

打开 `http://localhost:3000/login`，使用该邮箱和刚 provision 的本机密码登录。
本地身份、verifier 和会话保存在 PostgreSQL；
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

PostgreSQL 的 Compose 健康检查使用密码以 `tianxing_app` 建立真实 SQL 连接，并同时验证
唯一 login、精确角色属性、数据库 owner 和 `postgres NOLOGIN` bootstrap 合同；因此初始化 SQL
失败不会再被单纯的端口存活检查掩盖。应用 readiness 使用同一个 `tianxing_app` 连接执行身份和数据检查。LocalStack 的 Compose 健康检查要求桶、主队列
和死信队列都已存在。应用通过 LocalStack 健康 API 检查 S3/SQS 服务状态。
ClamAV 应用探测发送官方 `zPING\0` 命令并要求 `PONG`。

## 数据库迁移

启动 Compose 不会自动执行数据库 baseline。当前仓库已经生成独立的单角色 baseline；它不修改历史
`db/migrations`，也不会自动连接数据库：

```sh
pnpm db:baseline:plan
pnpm db:baseline:local:dry-run
ONE_ROLE_BASELINE_APPLY_CONFIRM=tianxing-one-role-v1 pnpm db:baseline:local
pnpm db:seed:local-release1
```

baseline runner 只接受被 Git 忽略的 `.env.migration.local`，并要求 URL、数据库和
`tianxing_app` 完全匹配；Next.js 只读取 `.env.local`，应用进程不持有 operator 文件。
历史 runner 使用过的 `tianxing_migration` 仅作为旧实机记录，不能作为新合同。

baseline `dry-run` 在单事务中执行当前 manifest 的全部生成文件并回滚；它不会留下历史
`migration.schema_migrations`，只在 apply 时写入独立的 `tianxing_baseline.installations` marker。
apply 使用 advisory lock、超时和单事务；已安装 marker 与 manifest 不匹配时会拒绝重复安装。
历史迁移一旦应用便不得修改，修复必须新增迁移或重新生成经过审查的 baseline。

旧本地数据库曾按历史 migration ledger 应用过结构；该状态不等于当前 one-role baseline
已安装。单角色 baseline 目标要求空的 public schema 和不存在的 baseline marker，必须在
明确批准后针对目标库重新验收。

`db:seed:local-release1` 直接运行与 Vercel test 相同的 Release 1 seed 定义；
`db:seed:local-identity` 仅作为兼容 alias 指向同一命令。seed 先验证 baseline marker、owner 属性和固定合成数据，
再在同一 `tianxing_app` 连接内写入，并显式设置 `app.organization_id`/`app.actor_user_id` 以适配 FORCE RLS。
seed 仍是独立操作，未因 baseline 代码生成而自动执行。

## 停止与重置

按以下顺序停止，避免停止依赖时仍有新的上传或正在处理的扫描：

1. 停止浏览器中的上传操作，并在 Next.js 终端按 `Ctrl-C`，阻止签发新的上传能力；
2. 在 Worker 终端按 `Ctrl-C`，等待当前一次处理结束并确认进程退出；
3. 最后停止 Compose 依赖。

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

2026-08-21 已通过 `pnpm test:database-test-login-dev-http` 在一次性 PostgreSQL 17.10 容器中完成本地等价验收：
真实执行当时的 one-role baseline 的 28 个 generated SQL、应用与 Vercel test 相同的 Release 1 seed 定义、
provision 合成 founder credential，并由隔离 Next Dev 通过真实 HTTP 入口验证登录、session、错误口令、
未知字段、跨租户拒绝、故障回滚和登出。测试使用随机 loopback 端口和 tmpfs，结束后删除容器与临时应用目录。

同日已在用户批准后重建持久化的 `tianxing-local` PostgreSQL 卷：新的合同型健康检查验证
`tianxing_app` 是唯一 login 和数据库 owner、角色属性均已降权，bootstrap `postgres` 保留
SUPERUSER 但固定为 `NOLOGIN`。随后 baseline plan、真实 dry-run clean、apply installed 和同源
Release 1 seed 均通过。founder 密码不属于版本化环境状态；每次重建数据卷后，操作员仍须按上方隐藏输入流程
重新 provision，并完成一次本地手工登录验收。其他领域 runtime 和 Worker 尚未接通，因此这不代表
Release 1 的全部业务 API 已端到端可用。
