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

## 案件分类与建案链路（2026-09-19，接续 105f788）

本节为最新状态，取代上一节的“下一步实际入口”；总体仍为 in_progress。

- 追加060迁移，未修改历史迁移。案件/主负责人关系接受实际 Founder/L1/L2 角色，仍保留旧 Advisor；新数据库函数 `cases_trial_member_can_manage` 区分未启用试用等级（NULL）与明确无权（false），锁定当前等级/分类/角色事实。试用成员创建必须提供授权分类，试用负责人也须具备对应分类；案件分类作为身份事实不被普通 UPDATE 改写。建案推进、暂停/恢复的 SQL 命令接入当前范围，保留业务状态、版本和事实记录校验。
- 正式 intake service、repository、Access/CRM owner ports、POST 和选项 GET 接通 business_category。旧 Advisor API 可继续省略分类；试用账号不可省略或猜测分类。新负责人记录实际等级，不伪装 advisor；幂等哈希包含明确分类，重放前再次查询当前权限。
- L2 建案选项及事务锁定只允许已关联授权分类的学生/来源；负责人选项按所选分类筛选，直接提交越权负责人也拒绝。此阶段**没有**自行给未关联任何分类的学生开放 L2 可见性；L2 新学生首次建档/首案联动仍需在 CRM 接通时完成，不能把当前选择既有学生流程称为全部 CRM 完成。
- 真实建案页面先明确选择业务分类，再加载学生/负责人；切换分类清空此前选择并忽略旧请求结果。同步提交锁和相同请求重试使用同一幂等键；签署时间按香港时区提交。选择框提供明确可访问名称。案件列表客户端接受新的实际负责人等级。
- 新增真实 PG helpers：`trial-case-write-sql-assertions.ts` 和 `trial-case-intake-assertions.ts`。覆盖 Founder/L1 两分类建案、L2 授权建案与跨分类拒绝、L3 拒绝、未知分类拒绝、实际角色 FK、SQL 推进/暂停、撤分类后恢复拒绝、选项范围、目标负责人范围、幂等只产生一次审计、冲突、审计失败整案回滚、撤权后原请求重放拒绝。仅合成数据，夹具回滚。
- `TIANXING_TRIAL_BROWSER=1 node --conditions=react-server --test tests/integration/one-role-baseline-postgresql.test.ts` 最终通过，日志 `/tmp/access-trial-intake-browser.log`，明确输出 trial_case_write_sql/trial_case_intake/trial_case_reads/trial_case_intake_browser/trial_member_browser 全部 pass。新浏览器证据：内部邮箱登录，L1 在实际页面选择分类/学生/本人负责人并建案成功，独立数据库连接验证分类与真实 l1；HTTP 原键重放200；L2 跨分类选项和 POST 均403；390px 成功页无横向溢出。桌面表单和移动成功截图 `/tmp/access-trial-case-intake-form.png`、`/tmp/access-trial-case-intake-mobile.png` 已目视检查。
- 测试调试期间观察到 Next Dev 热更新 handleMessage 触发页面重载，丢失 UI 成功提示；最终 harness 预热 API 编译并按顺序关闭前一账号 browser context 后运行成功。未修改 Next、未拦截业务请求、未关闭数据库/权限校验；测试无生产部署证据。第一次单次 readiness 超时已清理，本次最终运行18秒内主场景完成。
- 聚焦回归139/139通过：Cases unit、CRM f2、case-intake/case-workspace route contract、case-intake boundary、one-role baseline、module boundaries；日志 `/tmp/access-trial-intake-regression.log`。类型检查与聚焦 ESLint 通过，日志 `/tmp/access-trial-intake-types.log`、`/tmp/access-trial-intake-lint.log`。生成基线 --check 通过，现为59源迁移/60生成文件，605 public objects，FORCE RLS及身份约束继续通过。

下一步优先：接 `modules/cases/infrastructure/postgresql-assessment-repository.ts` 与 application AssessmentService，使新 Founder/L1 可编辑、L2 范围内可编辑、L3 禁止；目前新建案成功页“开启评估”后的完整流程仍未验收。再接 workflow repository（060只完成 SQL）、candidate list/审批/结案、CRM 首次学生建档、任务/文件及邀请等原计划剩余项。当前不能合并发布，未合并 main、未推送、未部署。

## Assessment 与暂停/恢复（2026-09-19，接续 5aa17ab）

- Assessment 仓储在读写事务内锁定当前试用身份和实际角色，按案件明确分类授权；Founder/L1 完整评估、L2 当前分类、L3 拒绝，旧账号继续既有规则。保留字段校验、固定 manifest、答案版本、幂等、审计/outbox 和案件状态限制。
- Workflow service 接受试用能力，仓储重放调用060的当前范围函数；新请求和旧请求重放均不能借旧授权绕过撤分类。暂停案件评估只读、恢复后可编辑，未改业务状态机或历史迁移。
- 新增真实 PG helper `trial-assessment-assertions.ts`，复用建案合成夹具并独立回滚。验证四等级、跨分类拒绝、答案版本冲突、幂等一次审计、故意审计失败回滚、暂停/恢复、撤分类后读取/写入/旧 workflow 请求重放拒绝。旧单元夹具显式返回未启用试用身份，无产品校验放宽。
- 最终 `TIANXING_TRIAL_BROWSER=1 node --conditions=react-server --test tests/integration/one-role-baseline-postgresql.test.ts` 2/2通过，日志 `/tmp/access-trial-assessment-browser.log`。真实内部邮箱登录后 L1 页面保存出生日期，刷新核对；L2 授权分类 Assessment GET200、L3 GET403。390px无横向溢出，桌面/手机截图 `/tmp/access-trial-assessment-desktop.png`、`/tmp/access-trial-assessment-mobile.png` 已目视检查。第一次脚本先填被“暂时未知”禁用的日期导致超时，调整为先选择“已提供”再填日期，未更改产品行为。
- 聚焦 Cases/Assessment/workspace/module-boundary 回归107/107通过，日志 `/tmp/access-trial-assessment-regression.log`；类型和聚焦ESLint通过，日志 `/tmp/access-trial-assessment-types.log`、`/tmp/access-trial-assessment-lint.log`。
- 尚未证明完成背景收集/选校/结案完整流程，未合并、推送或部署。下一步接 candidate list/审批/结案：`cases_actor_has_active_case_role` 被040/052 SQL命令复用，须追加迁移按新等级区分维护与审批，不能简单把L2等同Founder；应用和读取仓储亦需更新，再做真实流程验证。原计划CRM/任务/文件/邀请及最终整体验收仍须全部完成。

## 候选名单与业务审批（2026-09-19，接续 12c875d）

- 追加061：现有候选名单 SQL 权限入口按显式试用等级及当前分类授权；旧函数的 advisor 参数表示维护操作，founder 参数表示审批/结案操作，不是把员工身份伪装旧角色。L1 有审批权，L2 无审批/结案权，L3 不得整案读取；未启用试用的旧账号仍执行原角色规则。试用分类、身份及实际角色锁定延续060。
- 应用层创建/审批/家长确认/结案、名单查询及家长确认上下文接通；案件页按新等级显示维护和审批入口，界面将“Founder 审核”改为“名单审核”。学校选项读取允许有 schools.read 的新等级并在事务内重查，家长确认选项对L2再次按当前关联分类筛选，不返回联系方式。
- 真实运行暴露基线问题并追加062修复：单账号安装中 application 同时作为owner，旧撤销INSERT导致 definer 命令无法写名单/目标。仅当当前安装账号为 tianxing_app 且拥有目标表时恢复命令需要的INSERT及列UPDATE，保留RLS/触发器/无DELETE；独立migration owner场景不扩大应用表授权。当前 create-v2/review 哈希使用PG17内建 sha256，避免运行时依赖测试临时安装pgcrypto。历史迁移及历史生成文件未改。
- 追加063：家长确认后的自动目标分派保存案件负责人的实际角色，重查试用负责人当前分类，避免旧默认advisor与真实身份FK冲突；目标分派角色集合包含已授权试用等级。自动推进事实及outbox使用统一不早于确认记录的事件时间并显式写updated_at，修复长事务下时间倒退约束失败。未消费申请任务，不代表任务模块已接通。
- `trial-candidate-assertions.ts` 使用真实建案/Assessment service填写全部字段及完成背景收集，再L2提交、L1审批、L2确认家长并触发目标进入preparing/案件application_in_progress。验证跨分类、L3、L2审批及结案拒绝；版本及家长确认哈希保持；旧键重放和撤分类后拒绝；学校选项和家长选项范围。成功结案尚未验证，目前验证的是未完成目标不可结案。
- 聚焦真实PG+Cases/Schools options/迁移/module-boundary检查133/133通过：`/tmp/access-trial-candidate-regression.log`。额外确认重放只发一次application任务事件的最终PG日志 `/tmp/access-trial-candidate-pg-final.log`。生成基线--check通过：62源迁移/63生成文件；FORCE RLS、605 public objects、独立连接及回滚检查通过。类型 `/tmp/access-trial-candidate-types.log` 通过；聚焦ESLint原有两条unused警告已清除，最终 `/tmp/access-trial-candidate-lint-final.log` 无输出。
- 浏览器最终2/2通过：`/tmp/access-trial-candidate-browser.log`。真实L1登录建案、Assessment编辑刷新、填写其余字段和完成背景、HTTP创建名单、实际页面提交审批、刷新及独立DB核对真实l1审批者；L2直接审批403；L3完整评估403。390px无横向溢出，截图 `/tmp/access-trial-candidate-approval-mobile.png` 已目视检查。仅证明名单审批区域，不把整案中尚未适配的来源/任务面板当通过；未验证浏览器家长确认后的任务自动消费和成功结案。

下一步仍需完整推进：目标读取/申请流程及任务模块新等级（包括自动任务实际角色、L3任务必要上下文、撤销、完成只读），然后文件/CRM/邀请和原计划其余权限与最终浏览器场景。成功结案需在目标/任务流程完成后补足真实允许、拒绝及审计回滚证据。当前未合并main、未推送、未部署，目标保持in_progress。

## 手工任务试用等级与 L3 工作区（2026-09-19，接续 4099f1a）

本节为最新状态，总体继续 `in_progress`；任务模块只完成手工任务这一段，尚未合并/推送。

- 手工任务服务接受实际 Founder/L1/L2/L3 身份。仓储每次事务重读并锁定当前试用等级、分类和账号状态，再校验实际 active role binding；停用、变级、撤分类与旧上下文均不能回退历史角色权限。
- 列表在 SQL 中按明确分类筛选。Founder/L1 管理两分类；L2 只管理当前分类；L3 仅显示当前有效指派，允许跨分类任务，不返回案件 ID/编号或负责人资料，也不能通过 case_id 查询整案任务。历史未启用试用等级的账号保留原规则。
- 指派选项及写入只接受当前有效 L3；实际 assignee_role=l3，强制 task_only。接受、拒绝、重派、取消及主管撤销同步当前 Assignment；拒绝/取消/撤销即时移除 L3 访问，完成保留当前 Assignment 供只读。管理者仍能查看负责人已停用或变级的任务，避免任务消失而无法处理。
- 新增064迁移（63份源迁移、64份生成基线），扩大实际任务/指派/收据角色约束；严格限定 L3 的 task_only。删除005遗留、已被041/052新合同取代的重复收据状态约束，否则 awaiting_reassignment 会被误拒绝；未修改历史迁移。
- 修复领域规则解析器与现行 Release 1 策略的漂移：完成不强制另填原因、不新增任务审批；拒绝与主管撤销可以有相同状态边，但必须按 actor_kind 分开校验。新增主管撤销规则选择测试，保留幂等、版本、审计回滚和拒绝断言。
- 界面和客户端接受实际等级，L3 不再显示为外部 Contractor。新增真实浏览器路径：L1 经正式 API 创建手工任务，L3 通过页面接受、完成、刷新后只读；390px 无横向溢出。截图 `/tmp/access-trial-l3-task-mobile.png` 已人工查看。此浏览器证据不包含自动申请/面试任务或主管撤销入口。
- 聚焦真实 PG17、任务单元、模块边界、基线和任务迁移检查 **104/104** 通过，日志 `/tmp/access-trial-task-regression-final.log`。命令：`node --conditions=react-server --test tests/integration/one-role-baseline-postgresql.test.ts tests/unit/tasks/*.test.ts tests/architecture/module-boundaries.test.ts tests/migration/one-role-baseline.test.ts tests/migration/task-workflow-boundary.test.ts tests/migration/task-transition-rule-awaiting-reassignment.test.ts`。
- 一次性 PG17 + 真实 Next/Chrome 浏览器 **2/2** 通过，日志 `/tmp/access-trial-task-browser.log`；命令前加 `TIANXING_TRIAL_BROWSER=1`。同时回归此前员工管理、建案、Assessment、名单审核浏览器路径。类型与聚焦 ESLint 通过：`/tmp/access-trial-task-types-final.log`、`/tmp/access-trial-task-lint-final.log`。
- 特别限制：完成任务的撤销读取边界已通过直接测试夹具持久化撤销验证，**尚无可用的完成后撤销命令/API/UI**，不得称为此功能已完成。当前手工任务 API 不可修改自动任务。任务暂停时后端拒绝写入，但任务详情按钮的只读呈现仍需补齐。

下一步：接通 P3 自动任务与 application-task consumer 的实际等级/分类、当前 Assignment 校验、重放撤权、完成后只读及证据条件；补完成后撤销访问命令和界面、暂停只读展示。之后继续显式任务文件授权、CRM/学校/目标与结案、邀请等剩余接入及完整演示数据/浏览器验收。只在整个已授权计划完成并验证后整合 main、推送；不得将本节当作整体验收或生产证据。

## 自动申请任务、当前权限重验与暂停只读（2026-09-19，接续 eeff511）

最新状态：总体仍 `in_progress`；本节完成自动申请任务的官方提交编号路径，不代表整个 Tasks/Documents 已完成。

- Access/Cases 的公开 task facts 契约接受实际 Founder/L1/L2/L3，返回明确业务分类；Access 事务读取当前员工状态、试用等级与实际 role binding，并按分类检查默认申请负责人。自动任务 consumer 保留实际等级，L3 强制 task_only；不再把新等级强制解释为 Advisor/Contractor。
- P3 mutation 在执行和幂等重放前重查当前分类/指派。Founder/L1、分类内 L2 可重派；L3 只可操作当前指派。已完成 L3 指派保留只读，撤销后连旧完成请求的重放也被拒绝。P3 replay 使用真实操作人及持久化 resultReference，不再用组织 ID 冒充操作人。
- 修复重派写入两次递增任务版本的问题；最终更新检查 rowCount，并同步当前案件负责人投影，避免旧 owner_user_id 阻止有权主管处理任务。保留完成记录、实际提交人、清单、官方编号/凭证校验；提供了凭证 ID 时仍须验证干净文件。
- P3 read/list 及主任务 workspace 在 SQL 层按当前分类或当前 L3 Assignment 过滤。暂停、关闭或不可写资源返回空操作列表；详情页明确显示只读。L1 重派界面补回原来缺失但请求必填的原因输入框。
- 追加065迁移，修复 Case workflow 在毫秒 JS 时间紧接微秒 SQL 时间时可能回退的 updated_at；只钳制为不早于既有 Case 时间，不改授权、状态边或审计要求。Audit 的源事件领取/完成同样采用单调当前时间，避免长事务中源事件晚于 transaction_timestamp 时被时间约束误拒绝。
- 当前为 **64 源迁移 / 65 生成基线**，605 public 对象；未改历史迁移。通用迁移 planner 原动词白名单误拒绝已存在的056/057/059/063及本次065，已与 manifest 的规范文件名格式统一；顺序、校验和及 schema drift 检查保留。
- 新 `trial-automatic-task-assertions.ts` 嵌入真实名单确认后的流程：consumer 失败回滚及恢复、重复投递只生成一次、实际 Founder 默认负责人、L1/L2 重派 L3、暂停只读及写入拒绝、L3 拒绝后失权及重派恢复、取消失权、非法提交人/未完成清单/无效凭证拒绝、官方编号完成、自动 SchoolTarget submitted、完成只读、撤权后重放拒绝。使用真实 PG17、服务/仓储/facts ports 与 outbox consumer。
- 浏览器完整路径：真实 L1 登录、名单家长确认经正式 API 触发自动任务、L1 页面填写原因并重派 L3；L3 页面接受、填写申请记录、完成，独立数据库核验学校目标 submitted；刷新仍只读。390px 截图 `/tmp/access-trial-l3-application-task-mobile.png` 已查看，无横向溢出。日志 `/tmp/access-trial-auto-browser-final.log`，**2/2** 通过；也包含此前员工、建案、Assessment、审核、手工任务路径。
- 最终聚焦检查 `/tmp/access-trial-auto-regression-final.log`：**117通过、0失败、1跳过**。包括一次性 PG17、tasks 单元、架构、基线、P3迁移、drift 与 outbox-audit。跳过的是旧 `outbox-audit.test.ts` 中依赖 TEST_DATABASE_URL 的历史独立用例；本轮 outbox 消费/原子性已在上面的真实一次性 PG 链路执行，不把该跳过项声称为通过。类型、聚焦 ESLint 均无输出通过：`/tmp/access-trial-auto-types-final.log`、`/tmp/access-trial-auto-lint-final.log`。
- 一次聚焦运行曾在既有员工提升 Founder 测试返回 UNAVAILABLE，未取得当次底层错误。增加仅合成测试使用的 SQL 错误诊断后，后续 PG/浏览器/最终聚焦运行均未复现；保留记录，不能声称已定位该偶发问题。

### 明确未完成与下一入口

1. **L3 文件凭证路径暂时 fail closed**：P3 仓储明确拒绝 L3 直接提交案件 document UUID，防止尚未建立的 TaskDocument 授权被绕过。当前 L3 只能用官方提交编号完成申请；下一步必须实现显式 task-file links/actions，再用其当前有效且可用的文件凭证替换此临时拒绝。该限制不是最终产品方案，不能带着它宣称计划完成。
2. 完成后撤销访问仍只有数据库边界测试，未提供命令/API/UI。需要保留完成事实、收据/审计和任务历史，同时结束 Assignment 的读取权限。
3. 面试辅助任务的前端完成/重派目前仍沿用旧“尚未开放”分支，未做真实面试创建至完成验收。新等级接入不能等同于面试全链路完成。
4. P3 replay 目前仍按任务当前状态重建回执，后续状态改变后重复旧请求可能返回 CONFLICT；应按持久化收据重建原结果，并保留当前权限重验。整合前还需审查 Case/target/task/identity 锁顺序与并发撤权证据。
5. CRM 全入口、目标结果/结案、Schools/来源/通知/审计/邀请等剩余权限接入、演示数据、整体验收、正式文档 own hunks、保留原工作区修改地合并 main 并推送，仍按原计划继续。未部署、未迁移真实员工、未操作共享数据库。
