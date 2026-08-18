# P2-13 统一权限策略实现计划

| Control | Value |
| --- | --- |
| Ticket | `P2-13` One versioned permission policy drives server capability checks, page guards and navigation |
| Status | `slice_a_implemented_local_pending_user_acceptance` |
| Decision | `DEC-069` |
| Data | 仅本地确定性合成身份和组织 |
| External state | 不操作云资源、生产配置、部署或真实数据 |

## 目标

把当前分散的角色数组、workspace capability 矩阵、页面登录检查和静态菜单收口到 Access module。
完成后，页面、Route Handler 和 Service 使用相同 capability ID；Cases、Tasks、Documents 等 owning
repository 继续在事务内执行资源级授权，客户端 capability snapshot 不成为安全真相。

## 范围

### 后端

1. 在 `modules/access/domain` 冻结 role、capability、authorization request/decision 和稳定 denial code。
2. 增加 immutable `access_policy_sets` 与 `access_role_capability_rules`，由追加 migration 建立与当前
   `ROLE_CAPABILITIES` 等价的 bootstrap policy。
3. 在 `modules/access/application` 提供 workspace evaluator；PostgreSQL repository 同时重查 organization、
   membership、RoleBinding 和 active policy version。
4. `/api/v1/auth/me` 返回 `capabilities` 与 `policy_version`；迁移 Route Handler 和 Service 中的直接角色数组。
5. activation/rollback 采用新 policy version，不修改已批准内容；同一事务写 AuditEvent 和 Outbox。

### 前端

1. 建立唯一 navigation registry，每项声明 `requiredCapability`，Sidebar 使用 `/api/v1/auth/me` 结果过滤。
2. 为 workspace、administration 和 contractor route group 增加 server-side page guard；`AppFrame` 只保留
   session UX，不承担授权。
3. `/admin/access` 先实现只读 policy version、角色能力矩阵和当前角色绑定状态，不实现自由编辑器。
4. denied、loading、empty、session expired 和 mobile navigation 状态必须完整，不能用隐藏按钮替代服务端拒绝。

## 不变量

- 角色和 capability 词汇仍由代码契约控制；未知词汇、缺少 active policy 或未列出的关系均 deny。
- Founder 必须保留 `access.manage`；bootstrap policy 的五角色行为不得发生隐式变化。
- 一般 workspace capability 不能替代 case/task/document 的 organization、assignment、scope 和 expiry 检查。
- 已认证但缺 capability 返回 `403`；资源隐藏继续使用 `404`，不得产生 ID oracle。
- 浏览器、cookie、JWT claim、菜单、projection 或 cache 都不是业务授权真相。
- migration 只追加；approved/active policy 不可原地修改或删除。

## 开发拆分

| Slice | 后端交付 | 前端交付 | Gate |
| --- | --- | --- | --- |
| A Contract | capability registry、decision/error contract、当前矩阵 fixture | navigation registry contract 和 decoder fixture | 架构/契约测试；行为零变化 |
| B Persistence | migration、bootstrap policy、repository、activation invariants | 无写入 UI | 空库重放、RLS/权限、hash/audit/rollback 测试 |
| C Integration | `/auth/me`、capability guard、首批 API/Service 迁移 | Sidebar、server page guard、denied states | 五角色直接 URL + API 负向矩阵 |
| D Completion | 清除目标范围内直接角色数组、read model | `/admin/access` 只读视图、桌面/390px/键盘验证 | TypeScript、聚焦测试、浏览器证据、人工验收 |

前后端允许在 Slice A 的契约冻结后并行。前端不得自行发明 capability、角色映射或授权 fallback；后端
不得通过页面隐藏证明授权完成。每个 Slice 单独审查，不把 B-D 合并成一个不可回滚提交。

## Slice A 本地实现记录

2026-08-18 完成 Slice A contract，但尚未接入运行时消费者：

- Access domain 冻结五个 `OrganizationRole`、九个 `WorkspaceCapability`、当前 bootstrap 矩阵、
  runtime validators、deny-by-default decision contract 和 deterministic manifest。
- `workspaceCapabilitiesForRole` 保持兼容；当前 `/api/v1/auth/me` 行为没有变化。
- Access client contract 只读取 `/api/v1/auth/me`，严格验证 identity、role、opaque
  `policy_version` 和已登记且不重复的 capability；不按 role 推导权限。
- navigation registry 只登记九个 capability-backed 入口，不包含 role、Platform、Portal、Contractor
  detail、Future placeholder 或已不存在的 `/admin/knowledge`。
- `/admin/knowledge` 后续从 Sidebar 可点击入口移除，不新增 capability；`/platform/billing` 继续由
  Platform 独立权限合同负责。
- 当前不启用 Next.js 实验性的 `forbidden()`/`authInterrupts`；Slice C 的 page guard 必须在读取
  受保护数据前执行，并保证 denied 状态零受保护数据输出。

架构师独立运行：

```text
Node 22 TypeScript                         0 errors
Access backend contract tests             4 passed
Access client/navigation contract tests   8 passed
Module boundary tests                    15 passed
Total                                    27 passed, 0 failed
git diff --check                          passed
```

尚未执行 migration、seed、数据库、dev server、浏览器、lint、build 或完整测试。当前
`/api/v1/auth/me` 尚未返回 `policy_version`，因此新 client 尚未接入 Sidebar/AppFrame；必须先在
Slice C 由服务端提供该字段，再迁移消费者。Slice B 的 policy tables、hash、activation、audit 和
rollback 仍未开始。

## 验收

1. 当前 Founder/Admin/Advisor/Data Reviewer/Contractor 的 workspace 能力与 bootstrap 前完全一致。
2. 每个 navigation item、受保护页面和目标 API 都声明并测试同一个 capability。
3. inactive membership/RoleBinding、无 active policy、未知 capability、policy hash 不符和资源越权全部 fail closed。
4. policy activation、rollback 和高风险 denial 有 PII-safe audit；重放不产生重复副作用。
5. 全项目目标范围不再出现新的 `requireRole([...])`、`actor.role ===` 或平行菜单角色表。

## 本票明确不做

- 不增加第六个角色，不改变既有角色语义。
- 不实现任意在线权限编辑器、bulk grant、support super-admin 或 subscription enforcement。
- 不把资源级授权搬进通用 RBAC 表。
- 不运行生产 migration，不部署，不接触真实账号或数据。
