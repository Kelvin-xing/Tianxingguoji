# LOCAL-01 Synthetic Foundation Implementation Record

| Control | Value |
|---|---|
| Date | 2026-08-17 |
| Status | `local_foundation_runtime_validated` |
| Scope | PostgreSQL 17、LocalStack S3/SQS、ClamAV 和本地依赖就绪检查 |
| Data | 仅合成环境；没有业务数据 |
| External action | 无 AWS、Vercel、Cloudflare、Neon 或部署操作；代码提交与推送按用户确认另行执行 |

## 结果

新增 `compose.local.yml`，以回环端口提供 PostgreSQL 17.10、LocalStack
4.14.0 和支持 Apple Silicon 的 ClamAV 1.4.5 Debian 13 slim 变体。本地配置由 `APP_RUNTIME_MODE=local-synthetic`
显式启用，并在生产 Node 环境、非回环端点或无效资源名称下 fail closed。
现有生产 RDS 校验未放宽。

LocalStack ready hook 幂等创建启用版本控制的文档桶、扫描队列和死信队列，并为
主队列设置三次失败的 redrive policy。PostgreSQL init hook 只创建迁移兼容所需的
`rds_iam` NOLOGIN 角色和无表权限的 `tianxing_health` 探测账号。ClamAV 通过
官方 TCP `zPING\0`/`PONG` 协议探测。

LocalStack 固定到统一镜像政策前的最后一个 Community 正式版 `4.14.0`，并且不启用
`PERSISTENCE=1`。2026.03.0 起的新镜像要求账号令牌，本地开发环境不应依赖个人凭据；
容器重建后由 ready hook 恢复空的 S3/SQS 资源，资源中只允许放置可重建的合成数据。
这个旧镜像仅限绑定回环地址的本地开发，不得用于生产或共享环境。PostgreSQL 仍通过
命名卷保留本地数据。

新增 `GET /api/v1/local/readiness`。它只在本地模式存在；全部依赖就绪时返回
版本化 200 响应，依赖不可用时返回安全的 503，其他模式返回 404。现有
`GET /api/v1/health` 保持原样，继续满足 staging health-only 契约。

实机启动还发现两组既有动态路由使用不同参数名。详情页已并入各自已有路由树：
`/cases/[caseId]` 与 `/students/[studentId]`。这只统一 Next.js 文件目录和参数名，
公开 URL 与页面业务逻辑不变。

## 安全边界

- 三个宿主机端口只绑定 `127.0.0.1`。
- 本地配置不读取生产 `DATABASE_URL`，只读取 `LOCAL_SYNTHETIC_*` 变量。
- 生产构建不能启用本地组合。
- readiness 只输出四个 allowlist 状态，不输出密码、URL、端点或原始异常。
- Compose 不挂载 Docker socket，不访问项目外业务数据。
- PostgreSQL 运行依赖 `pg@8.20.0` 已从开发依赖移入运行依赖。

## 已执行验证

以下检查在 2026-08-17 通过：

```text
12/12 local foundation tests passed
14/14 shared API envelope tests passed
11/11 architecture boundary tests passed
focused TypeScript check for changed runtime/route/API files passed
compose.local.yml structured YAML parse passed
git diff --check passed
PostgreSQL SELECT 1 passed with the health-only role
LocalStack S3 versioning and both SQS queues verified
ClamAV PING returned PONG
/api/v1/health returned HTTP 200
/api/v1/local/readiness returned HTTP 200 with all dependencies ready
home page returned HTTP 200
```

全仓 `tsc --noEmit` 仍失败于本次改动之外的既有 TypeScript 错误，包括 Case route、
Guardian route、AssessmentEditor 和多个历史测试契约。本次新增文件最初发现的类型错误
已经修复并由聚焦 TypeScript 命令验证。仓库约束禁止的 `pnpm lint` 和 `pnpm build`
没有运行。

## 剩余 Gate

容器运行时和依赖健康 Gate 已通过。空库迁移随后由
[`LOCAL-02_DATABASE_MIGRATION.md`](LOCAL-02_DATABASE_MIGRATION.md) 完成。尚未创建本地
应用账号、加载合成身份、接入各领域 PostgreSQL/S3/SQS runtime 或运行扫描 Worker。

确定性进程内合成身份随后由
[`LOCAL-03_IDENTITY_MODE.md`](LOCAL-03_IDENTITY_MODE.md) 完成；下一张票应把合成身份和
session 持久化到本地 PostgreSQL。操作步骤见
[`docs/runbooks/local-synthetic.md`](../runbooks/local-synthetic.md)。

镜像和协议选择依据为 [PostgreSQL 官方镜像](https://hub.docker.com/_/postgres)、
[LocalStack Docker 镜像](https://docs.localstack.cloud/aws/customization/other-installations/docker-images/)
、[统一镜像迁移说明](https://blog.localstack.cloud/localstack-single-image-next-steps/)
和 [init hook](https://docs.localstack.cloud/aws/customization/advanced/filesystem/) 文档，
以及 ClamAV 官方 [Docker](https://docs.clamav.net/manual/Installing/Docker.html) 和
[`clamd` 协议](https://docs.clamav.net/manual/Usage/ClamdProtocol.html) 文档；版本升级必须
重新执行本票验证。
