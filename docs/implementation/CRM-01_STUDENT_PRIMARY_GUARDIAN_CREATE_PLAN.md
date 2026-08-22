# CRM-01 学生与主要监护人基础建档纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_local_vercel_unverified` |
| Architecture contract | `CRM-STUDENT-GUARDIAN-CREATE/v1` |
| Business owner | Project owner |
| Delivery owners | Frontend, Backend, Platform operations |
| Architect role | Freeze contracts, sequence handoffs, review evidence |
| External state | No database write, deployment, secret change, commit, push, or PR is authorized by this document |

## 1. 业务结果

顾问在一次保存操作中创建一名 Student、一个新的 Primary Guardian，以及二者之间当前有效的主要联系人关系。成功后，学生列表和详情页读取 PostgreSQL 权威数据；刷新、退出并重新登录后数据仍然存在。

本票据是纵向切片：页面、API、服务端授权、同一数据库事务、持久化读取和环境验收必须作为一条完整链路交付，不能以 Mock、内存数据或多个非原子的写接口替代。

## 2. 范围

包含：

- `/students` 增加“新增学生”入口；
- `/students/new` 提供学生与主要监护人单页表单；
- `POST /api/v1/students` 创建完整聚合；
- `GET /api/v1/students` 与 `GET /api/v1/students/{studentId}` 显示持久化结果；
- Local Dev 完成 Advisor 登录、创建、查询和重登录验收；Vercel Test 按用户于
  2026-08-22 接受的 local-only 验收政策保持 `not_run (unverified)`。

不包含删除或 purge、重复资料合并、批量导入、监护人自动匹配、Primary handoff、其他 CRM 功能、AWS 部署或真实客户数据。

## 3. 冻结的表单合同

Student：

- `display_name` 必填；
- `date_of_birth`、`contact_email`、`contact_phone` 可选；
- 客户端不能提交 ID、organization、status、record version 或 actor。

Primary Guardian：

- `display_name` 必填；
- `email` 和 `phone` 至少填写一个；
- `relationship_type` 只允许 `father`、`mother`、`other_guardian`；
- 前端使用固定选项，不提供任意文本；API 和领域层使用同一白名单再次验证；
- `is_legal_guardian` 是显式复选框，默认 `true`；
- `is_primary_contact` 固定 `true`；emergency、billing 与 notification consent 在本切片固定 `false`。

每次命令都创建新的 Guardian。姓名、生日、Email 和电话都不是身份键，不进行自动匹配或合并。

## 4. 权限合同

- 将 `students.create` 加入 `WorkspaceCapability`。
- Founder 和 Advisor 拥有；Admin、Data Reviewer 与 Contractor 不拥有。
- 前端根据已认证会话返回的 capabilities 控制入口可见性。
- `POST /api/v1/students` 在服务端再次调用授权策略；绕过 UI 的直接请求仍必须得到 `403`。
- 业务角色不会创建新的 PostgreSQL 登录角色；Local 与 Vercel 继续使用各自数据库中的 `tianxing_app`。

## 5. API 合同

`POST /api/v1/students` 使用现有 API v1 envelope，要求 JSON body 与 `Idempotency-Key` header。organization ID、actor user ID 和 actor role 只从服务端会话取得。

请求形状：

```json
{
  "student": {
    "display_name": "Synthetic Student",
    "date_of_birth": "2013-06-18",
    "contact_email": null,
    "contact_phone": null
  },
  "primary_guardian": {
    "display_name": "Synthetic Guardian",
    "email": "guardian@example.invalid",
    "phone": null,
    "relationship_type": "father",
    "is_legal_guardian": true
  }
}
```

成功返回 `201`，响应包含 Student、Guardian 和 relationship 的 opaque IDs 及详情页需要的安全显示字段。错误映射固定为：未登录 `401`、无 capability `403`、幂等冲突 `409`、字段失败 `422`、运行时不可用 `503`。响应不得包含 SQL 错误或原始异常。

## 6. 幂等合同

- 页面第一次保存时生成一个键；同一次保存的超时、断网、`503` 和用户重试复用该键。
- 表单任意业务字段改变后，下一次提交生成新键。
- 相同 organization、actor、operation、key 和相同规范化请求哈希返回首次创建的相同结果，不产生第二次副作用。
- 相同 key 对应不同请求哈希返回 `409`。
- 成功或用户明确放弃本次建档后，前端清除当前键。
- 不把 key 放入 URL；不把包含 PII 的表单草稿写入 localStorage、sessionStorage、日志或错误报告。

## 7. 数据库事务

当前 `crm_students`、`crm_guardians`、`crm_student_guardian_relationships` 和延迟到 COMMIT 检查的唯一 Primary 约束已经存在。本切片预计不增加表或修改历史 migration。

一个 tenant-scoped transaction 必须依次完成：

1. claim `shared_idempotency_records`；
2. insert active Student；
3. insert active Guardian；
4. insert current primary relationship；
5. append redacted audit event and outbox message；
6. complete idempotency receipt；
7. COMMIT。

任一步失败必须 ROLLBACK，不能留下 Student、Guardian、relationship、audit、outbox 或未完成 receipt。数据库事务开始后必须设置 transaction-local `app.organization_id` 与 `app.actor_user_id`，并由 RLS/FORCE RLS 继续实施租户隔离。

`relationship_type` 的三值词汇先由前端、API 和领域层冻结；本票据不收紧当前数据库自由文本约束。若将来要求数据库枚举，必须另开追加 migration 并迁移旧合成值。

## 8. 隐私与可观察性

审计/outbox 只允许资源 ID、request ID、event type、effect type、status 和 record version 等技术字段。禁止记录姓名、Email、电话或完整请求体。

应用日志只允许 request ID、operation、outcome、安全错误码和 duration。错误响应不得回显字段值、请求体、Cookie、Session、连接信息、PostgreSQL message/detail/query/where 或 stack。

## 9. 角色交接

### Backend

拥有 `modules/access`、`modules/crm`、`app/api/v1/students` 的服务端改动和对应 tests。实现 capability、command service、PostgreSQL repository、runtime composition、transaction、idempotency、audit/outbox 与 API error mapping。不得修改页面规避 API，不得连接 Neon/Vercel。

### Frontend

拥有 `/students` 入口、`/students/new`、表单组件、浏览器 API adapter、loading/error/denied/submitting/success 状态及 UI/browser tests。必须使用冻结 API，不得直接访问数据库、添加 Mock fallback 或自行扩大字段/权限。

### Platform Operations

只在本地基础设施不可用或用户另行批准环境操作时负责环境准备、凭证和脱敏运维证据。
不得修改应用或 migration 源码。根据 2026-08-22 local-only 验收政策，CRM-01 不再要求
Vercel/Neon 业务 E2E、远程数据库聚合或运行日志验收。

## 10. 本地测试门槛

Backend 必须在 PostgreSQL 17、当前 one-role baseline、`tianxing_app`、RLS/FORCE RLS 下验证：成功事务、exact replay、changed-payload conflict、鉴权、输入校验、跨租户拒绝，以及中途失败后所有计数不变。

失败注入只能存在于本地 PostgreSQL 自动化测试，不允许通过 route、header、query、cookie、runtime environment 或 Vercel 配置触发，不得增加可部署的 debug/test endpoint。

Frontend 必须验证 capability 入口、固定 relationship 选项、至少一种 Guardian 联系方式、重复点击保护、相同 payload 重试复用 key、修改后更换 key、错误状态、成功跳转、键盘操作和移动 viewport。

完整本地 Dev 验收必须通过真实浏览器或 HTTP 入口，使用本地 Advisor 会话和本地 PostgreSQL，完成创建、列表、详情、刷新、退出及重登录。单元测试、Mock client、typecheck 或 build 不能替代该检查。

本地 Dev 未通过前，前端和后端不得申请 commit、push、PR 或 merge；本地通过也不得描述为
Vercel、Neon 或 AWS 通过。

## 11. Vercel Test 状态与已接受风险

CRM-01 不执行 Vercel Test 远程业务验收，状态固定为 `not_run (unverified)`。不得为了补齐本票据
而从本机连接 Neon、执行 Console 聚合 SQL、重跑 seed/provision、redeploy 或检查包含业务数据的
运行日志。

用户明确接受以下剩余风险：Vercel 环境变量或 Current alias 漂移、TLS/网络连通、serverless runtime
差异，以及 Neon 托管 PostgreSQL 与本地 PostgreSQL 17 的运行差异。Local Dev 的 schema、角色、
RLS 与业务合同对齐不能替代这些云端证据。

此前只读确认的 exact main SHA、Production-only 变量、Neon integration unlinked 与 Standard
Protection 只保留为当时的运维观察，不构成 CRM-01 业务 E2E 通过。

## 12. 停止与回退

- API/页面字段、capability matrix 或 relationship vocabulary 漂移时停止并回到架构裁决。
- 本地事务出现部分写入、跨租户可见、PII 日志或幂等重复时禁止提交。
- 未获新的用户明确决定，不恢复 Vercel/Neon 远程测试或把历史云端观察升级为验收证据。
- 任何 schema 缺口必须由 Backend 提交追加 migration，并重新从 Local PostgreSQL 开始完整 promotion 顺序。

## 13. 完成标准

Backend PostgreSQL 17/HTTP、Frontend 真实 Local Dev browser、架构兼容性审核、production build、
GitGuardian/Vercel PR checks 与 PR #21 squash merge 均有实际通过证据；合并后的 main SHA 为
`f141d819dd27da38d48829b4dfc16003889b5db9`。CRM-01 因此按当前政策完成为
`accepted_local_vercel_unverified`。

该状态的精确含义是 `Local Dev accepted`；Vercel Test 与 AWS Production 均未验收。任何未运行的
环境保持 `not_run (unverified)`，不能推定通过。
