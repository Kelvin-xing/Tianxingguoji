# ACCESS-TRIAL-01 实施记录

更新：2026-09-19。状态：`in_progress`，尚未满足合并条件。

## 授权和工作区

目标保持完整：按照试用计划完成开发、测试，合并 main 并推送远程。用户已授权提交、合并、推送；不包含生产部署、真实员工映射或共享数据库操作。客户测试环境按原计划 F 独立放行，不能以本地结果声称云环境已完成。

- 分支 `codex/access-trial`，工作区 `/Users/karo/.codex/worktrees/access-trial/Tianxingguoji`，起点 `52f46d5`。
- 原 `/Users/karo/Documents/Tianxingguoji` 的未提交业务改动完整保留，仅复制试用计划；最终集成时核对其变化，不覆盖或整树带入。
- 正式需求在 `/Users/karo/Documents/txgj-doc/business-requirements/` 追加 BR-015 及对应模块取代范围，基线 v54。该文档仓库另有学校需求修改，提交时只选本任务新增内容。其真实 Git diff 应再次检查。

## 已实现并验证的阶段

1. 四等级纯权限决策：两分类、L2 多分类、L3 必要任务上下文、完成只读、撤销/重派拒绝、文件扫描及明确动作、Founder-only 员工/安全管理、禁止导出。
2. 058/059 追加迁移：试用成员及案件分类；员工资料前置；版本和 Founder 保护；FORCE RLS；L1/L2/L3 作为真实角色；延迟一致性约束禁止新等级与历史角色混合提交。未修改历史迁移，未自动映射真实用户。迁移清单及生成基线现为 58 个源迁移/59 个生成文件。
3. 登录请求权限上下文：当前试用等级取代旧角色并集；无等级的孤立新角色、禁用或身份不匹配默认拒绝。身份 web 边界和文件 actor 附带新等级事实。旧 Founder 不自动升级，新 Founder 拥有完整业务入口能力。
4. 员工等级管理：Founder 明确启用自己的新等级，再逐个设置同事的等级和 L2 分类；真实事务内重查、幂等、审计/outbox、最后 Founder 保护。停用同时停用 membership；沿用既有不可直接重新启用的生命周期，不新增恢复账号方案。
5. 管理接口：`GET /api/v1/auth/users/trial-access`、`PATCH /api/v1/auth/users/[userId]/trial-access`；页面 `/admin/access/levels`。原身份管理页增加入口；保留旧账号兼容页面。原邀请流程仍需接新等级及分类，尚未完成。
6. 修复旧基线测试夹具与现行结构的不一致：联系人邮箱、关系枚举、删除限制、重复角色、主负责人关联、答案 revision 及选校就绪条件。没有放宽产品校验，也没有删去原拒绝路径。

## 有效验证证据

运行环境：Node 22，原工作区 node_modules 符号链接；一次性 PostgreSQL 17.10 Docker、Next Dev webpack、系统 Chrome headless；仅合成数据，无第二组织。

- `node --conditions=react-server --test tests/unit/access/*.test.ts tests/unit/identity/internal-email.test.ts tests/contract/auth-me-route.test.ts tests/architecture/module-boundaries.test.ts`：73/73 通过。日志 `/tmp/access-trial-regression.log`。
- `pnpm test:trial-access`（等价 `TIANXING_TRIAL_BROWSER=1 node --conditions=react-server --test tests/integration/one-role-baseline-postgresql.test.ts`）：2/2 通过，且明确输出 trial_member_commands 与 trial_member_browser 通过。日志 `/tmp/access-trial-browser-test.log`。
- PG17 覆盖空库 dry-run 回滚、独立连接核对、真实安装、seed、FORCE RLS、员工资料/分类/版本/角色一致性、拒绝普通员工初始化/升权、缺组织上下文空集、最后 Founder、删除/截断保护、幂等、旧权限上下文拒绝、审计写失败回滚、停用、并发降级。
- 浏览器使用真实内部邮箱密码登录；Founder 修改 L2 分类并刷新验证持久性；L1 直接 GET/PATCH 管理接口均 403；独立数据库连接验证拒绝后无变化；桌面及 390px 视口检查通过。截图 `/tmp/access-trial-founder-levels.png`、`/tmp/access-trial-founder-levels-mobile.png` 已目视检查。随后仅将卡片边框改为项目已有 CSS 变量，最终完整浏览器门禁时重拍。
- `next typegen` 提供本地 GIT_SHA/NEXT_DEPLOYMENT_ID 后，`tsc --noEmit --incremental false` 通过；聚焦 ESLint 通过（日志 `/tmp/access-trial-typecheck.log`、`/tmp/access-trial-lint.log`）。
- 以上仅证明权限内核和员工等级管理链路；**不证明案件/任务/文件新权限已可用**。

## 必须继续完成的全量目标

1. 业务接通：案件、Assessment、选校、结案、学生/家长、任务、文件、审计、学校/来源、邮件配置、邀请，全部采用新等级及实时资源范围。当前多处仍按 Founder/Advisor/Contractor 及旧主负责人判断，对新等级会拒绝或缺少应有能力，不能发布。
2. 业务资源 SQL/约束追加适配：案例创建主负责人仍引用旧角色事实；必须支持新等级身份，列表/搜索/详情不泄露未授权分类。写事务内重查，撤权后旧 Session 失权。保留审计/outbox、业务状态机、幂等和 RLS。
3. 邀请直接指定新等级/分类；不能让新试用 Founder 发出旧 Admin/Advisor 邀请后自动遗留额外权限。邮箱配置仅试用 Founder（旧 Admin 仅保留明确历史账号兼容）。
4. 五个合成演示身份、两分类案件、跨分类 L3 任务、未指派任务和文件动作关联；任务完成只读，拒绝/取消/撤销/重派收回访问；L3 不进入整案。
5. UI 完整联动：案件分类、指派/撤销、各等级工作台和 allowed_actions；员工邀请和原管理页整合，不能把当前兼容页面当最终体验。
6. 真实本地 HTTP/浏览器完整场景：Founder 设置、L1 审批、L2 分类工作、L3 任务/文件、撤权、异常/空状态/加载/移动端；安全审查及要求对应的回归检查。
7. 最终按原计划逐项审计，再合并 main、推送并核实远程 main SHA。仅本任务文件入库，不能带入原工作区无关修改。当前尚未合并或推送。
8. F 客户测试部署仍需独立环境与授权，不偷偷选择新云方案。

## 下一步入口

从 `modules/cases/application/workspace-service.ts` 和 `modules/cases/infrastructure/postgresql-workspace-repository.ts` 开始接案件列表/详情/创建及业务分类。`compatibilityRoleForRepository` 对新等级返回实际等级（l1/l2/l3），不伪装 Founder/Advisor；当前旧角色过滤必须逐项更新。新等级使用 `AccessContext.trialPrincipal`，数据库事务用 `loadTrialPrincipal(...,{lock:true})` 获取当前事实；不可回退旧权限并集。

受控员工管理服务已在 `modules/access/application/trial-member-management.ts` 和对应 PostgreSQL repository；真实测试 helpers 位于 `tests/integration/trial-*-assertions.ts`。浏览器 helper 暂由基线测试在 TIANXING_TRIAL_BROWSER=1 时调用。

## 案件读取阶段（2026-09-19，接续 bdccc4a）

- `PostgresqlCaseWorkspaceRepository.listCases/findCase` 在事务内重新读取并锁定当前试用身份及实际角色；在 SQL 层按明确分类筛选，未把全部案件读到应用后再过滤。Founder/L1 两分类，L2 当前分类，L3 拒绝；未知分类拒绝。旧账号仍按原 Founder/Primary Advisor 规则查询。
- `CaseWorkspaceService` 将读取时的仓储拒绝映射为稳定业务错误，供 API 返回拒绝而不是 500。测试覆盖缓存的 L2 请求上下文在撤分类/停用后的失权。
- 旧 workspace 的创建/选项方法暂时拒绝已启用试用等级的员工，防止尚未分类的老写入路径成为后门；正式 intake 路径仍需完整接通，不能把此次读取工作称为建案已完成。
- 新增 `tests/integration/trial-case-read-assertions.ts`：一次性 PG17、应用账号/RLS、真实仓储与服务，三组国际/本地/无分类案件；四等级、旧顾问、伪造旧等级、撤分类、停用均验证。夹具回滚，不修改持久化样例。
- 案件聚焦回归暴露并修正旧测试漂移：当前主负责人关联列与第 12 个 SQL 时间参数；来源类型改用既有合法 partner_referral；身份夹具提供实际角色/capabilities；HTTP 幂等收据比较改用已有脱敏断言。没有放宽生产权限或删除拒绝断言。
- 恢复案件详情页漏挂的既有推荐来源面板，能力控制仍由原组件/API 执行；仅静态/类型验证，本轮没有浏览器验证该面板。
- 真实基线：`node --conditions=react-server --test tests/integration/one-role-baseline-postgresql.test.ts`，2/2 通过并明确输出 `trial_case_reads:pass`；日志 `/tmp/access-trial-case-read.log`。
- 聚焦回归：`node --conditions=react-server --test tests/unit/cases/*.test.ts tests/unit/p2-be-03-crm-case-assessment.test.ts tests/contract/case-workspace-route.test.ts tests/architecture/module-boundaries.test.ts`，107/107 通过；日志 `/tmp/access-trial-case-regression.log`。
- 类型检查通过；聚焦 ESLint 的既有未使用 CaseWorkspaceStage 导入已清除，最终结果见 `/tmp/access-trial-case-typecheck.log`、`/tmp/access-trial-case-lint.log`。
- 不代表整案页面可供 L1/L2 使用：页面仍会读取旧 Assessment 服务；创建、Assessment、后续工作流、任务、文件、邀请及完整浏览器验收仍未接通。目标继续保持 in_progress，未合并/推送。

下一步实际入口：`modules/cases/application/intake-service.ts` / `domain/intake-contract.ts` / `infrastructure/postgresql-case-intake-repository.ts`，正式 POST 调用 intakeService，而不是 workspace 旧 createCase。当前 intake actor 固定 advisor，主负责人 owner port 在 `modules/access/infrastructure/postgresql-case-intake-owner.ts`。必须添加案件分类及 Founder/L1/L2 创建、分类内学生选项和实际等级负责人。036 中 `cases_validate_service_case_write`、`cases_advance_new_service_case`、`cases_apply_service_case_workflow_action` 以及039的 primary assignment role CHECK 仍按 advisor；新迁移从060追加，不能改已提交058/059。新类别不能从 Assessment/学生自动推断。正式需求 BR-015 已确认，无需再请求方案批准。
