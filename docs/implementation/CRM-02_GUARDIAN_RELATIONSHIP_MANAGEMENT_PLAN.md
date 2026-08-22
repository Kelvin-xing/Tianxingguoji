# CRM-02 监护人关系维护纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_local_pending_git` |
| Architecture contract | `CRM-GUARDIAN-RELATIONSHIP-MANAGEMENT/v1` |
| Product sources | `DEC-005`, `DEC-042`, `DEC-045`, `P2-01`, `AC-02`, `AC-04` |
| Business owner | Project owner |
| Delivery owners | Frontend, Backend |
| Platform operations | Local infrastructure support only when separately requested |
| Acceptance boundary | `Local Dev: pass`; production build blocked by existing external font fetch; `Vercel Test: not_run (unverified)`; `AWS Production: not_run (unverified)` |
| Authorization | Local implementation and verification are complete; Git, shared database, and cloud operations remain separately gated |

## 1. 业务结果

Advisor 可以从 Student 详情进入监护人关系管理页，查看当前主要与次要监护人；可以由人工明确选择
一个组织内已存在的 Guardian，将其作为当前次要关系关联到 Student；也可以把一个已经关联的当前
次要 Guardian 原子地交接为新的主要联系人。刷新、退出并重新登录后，当前关系和历史仍由本地
PostgreSQL 权威保存。

该切片用于支持兄弟姐妹共享同一 Guardian，同时保证每名 active Student 始终恰好有一名当前主要
联系人。它不得依据姓名、Email 或电话自动建立关系、自动匹配身份或合并 Guardian。

## 2. 范围

包含：

- Student 详情显示当前 Guardian 关系与主要/次要状态；
- `/students/{studentId}/guardians` 提供关系管理页；
- 人工搜索并选择组织内现有 Guardian，建立次要关系；
- 从当前次要关系中选择 successor，原子交接主要联系人；
- current relationship 读取、attach、primary handoff 的 API v1 合同；
- PostgreSQL Repository、runtime composition、RLS、幂等、审计与 outbox；
- Local PostgreSQL 17 的真实 HTTP、浏览器、刷新和重登录持久化验收。

不包含：

- 创建新的 Guardian profile；CRM-01 继续拥有 Student + new Primary Guardian 建档；
- 自动匹配、自动关联、重复候选、合并或 merge undo；
- 编辑 Guardian 姓名、Email、电话或 Student profile；
- 移除最后一名主要联系人、无 successor 的解除关系、删除或 purge；
- 任意 relationship type、Primary Advisor/Case 关系、批量导入；
- Vercel/Neon 远程测试、AWS Production 或真实客户数据。

## 3. 页面流程

### 3.1 Student 详情

- `students.read` 继续控制 Student 与当前 Guardian 的只读显示。
- 当前主要 Guardian 首先显示，并有“主要联系人”状态；次要 Guardian 依稳定顺序显示。
- 只有具备 `students.guardians.manage` 的会话显示“管理监护人关系”入口。
- 页面不得把 Guardian UUID、record version 或 organization ID 作为要求用户理解的业务字段。

### 3.2 关系管理页

页面包含三个不嵌套的工作区域：

1. 当前关系：显示 Guardian 姓名、关系类型、legal/emergency/billing/notification 状态和主要/次要
   状态；技术版本只作为隐藏请求数据。
2. 关联已有 Guardian：Advisor 输入至少两个字符的姓名或联系线索，服务端返回最多 20 个同组织
   候选；结果只显示 `display_name` 与脱敏 `email_hint`/`phone_hint`。Advisor 必须人工选择一个结果，
   系统不得自动选中或推断为同一人。
3. 交接主要联系人：只能从当前有效次要关系中选择 successor。确认页面明确显示旧主要联系人和
   新主要联系人，并说明操作会保留历史、不会删除任何 Guardian。

搜索、空结果、加载、无权限、服务不可用、字段失败、版本冲突和成功状态必须分别呈现。键盘操作、
窄屏布局和错误后可恢复性属于验收范围；不得以 raw UUID 输入框作为正式业务流程。

## 4. 权限合同

- 新增 `students.guardians.manage` 到 `WorkspaceCapability`。
- 依据既有 `P2-01` Advisor-only 决策，只有 `advisor` 拥有该 capability；`founder`、`admin`、
  `data_reviewer` 与 `contractor` 均不拥有。
- 由于当前 `founder` 直接引用全部 `WORKSPACE_CAPABILITIES`，实现时必须把 Founder 矩阵改为显式
  allowlist，不能因新增 capability 意外授权 Founder。
- Founder、Admin 与 Advisor 仍可按 `students.read` 查看 Student 当前关系；只有 Advisor 可以搜索
  attach candidate、建立次要关系或执行 primary handoff。
- 前端按 capability 控制入口与命令控件；所有 search/attach/handoff API 在服务端再次调用同一授权
  策略。绕过 UI 的 Founder/Admin 直接请求必须返回 `403 FORBIDDEN` 且零写入。
- 未知 role/capability、策略缺失或 policy version 不可用时 fail closed，不回退到硬编码 UI role。

该 Advisor-only 矩阵已经由项目负责人确认并冻结。实现不得把新增 capability 隐式授予 Founder 或
Admin。

## 5. 表单与词汇合同

建立次要关系：

- `guardian_id` 来自服务端搜索结果中的 opaque ID，不能自由输入；
- `relationship_type` 只允许 `father`、`mother`、`other_guardian`；
- `is_legal_guardian` 为显式复选框，默认 `true`；
- `is_emergency_contact`、`is_billing_contact`、`notification_consent` 为显式复选框，默认 `false`；
- `is_primary_contact` 不接受客户端输入，服务端在 attach 命令中固定为 `false`。

主要联系人交接：

- `successor_guardian_id` 必须来自该 Student 当前有效的次要关系；
- `expected_primary_record_version` 由当前关系 DTO 提供，客户端不得让用户手填；
- `reason` 不接受自由文本，本切片由服务端固定为 `guardian.primary.handoff`，避免 PII 进入历史、
  审计或日志；
- successor 的 relationship type 与 legal/emergency/billing/notification 状态从被关闭的当前次要关系
  继承，客户端不能在 handoff 请求中同时修改。

## 6. API 合同

所有接口使用现有 API v1 envelope、`Cache-Control: no-store` 与服务端 session actor；浏览器不得提交
organization ID、actor ID、role、policy version 或数据库 owner。

权限分界固定为：current relationship GET 使用 `students.read`；search、attach 与 handoff 使用
`students.guardians.manage`。每个 Route 必须独立实施服务端授权，不能依赖此前页面或 GET 已通过。

### 6.1 读取当前关系

`GET /api/v1/students/{studentId}/guardians`

成功 `200`，精确返回：

```json
{
  "student": { "id": "opaque", "display_name": "Synthetic Student" },
  "relationships": [
    {
      "relationship_id": "opaque",
      "guardian": {
        "id": "opaque",
        "display_name": "Synthetic Guardian",
        "email_hint": "g***@example.invalid",
        "phone_hint": null
      },
      "relationship_type": "father",
      "is_legal_guardian": true,
      "is_primary_contact": true,
      "is_emergency_contact": false,
      "is_billing_contact": false,
      "notification_consent": false,
      "starts_at": "ISO-8601 UTC",
      "record_version": 1
    }
  ]
}
```

只返回 current relationship；关闭历史由数据库和 audit 保留，本切片不向页面暴露历史详情。

### 6.2 搜索可关联 Guardian

`POST /api/v1/students/{studentId}/guardians/search`

使用 POST 是为了避免姓名、Email 或电话进入 URL/query/access log；该接口是只读查询，不要求
`Idempotency-Key`。请求仅为 `{ "query": "..." }`，规范化后长度 2-100。成功 `200` 返回最多
20 个 `{ id, display_name, email_hint, phone_hint }`，排除已与该 Student 存在 current relationship
的 Guardian。不得返回完整 Email、完整电话、其他 Student、相似度、match score 或自动合并提示。

### 6.3 建立当前次要关系

`POST /api/v1/students/{studentId}/guardians`

要求 `Idempotency-Key`，请求精确为：

```json
{
  "guardian_id": "opaque",
  "relationship_type": "father",
  "is_legal_guardian": true,
  "is_emergency_contact": false,
  "is_billing_contact": false,
  "notification_consent": false
}
```

成功 `201`，`data` 精确为：

```json
{
  "relationship": {
    "relationship_id": "opaque",
    "guardian_id": "opaque",
    "relationship_type": "father",
    "is_legal_guardian": true,
    "is_primary_contact": false,
    "is_emergency_contact": false,
    "is_billing_contact": false,
    "notification_consent": false,
    "starts_at": "ISO-8601 UTC",
    "record_version": 1
  }
}
```

exact replay 返回首次相同结果且不新增记录。

### 6.4 交接主要联系人

`POST /api/v1/students/{studentId}/guardians/primary-handoffs`

要求 `Idempotency-Key`，请求精确为：

```json
{
  "successor_guardian_id": "opaque",
  "expected_primary_record_version": 1
}
```

成功 `200`，`data` 精确为：

```json
{
  "relationship": {
    "relationship_id": "opaque",
    "guardian_id": "opaque",
    "relationship_type": "father",
    "is_legal_guardian": true,
    "is_primary_contact": true,
    "is_emergency_contact": false,
    "is_billing_contact": false,
    "notification_consent": false,
    "starts_at": "ISO-8601 UTC",
    "record_version": 2
  },
  "closed_relationship_ids": {
    "previous_primary": "opaque",
    "successor_secondary": "opaque"
  }
}
```

不返回已关闭关系的联系人资料。

统一错误映射：未登录 `401 UNAUTHENTICATED`；无 capability `403 FORBIDDEN`；不存在或跨租户资源
`404 NOT_FOUND`；stale version、current-pair、primary 或幂等冲突 `409`；字段失败 `422`；运行时
不可用 `503 SERVICE_UNAVAILABLE`。错误不得回显 query、姓名、Email、电话、完整请求、SQL 或 raw
exception。

## 7. 幂等与并发合同

- attach 与 handoff 各自使用独立 operation 名称和 `Idempotency-Key` namespace。
- 同一次确认及其超时/网络重试复用同一 key；选择 Guardian、flags、relationship type 或 successor
  改变后生成新 key。
- same key + same canonical payload 返回首次结果；same key + different payload 返回 `409` 且零副作用。
- handoff 必须比较 `expected_primary_record_version`；两个并发交接只能一个成功，失败者得到
  `409 STALE_VERSION`，不得静默覆盖。
- key 不进入 URL、浏览器存储、应用日志或错误报告；PII 表单草稿也不得持久化到浏览器存储。

## 8. PostgreSQL 事务合同

当前表、partial unique indexes、relationship immutability trigger 与 deferred primary-contact constraint
已经存在。本切片预计不修改 schema；如果真实 PostgreSQL 测试发现缺口，Backend 必须停止并提出
新的追加 migration，不得修改历史 migration 或 one-role generated baseline。

### 8.1 Attach transaction

一个 tenant-scoped transaction 必须：

1. 设置 transaction-local `app.organization_id` 与 `app.actor_user_id`；
2. claim attach idempotency receipt；
3. 锁定并重读 active Student 与 active Guardian，验证同组织与 Advisor capability；
4. 验证 current pair 不存在，并强制 `is_primary_contact=false`；
5. insert current secondary relationship；
6. append PII-free audit/outbox；
7. complete idempotency receipt；
8. COMMIT。

### 8.2 Primary handoff transaction

一个 tenant-scoped transaction 必须：

1. claim handoff idempotency receipt；
2. 按稳定顺序锁定 Student、current primary 与 successor current secondary；
3. 重验 Advisor capability、active/tenant 状态和 expected primary record version；
4. 关闭旧 primary 与 successor secondary 两条 current history；
5. 复制 successor 关系属性并 insert 新 current primary；
6. append 一条 handoff audit/outbox，并完成 receipt；
7. 在 deferred constraint 验证恰好一个 current primary 后 COMMIT。

任一步失败全部 ROLLBACK。不得出现无 primary、双 primary、关闭一半、无 audit/outbox、悬空 receipt
或跨租户可见。失败注入仅存在于本地 PostgreSQL 自动化测试，不增加可部署的测试 route/header/env。

## 9. 隐私与日志

- 搜索词、完整姓名、Email、电话、请求体和搜索结果不得写入 URL、audit、outbox 或日志。
- audit/outbox 只允许 organization、actor、Student/Guardian/relationship opaque ID、operation、status、
  record version、request ID 和固定 reason code。
- 日志只允许 route、safe error code、status、duration、request ID 和聚合计数。
- 错误响应与测试证据不得输出 Cookie、session、connection string、PostgreSQL message/detail/query/where、
  stack、raw row 或 PII。

## 10. 角色交接

### Backend

拥有 capability、command/DTO、Guardian search/read service、PostgreSQL Repository、runtime、Route、
transaction、idempotency、audit/outbox 与本地真实 PostgreSQL/HTTP tests。不得修改 UI 规避合同，
不得连接 Neon/Vercel/AWS。

### Frontend

拥有 Student 详情入口、关系管理页、候选搜索/选择、attach/handoff 表单、语义状态、可访问性、响应式
布局、浏览器 adapter 与 Local Dev browser tests。不得要求用户输入 raw UUID，不得发明字段/角色，
不得增加 mock 或直接数据库访问。

### Platform Operations

本票据没有常规执行 Gate。只有本地 Docker/PostgreSQL 基础设施不可用，或用户另行批准明确环境动作
时才介入；不执行 Vercel/Neon E2E、远程数据库聚合、redeploy 或云端日志检查。

## 11. Local Dev 测试门槛

Backend：

- focused unit/contract/typecheck/targeted lint；
- disposable PostgreSQL 17 + 当前 one-role baseline + Release1 synthetic seed + `tianxing_app` +
  RLS/FORCE RLS；
- 真实 Next Dev HTTP 验证 current list、人工 search、共享 Guardian 跨 sibling attach、exact replay、
  changed-payload conflict、current-pair conflict、原子 primary handoff、history preserved、stale concurrency、
  forced failure rollback、跨租户不可见；
- Advisor allow；Founder/Admin/Data Reviewer/Contractor 的 direct search/attach/handoff 为 `403` 且所有
  relationship/idempotency/audit/outbox 计数不变；
- 错误与日志 PII match count 为 0。

Frontend：

- focused typecheck、targeted lint、unit/architecture tests；
- 使用同一 disposable PostgreSQL 17 环境的真实 Local Dev browser gate；
- Advisor 查看入口、搜索候选、明确选择、attach 次要关系、刷新与重登录持久化、交接确认、handoff、
  旧主要历史不丢失且页面只显示新主要；
- same unchanged retry key、changed form/new key、重复点击保护和 stale error 可恢复；
- Founder/Admin 只读可见但管理入口隐藏，直接 API 为 `403`；
- desktop/mobile 无 overflow、遮挡或 clipped controls；browser page error、PII/secret log match 均为 0。

完整通过后的报告必须写：`Local Dev: pass`、`Vercel Test: not_run (unverified)`、
`AWS Production: not_run (unverified)`。任何单元或 mock 测试不能代替真实 HTTP/浏览器与 PostgreSQL。

## 12. 停止、回退与完成标准

- capability matrix、relationship vocabulary、API exact DTO 或产品决策冲突时停止，由架构师裁决。
- 任何部分写入、双 primary、无 primary、历史丢失、跨租户、PII 泄漏或重复副作用禁止交付。
- attach/handoff 成功后不允许 DELETE/SQL cleanup；业务修正只能追加新的 relationship revision。
- 若需要 schema 变更，返回 Backend 追加 migration 和完整本地重验，不得修改已应用 migration。
- 本合同已获用户确认，架构师可拆分 Frontend/Backend 实施票据；本次授权包含产品代码、自动化测试
  代码和 disposable Local Dev PostgreSQL/Next Dev/浏览器验收，不等于 Git、共享数据库或云端授权。
- 完成要求：Backend real PostgreSQL/HTTP、Frontend real Local Dev browser、shared-diff review、focused
  static gates 和 production build 均有实际证据，随后再独立请求 commit/push/PR/merge 批准。

## 13. 已冻结决策

1. `students.guardians.manage` 严格保持 Advisor-only；Founder 与 Admin 只读但不能管理。
2. 候选 Guardian 采用“人工搜索 + 脱敏 Email/电话提示 + 明确选择”，不做自动匹配。
3. attach 允许 Advisor 显式设置 emergency、billing 与 notification consent，默认均为 `false`。

Frontend 与 Backend 可在各自所有权边界内开始 Local Dev 实施。Platform operations 没有常规执行
Gate，除非本地基础设施出现归属明确的阻塞或项目负责人另行批准环境动作。

## 14. Local Dev 验收结果

2026-08-22 架构收口结论：`Local Dev: pass`；`Vercel Test: not_run (unverified)`；
`AWS Production: not_run (unverified)`。本结论只覆盖当前代码树，不授权 Git 或云端操作。

Backend 实际证据：

- Node 22 typecheck、targeted ESLint、architecture 15/15、focused unit/contract 11/11 与 ENV-01A
  74/74 通过；
- `test:crm-02-dev-http` 在 disposable PostgreSQL 17.10、当前 28-file one-role baseline、Release1
  synthetic seed、FORCE RLS 与真实 Next Dev HTTP 下 1/1 通过；
- current list、search、attach、exact replay、changed-payload conflict、stale version、forced rollback、
  cross-tenant isolation、四类 forbidden role、audit/outbox 与 PII-safe error 合同均通过；
- 两个不同 successor 使用相同 expected version 的真实并发 handoff 仅一个 `200`，另一个为
  `409 STALE_VERSION`；最终恰好一个 current primary，失败者无 receipt/audit/outbox 副作用，历史保留；
- 未修改 migration、migration manifest 或 one-role generated baseline。

Frontend 实际证据：

- Node 22 typecheck、targeted ESLint、CRM focused 21/21、architecture 15/15 与 `git diff --check`
  通过；
- `test:crm-02-dev-browser` 在同等 disposable PostgreSQL 17 / baseline / seed、隔离 Next Dev、
  playwright-core 1.55.0 与 system Chrome 下 1/1 通过，最终 `stage=complete`；
- Advisor 搜索、键盘明确选择、attach、权威刷新、刷新/重登录持久化、stale recovery、handoff、
  同请求重试复用 key、表单变化换 key 与双击单请求通过；
- Founder/Admin 只读、管理入口隐藏、direct search/attach/handoff forbidden 通过；desktop/mobile
  无 overflow、越界、重叠或裁切，browser page error 与敏感日志匹配均为 0。

架构 shared-diff 复核确认 Frontend decoder/request 与 Backend DTO/error exact match；权限只依赖
capability；未知合同 fail closed；幂等键不进入 URL 或浏览器持久存储；没有发现跨租户、部分事务、
双 primary、PII/secret 回显或 migration 漂移。

Production build 使用固定本地 review identity 实际执行，配置检查通过并进入 Next optimized build，
但现有 `app/layout.tsx` 的 `next/font/google` 无法从 Google Fonts 下载 Geist。沙箱外重跑仍为同一
外部资源错误，应用源码编译未完成；该阻塞不归因于 CRM-02，但 production build 必须记为
`blocked_external_font_fetch`，不能声明通过。

已知非阻塞技术债：Release1 seed 中两条历史 Guardian relationship 仍使用旧 `parent` 词汇；CRM-02
真实浏览器场景使用新建且符合冻结三值词汇的 `father` 关系，没有为旧数据做隐式映射。该兼容债务
不在本切片范围内，后续应通过独立数据治理票据处理。

下一 Gate 仅为用户明确批准后的 Git 暂存、提交、推送和 PR；批准前不得执行这些操作。
