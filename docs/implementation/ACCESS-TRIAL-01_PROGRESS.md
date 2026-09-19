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

## 完成任务撤销访问（2026-09-19，接续 856c847）

总体仍 `in_progress`。本节补齐此前缺失的完成后撤权命令、API 和页面，不代表整个试用计划已完成。

- Founder/L1、当前分类内 L2 可撤销已完成任务的当前 L3 Assignment。事务重查当前账号、等级、分类、任务版本和指派 ID；L3、失去分类的主管及过期指派不能操作。手工和自动任务共用 `POST /api/v1/tasks/:taskId/assignment-revocations`，要求原因、版本及幂等键。
- 撤销只结束 Assignment 并递增任务版本，保留 completed 状态、完成收据、学校目标状态和历史；审计与 outbox 同事务写入。重复提交无重复副作用，写入失败整体回滚。已完成任务在案件暂停时也可收回访问，不开放业务编辑。
- 详情返回明确 revoke_access 操作，页面填写原因并确认后提交，再读取服务端结果。L3 不显示该入口；撤销后详情立即不可读，旧完成请求重放亦拒绝。正常任务流操作与撤权分开解析。
- 真实 PostgreSQL17 + Tasks 单元测试 **53/53**：`/tmp/access-trial-revoke-regression.log`。模块边界与任务路由契约 **19/19**：`/tmp/access-trial-revoke-contract.log`。已覆盖越权、错误版本/指派、撤分类、重复提交、审计失败回滚、暂停时撤权及完成事实保留。
- 本地真实 Next/Chrome + 一次性 PG 浏览器 **2/2**：`/tmp/access-trial-revoke-browser.log`。L3 直接撤权 API 为403；L1 页面撤销后，L3 GET为404，独立数据库仍为 completed/submitted。回归此前员工、建案、Assessment、候选名单、手工/自动任务路径。390px 截图 `/tmp/access-trial-revocation-mobile.png` 已查看，无横向溢出。
- 类型和聚焦 ESLint 通过：`/tmp/access-trial-revoke-types-final.log`、`/tmp/access-trial-revoke-lint.log`。无新增迁移，沿用64源迁移/65生成基线。
- 初次自动任务暂停撤权夹具放在申请已提交之后，被既有 CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS 正确拒绝；将暂停场景移至任务完成、提交事件消费之前并回滚，再验证正常提交及最终撤权。未放宽业务规则。

仍未完成：显式任务文件授权、面试任务界面、P3历史回执重放及并发锁顺序审查，以及上一节列出的 CRM/目标结案/学校/邀请等剩余接入和整体验收。未合并 main、未推送、未部署、未迁移真实员工。

## 任务文件显式授权与 L3 凭证选择（2026-09-19，接续 eae34dd）

总体保持 `in_progress`。本节完成任务文件关联、动作权限、授权/撤销界面和完成凭证接入，**尚未完成任务入口的实际文件上传/下载**。

- 新增066及对应生成基线：`documents_task_links` 按任务和文件唯一保存动作、原因、操作人、版本；空动作表示撤销。外键、同案件校验、版本递增、不可改关联身份、禁止删除历史和 FORCE RLS 保留。面试任务的下载动作在数据库及服务端均拒绝。当前65源迁移/66生成基线，612 public对象。
- `TaskDocumentLinkService` / 仓储每次事务重读并锁定当前试用身份、实际 role binding、案件、任务和当前指派。Founder/L1及分类内L2管理；L3仅当前有效任务的显式 read 关联，不返回全案文件选项、案件资料或其他授权配置。已完成任务不返回 upload 动作；下载动作还要求当前干净、未撤销版本。暂停/关闭/完成后只允许收回授权，不添加授权。
- 正式 `GET/POST /api/v1/tasks/:taskId/documents` 提供列表及单文件动作设置。创建 expected_record_version=0，修改使用当前关联版本；原因及幂等键必填，重放前重验当前权限。写入、审计、outbox及回执同事务；重放不会重复写入。审计允许安全的 document_id 标识符，任务为资源，status记录本次动作集合/撤销；不记录文件名、文件内容或自由文本原因到通用日志。
- 任务详情新增文件授权面板：主管从当前案件文件选项选择文件，明确选择上传/下载动作，填写原因并确认；可撤销已有授权。L3仅看到已关联文件名称/可用状态；无全案入口。授权设置不等于上传/下载传输入口已经实现。
- P3 完成申请时，用当前 L3 身份、当前有效 Assignment、任务 read 关联及干净活动版本校验凭证，替换此前“一律拒绝L3凭证”的临时限制。Documents port锁定文档及版本，避免检查后并发改变安全状态。异步申请提交 consumer使用已授权完成事实并继续校验文件安全状态，不把完成后的授权撤销倒推为删除历史。
- L3 完成表单改为从已授权且扫描通过的文件中选择凭证，不再手填文档UUID。真实PG验证无官方编号+文件凭证完成、学校目标submitted、完成后只读，以及撤销指派后列表/旧完成请求拒绝。
- 实际PG检查覆盖：L2范围内授权、L3自行授权拒绝、跨案件文件拒绝、未扫描文件不可作凭证/不可下载、撤销文件关联后不可作凭证且不再列出、旧版本冲突、重放单次审计、失败整体回滚、撤分类后旧请求拒绝。扫描状态由合成metadata夹具按真实SQL生命周期约束建立；**没有在本节执行真实文件传输或病毒扫描器**。
- 聚焦单元/架构/基线/审计检查 `/tmp/access-trial-files-regression-final.log`：109通过、0失败、1跳过。跳过旧outbox-audit中依赖TEST_DATABASE_URL的历史独立用例；本节真实PG中的授权审计/回滚实际执行。
- 真实Next/Chrome + 一次性PG17浏览器 `/tmp/access-trial-files-browser-final.log`：2/2通过。L1通过页面授权和撤销；L3从下拉框选凭证并在无官方编号时完成申请；学校目标submitted；完成后无upload权限、L3直接授权403、撤文件后列表为空，撤指派后任务404。回归此前员工/建案/Assessment/名单/手工任务/自动任务路径。截图 `/tmp/access-trial-task-file-completion-mobile.png` 已查看，390px无横向溢出。
- 类型及聚焦ESLint通过：`/tmp/access-trial-files-types-final.log`、`/tmp/access-trial-files-lint-final.log`。未改历史迁移。新增迁移为基线角色暂时打开建外键的 REFERENCES 权限窗口后收回，保留最终权限检查。

下一步必须继续：把本节关联动作接到真实任务文件版本创建、上传意图/上传完成、扫描结果和下载意图/传输接口；接入Founder/L1/L2的完整文档范围；完成相关真实本地传输及撤权测试。之后继续面试任务界面、P3历史回执重放、锁顺序/并发审查，以及CRM/目标结案/学校/邀请等原计划剩余项、演示数据、整体测试、合并main并推送。当前未合并、未推送、未部署，未迁移真实员工。

## 任务文件传输与提交前约束校验（2026-09-19，接续 a4bb71b）

总体仍 `in_progress`。本节接通既有 deterministic-fake 本地传输，**不构成 OSS、ClamAV或生产环境验收**。

- Documents metadata目录、单案读取及登记接入当前试用等级/分类。每次事务锁定当前principal与实际角色；Founder/L1全分类、L2当前分类，L3不能经案件文件入口枚举。暂停案件拒绝登记及上传写入。
- 新增任务文件版本创建、上传意图、放弃未完成上传、下载意图路由；案件ID在服务端解析，不返回给L3。实际写入/意图事务重新验证案件、当前任务指派和明确文件动作。同一文件ID或旧Session不能绕过任务边界；任务完成后上传拒绝，面试任务下载拒绝。
- 试用账号的本地传输能力内加密绑定组织、操作人、案件、文件、版本和可选任务ID；消费能力时重新获取登录身份并在事务中重验权限、当前版本与安全状态。旧下载/上传能力在文件授权撤销后不能消费；下载活动版本变化也拒绝旧能力。传输审计同事务写入。文件客户端只带同源Cookie，跨源仍不发送Cookie。
- 任务详情提供文件选择上传、等待扫描结果、下载和放弃pending upload；既有pending版本必须匹配所选文件的摘要/类型才能续传，不覆盖旧版本。扩展授权列表返回当前文档版本和pending引用，依旧无案件信息。
- 修复共用Tenant runner在提交前先清空组织/操作人GUC导致deferred RLS约束读不到父文档的问题：在清空上下文前执行 `SET CONSTRAINTS ALL IMMEDIATE`；失败走ROLLBACK并reset上下文。新增校验失败不COMMIT、校验时保留组织/操作人、释放连接的测试。真实浏览器上传接收/扫描事务已覆盖成功提交路径。
- 追加067让既有本地模拟扫描如实保存 `deterministic-fake-release1` 引擎值，修复触发器与CHECK仅允许ClamAV导致本地链路无法完成的问题；状态、次数、对象版本、父文件及活动指针约束保留。模拟传输仍被生产运行配置拒绝。当前66源迁移/67生成基线。同步修复本地传输隐含1MB最小值与公开1字节至10MB合同的漂移，1KB文件单元测试通过。
- 实际PG检查：业务等级metadata范围、L3案件入口拒绝、任务版本创建/重放/放弃、绑定操作人、撤文件授权后旧请求重放及旧上传/下载能力拒绝、拒绝时传输回调不执行、活动版本改变后旧下载拒绝、接收/扫描各事务实际SQL约束。
- `/tmp/access-trial-transfer-regression-final.log` **132/132**：一次性PG17、shared事务、Documents传输/客户端/仓储、Tasks单元、架构和基线。类型及聚焦ESLint通过：`/tmp/access-trial-transfer-types-final.log`、`/tmp/access-trial-transfer-lint-final.log`。
- `/tmp/access-trial-transfer-browser.log` **2/2**：真实Next/Chrome+PG，L1正式API登记文件/页面授权，L3页面上传1MB合成PDF→本地模拟扫描→下载逐字节一致→选择凭证完成申请→目标submitted。主管撤文件授权后旧下载URL404，撤任务指派后任务404。390px截图 `/tmp/access-trial-task-file-completion-mobile.png` 已查看。前期失败定位为deferred上下文及扫描引擎约束，不再用手工SQL扫描夹具冒充浏览器上传。
- 额外旧静态文件UI契约检查仍有 **1项失败**：`tests/unit/documents/transfer-ui-contract.test.ts` 的“permanent browser gate”还要求固定36文件、已移除的 `test:doc-02-dev-browser` package脚本，而现行历史浏览器源码已采用 ONE_ROLE_SOURCE_COUNT+1。临时核对计数后进一步确认脚本缺失；未恢复过时入口，计数断言保持原样。该旧gate尚需最终验收整理，不计入132通过。其余11项通过；日志 `/tmp/access-trial-transfer-ui-contract.log`。本节没有运行旧LocalStack/ClamAV整套环境。

剩余事项仍包括：真实OSS/生产部署不在当前授权内；文档删除/恢复/回滚等既有入口的新等级接入与补足安全/并发场景，面试任务前端、P3历史回执重放、锁顺序审查、CRM/学校/目标结案/邀请等原计划剩余接入、演示数据、整体本地验收及旧gate梳理。只有全部已授权开发验收完成后再合并main、推送。当前未合并、未推送、未部署。

## P3 历史成功回执重放（2026-09-19，接续 7045c82）

总体仍 `in_progress`，本节仅完成历史任务请求重试修复。

- 成功幂等记录引用任务 ID 与结果版本；重放从不可变 transition receipt 还原原始响应，并核对已保存的响应摘要。后续任务完成不再让先前的接受/重派请求错误冲突。兼容旧的仅任务 ID 引用，不改历史数据或迁移。
- 重放仍先验证当前等级、分类与指派；撤销指派后的旧接受/完成请求拒绝，不因历史成功而恢复权限。真实 PG 验证新旧引用、完成后重试、暂停撤销及最终撤销；历史任务状态与完成凭证保留。
- 正式浏览器发现全局保留 runtime 的错误实例不能通过重载后的 constructor instanceof 检查，导致应为404的拒绝成为500。沿用现有 TaskWorkspaceError 模式，增加仅接受 Error 实例、精确错误名称与已知code的 P3 guard；不把任意对象视为业务错误。
- `/tmp/access-trial-replay-unit-final.log`：任务单元测试 **52/52**。`/tmp/access-trial-replay-browser-final.log`：真实 Next/Chrome + 一次性 PG17 **2/2**，包括完成后接受重放返回原响应、撤权后相同正式HTTP请求404，以及此前成员/建案/名单/任务/文件流程回归。文件仍为本地模拟扫描传输，不是OSS或ClamAV验证。
- 类型检查、聚焦ESLint及diff空白检查通过：`/tmp/access-trial-replay-types-final.log`、`/tmp/access-trial-replay-lint-final.log`。无新增迁移。

仍需继续上一节除P3历史回执以外的剩余开发、安全/并发审查、整体验收、合并main和推送；未部署，未改真实员工。

## 面试任务完成页面（2026-09-19，接续 011a18b）

总体仍 `in_progress`。本节接通已存在面试任务的完成操作，尚不证明学校邀请至任务创建的完整链路。

- 去除“面试完成记录尚未开放”占位，提供完成时间、面试方式和辅导摘要；香港时间转换、必填、操作确认、失败保留输入、幂等重试及服务端权威刷新沿用既有任务交互。主管在服务端允许时可使用重派入口；L3不展示重派。
- 新客户端命令调用正式p3-transitions接口，严格校验任务ID、版本、completed状态及完成回执；面试完成不要求申请提交资料，也不接收或显示申请自动推进结果。完成记录使用实际输入，未沿用旧F3组件的硬编码摘要。
- `/tmp/access-trial-interview-unit-final.log`：**53/53**任务单元检查通过。覆盖面试请求内容、空摘要拒绝、错误回执拒绝与幂等指纹；更新旧静态占位断言。
- `/tmp/access-trial-interview-browser-final.log`：真实Next/Chrome+一次性PG17 **2/2**通过。在真实SQL约束下建立合成面试任务夹具，L3页面接受、填写并完成；数据库中的时间/方式/摘要与输入一致，学校目标状态不变；完成只读、不返回case_id，完成请求重放200，主管撤权后旧请求404。此前申请/文件/成员/案件流程一并回归。**夹具直接建立任务，不代表面试邀请、状态推进或自动创建已经验收。**
- 类型、聚焦ESLint、diff检查通过：`/tmp/access-trial-interview-types-final.log`、`/tmp/access-trial-interview-lint-final.log`。390px截图 `/tmp/access-trial-interview-mobile.png` 已查看，无横向溢出。无新增迁移。

下一步接通学校目标的面试邀请/状态操作及任务创建。其余文档生命周期、并发、CRM/学校/邀请、演示数据、整体本地验收及旧gate仍须完成，然后合并main并推送；未部署、未变更真实员工。

## 面试任务创建基础验证（2026-09-19，接续 5258ce0）

总体仍 `in_progress`。核对发现学校目标 transitions/outcomes 路由仍为拒绝写入的占位，CaseOutcome runtime未配置；不能把前一节任务页面通过视为邀请创建链路已完成。

- P3 ensureTargetTask 原来将学校目标Assignment ID复用为TaskAssignment主键。改为服务端生成独立taskAssignmentId，学校关系ID只用于事实查验。后续面试任务不再与同一学校关系下的旧任务指派发生主键冲突；不改既有关系或历史迁移。
- 补齐领域策略：仅学校目标已经处于interview时允许创建面试任务，与仓储既有状态校验一致。
- 真实PG测试通过合成学校面试transition fact建立前置状态，再调用真实P3服务/仓储：submitted时创建拒绝；interview时创建；写入失败全部回滚后可重试；同请求重放只有一条任务；TaskAssignment与学校关系编号不同；L1重派L3、L3接受/完成；学校保持interview；旧任务完成后另一明确事件可创建新任务，不冲突。
- `/tmp/access-trial-interview-provision-final.log`：一次性PG17及任务单元 **56/56**通过。类型检查 `/tmp/access-trial-interview-provision-types-final.log`、聚焦ESLint `/tmp/access-trial-interview-provision-lint.log`、diff检查通过。本节未运行浏览器、未验证学校邀请正式HTTP入口，未新增迁移。

仍须接通学校邀请的正式写入、证据校验、审计/消息投递、自动创建和页面。当前只验证其任务创建基础，不标记完整链路完成；总体剩余项和合并推送目标不变。

## 学校面试邀请事务（2026-09-19，接续 e99ad72）

总体仍 `in_progress`。新增邀请服务及PostgreSQL仓储，尚未连接HTTP、自动任务consumer或页面。

- 显式试用成员按当前principal、真实角色绑定、案件分类和可写状态校验；锁定案件后锁学校目标，只允许submitted→interview，检查expected version。L3不能登记邀请，旧账号不自动获得该新服务权限。
- Documents公开适配器增加仅检查本案件干净活动文件的方法；邀请凭证必须为未软删、未撤销且活动版本available的文件，事务持有文件/版本锁。Cases不直接读取Documents私有表。
- 同一事务保存不可变学校transition fact（时间、凭证和实际操作人）、学校新状态、审计及 `cases.interview_invitation_recorded` outbox。未来任务消费可依据该已提交事件查事实；本节没有把事件标为已投递或声称任务已自动创建。
- 邀请重放从历史fact还原原响应并核对摘要，仍重新验证当前权限。真实PG夹具已用实际邀请服务替换手工学校transition SQL，然后调用实际任务创建服务验证后续基础。
- `/tmp/access-trial-invitation-final.log` **72/72**：一次性PG17、模块边界、任务单元；覆盖分类内L2邀请、无有效凭证拒绝、L3拒绝、提交前失败回滚、重试单次审计、同成功请求在撤销分类后拒绝，以及面试任务创建/重派/完成。类型、聚焦ESLint、diff检查通过：`/tmp/access-trial-invitation-types-final.log`、`/tmp/access-trial-invitation-lint-final.log`。

未新增迁移、未执行本节浏览器/HTTP验证、未部署。下一步连接邀请事件到面试任务consumer和正式API/页面；其余原计划剩余工作、最终合并main与推送目标不变。

## 面试邀请HTTP与自动任务（2026-09-19，接续 a07cbda）

总体仍 `in_progress`。新增正式 `POST /api/v1/cases/:caseId/school-targets/:targetId/interview-invitations`，目前调用接口可完成登记，录入表单仍未接入。

- Cases facts port通过已保存邀请fact和对应outbox事件查验学校、案件、当前负责人及真实角色；Tasks consumer不直接读取Cases私有表。面试任务默认交给当前案件负责人，截止时间采用已记录面试时间；独立指派ID、事件业务键防止重复。
- 消费事务锁定邀请事件，创建任务/指派/任务审计并完成消息投递。失败全部回滚返回pending；相同邀请再请求可恢复。已投递事件核对已有任务的案件及学校，不因错误caseId返回成功。未新增后台轮询部署。
- API先调用已验证邀请事务，再消费对应事件；返回明确completed/pending。严格解析请求字段、版本、时间和凭证；L3拒绝，错误映射为标准状态。原transitions/outcomes占位接口未宣称已接通。
- `/tmp/access-trial-interview-consumer-final.log` **72/72**：真实PG17、模块边界、任务单元；新增消费失败无任务残留、恢复、重复只一条、默认Founder及错误案件拒绝。类型和聚焦ESLint通过：`/tmp/access-trial-interview-consumer-types-final.log`、`/tmp/access-trial-interview-consumer-lint.log`，diff检查通过。
- `/tmp/access-trial-interview-invitation-browser.log` **2/2**：真实Next/Chrome+PG，已用正式邀请HTTP替换之前的SQL面试任务夹具；L3登记403，L1登记及重放200、自动任务默认L1且只有一条，页面重派L3→接受→完成→只读→撤权后旧请求404。学校保持interview，面试完成不推进录取结果。390px截图 `/tmp/access-trial-interview-mobile.png` 已查看。

仍需邀请录入页面、任务必要背景/面试资料展示、pending恢复交互，以及原计划其余文档生命周期、并发、CRM/学校/邀请账号、演示与整体验收。未部署、未合并main或推送；全部授权工作完成后再执行最终合并推送。

## 面试邀请录入与学校目标读取（2026-09-19，接续 3a80d94）

总体仍 `in_progress`。已替换面试页旧F3占位展示，并从案件详情提供入口。

- 学校目标读取服务接入当前试用等级、真实角色绑定和案件分类；L1/分类内L2可读，L3拒绝，当前授权撤销后拒绝。服务端返回can_record_interview，暂停/关闭不显示登记表单；旧用户保留原读取边界，不隐式升级。
- 面试页面选择已submitted的学校、香港时间及本案有干净活动版本的邀请文件，确认后调用正式邀请API。完成后刷新学校列表；返回pending时保留原请求及幂等键并提供重试。日期/文件改变会生成新请求；不自动填写邀请事实。
- Typed客户端校验任务创建completed/pending回执及目标/版本/邀请ID。新增pending回执和错误目标拒绝检查。合成旧仓储夹具明确返回未加入试用模型，保留原有历史断言；新等级授权使用真实PG覆盖。
- `/tmp/access-trial-invitation-ui-regression.log` **38/38**：学校目标服务/仓储/客户端、路由契约及模块边界。`/tmp/access-trial-invitation-ui-browser-final.log` **2/2**：真实Next/Chrome+PG，从邀请表单提交→自动任务→页面重派L3→接受/完成/撤权，同时验证邀请重放无重复任务。PG附加验证L1/L2目标读取、L3拒绝、撤销分类后读取拒绝。前两次浏览器失败是select标签无法精确识别，补明确可访问名称后通过。
- 类型及聚焦ESLint通过：`/tmp/access-trial-invitation-ui-types-final.log`、`/tmp/access-trial-invitation-ui-lint-final.log`；diff检查通过。390px截图 `/tmp/access-trial-interview-invitation-mobile.png` 已查看，无横向溢出。未新增迁移。

尚未模拟浏览器pending恢复，也尚未补面试方式/语言/必要背景输入及其任务展示。原计划其他剩余开发、安全与整体验收、合并main和推送继续；未部署或改真实员工。

## 面试执行背景（2026-09-19，接续 aa06dc5）

总体仍 `in_progress`。已补本节执行背景；上节pending恢复浏览器检查仍未完成。

- 邀请表单/API增加面试方式、语言、辅导要求、必要背景摘要；服务端验证必填与长度（方式/语言200、要求/背景1500），纳入幂等请求摘要。界面提示这些字段会提供给任务负责人，不自动抽取Assessment或联系方式。
- 追加068迁移在不可变学校transition fact保存四个字段；历史全空字段允许保留，新服务写入完整内容。只追加迁移，不改历史SQL；当前67源迁移/68生成文件，基线生成和校验通过。
- Cases facts port从已固定学校版本获取名称，与邀请明确填写的四个字段组成任务工作内容。自动任务保留面试时间为due_at，L3直接在既有任务必要上下文投影查看，不额外开放整案字段。字段合计受现有任务brief长度限制内的输入上限约束。
- `/tmp/access-trial-interview-context-final.log` **53/53**：真实一次性PG17迁移dry-run/apply、模块边界、基线/客户端、Next/Chrome实际表单→邀请→自动任务→L3上下文及完成/撤权。PG检查空摘要/超长要求拒绝、任务摘要实际包含输入；浏览器验证L3任务内容。`/tmp/access-trial-interview-context-types-final.log`和聚焦ESLint日志通过，diff检查通过。
- 修复 `tests/unit/runtime/one-role-contract.test.ts` 陈旧40/41计数：按规范源manifest逐条比较名称及SHA256，再核对生成文件多一份hardening。保留基线独立/角色/状态检查，不仅替换为另一个固定数字。
- 390px邀请及任务截图 `/tmp/access-trial-interview-invitation-mobile.png`、`/tmp/access-trial-interview-mobile.png` 已查看；名称/方式/语言/要求/背景清楚显示，无横向溢出。

下一步补浏览器提交不确定/pending恢复，继续原计划文档生命周期、并发及其余模块与整体验收。未部署、未迁移真实员工、未合并main或推送。

## 面试提交不确定与任务恢复（2026-09-19，接续 efc6f64）

总体仍 `in_progress`。本节补齐上节遗留的真实浏览器恢复检查。

- 已登记面试的学校提供“檢查或恢復支援任務”。PATCH接口按当前成员等级、分类、案件可写状态重新授权，从数据库读取当前邀请事实，再消费原事件；刷新页面后也可恢复，不依赖浏览器保存私密表单，不另建邀请。
- 真实浏览器测试在一次性PG增加临时任务约束，使邀请实际保存、任务实际创建失败；截断已提交POST响应模拟网络中断。页面保留输入及原幂等键，重试返回pending。刷新后恢复入口仍可用，解除临时约束后任务创建成功；邀请审计及任务均只有一条，L3恢复请求403。测试约束不进入生产迁移。
- `/tmp/access-trial-interview-recovery-browser-final.log` **2/2**：真实Next/Chrome与一次性PG；继续覆盖任务重派、L3接受/完成/只读、重放及撤权。`/tmp/access-trial-interview-recovery-regression.log` **24/24**：PG、客户端及模块边界，包含撤销分类后恢复拒绝。
- 类型检查 `/tmp/access-trial-interview-recovery-types-final.log`、聚焦ESLint `/tmp/access-trial-interview-recovery-lint.log`、diff检查通过。390px截图 `/tmp/access-trial-interview-pending-mobile.png` 已查看，输入、失败提示及重试按钮可见。修复已填写textarea的明确可访问名称。

本节未新增迁移、未连接真实OSS或扫描服务、未部署、未变更真实员工、未合并main或推送。原计划文档生命周期、并发、其余模块与整体本地验收仍未完成，继续后再合并推送。

## 文件生命周期数据库执行层（2026-09-19，接续 6b927a9）

总体仍 `in_progress`。发现现有DocumentVersionService只有仓储契约、version-runtime仍固定不可用；本节补PostgreSQL仓储，尚未接通runtime/正式HTTP或页面。

- 新仓储对显式试用成员重新加载当前等级、成员及账号状态、真实角色绑定，按案件分类锁定案件，再锁文件和目标版本。L3及未加入试用模型的旧账号不能使用新生命周期写入；暂停/关闭或学生非active时拒绝写入。
- 回退只修改活动版本指针，目标必须属于本文件且available、未撤销；保留新旧版本。软删除写pending_delete并清空活动指针，不删除对象；法律保留阻止软删除。恢复仅允许软删除后30天内且指定版本干净可用，恢复后清除删除时间。
- 写入、审计、outbox及幂等回执同事务提交。旧请求返回其原始回执而非后续文档状态，重放仍验证当前权限；事务失败可用原键重试。未增加物理清除或批量下载。
- `/tmp/access-trial-document-lifecycle-final.log` **26/26**：真实一次性PG17、既有版本服务工作流、模块边界。通过真实上传接收/扫描服务生成第二个available版本，再回退旧版本；覆盖L3拒绝、无效/撤销版本拒绝、旧版本冲突、失败全回滚、软删除/恢复、过期拒绝、同键不同内容拒绝、审计单次、法律保留及撤销分类后的历史恢复请求拒绝。扫描仍为本地deterministic-fake，并非真实病毒扫描。
- 类型 `/tmp/access-trial-document-lifecycle-types-final.log`、聚焦ESLint `/tmp/access-trial-document-lifecycle-lint-final.log`、diff检查通过。测试过程中修正两处夹具：撤销版本必须同时离开available；分类撤销必须以当前Founder执行。
- 首次整组运行的成员管理检查出现一次access_role_bindings_timestamps_check错误，独立重跑及最终运行通过；本节未改该成员逻辑，偶发时间戳风险仍待后续并发验收排查，不能据此称全系统稳定。

未新增迁移、未运行本节浏览器验证、未部署、未合并或推送。下一步接通文件生命周期正式接口及页面，继续剩余模块、并发和整体本地验收。

## 文件生命周期正式接口（2026-09-19，接续 47b60b8）

总体仍 `in_progress`。已将version-runtime接到配置中的PostgreSQL runner，启用既有deletions/restorations/version-rollbacks三个正式POST入口；页面操作尚未接通。

- 保留敏感操作Session校验，仓储重新验证当前试用等级及分类。缺失运行配置或旧production-aws模式仍拒绝，无内存或对象存储写入后备。修复运行环境解析错误统一映射为runtime unavailable；错误码覆盖仓储UNAVAILABLE，并使用稳定错误名称避免开发热更新构造器不一致。
- 三个入口复用文件请求解析，要求application/json、精确字段及无query参数；重复JSON键（含转义键）由既有解析器拒绝。不接受客户端附加角色或组织字段。
- `/tmp/access-trial-document-lifecycle-http-final.log` **2/2**：真实Next/Chrome+一次性PG17。L1正式HTTP删除→恢复→回退200，L3删除404，无效版本409，多余/重复字段400；删除后旧L3下载链接404，恢复后原删除请求仍返回原回执且不重复删除。继续完成原面试/任务/撤权浏览器回归。
- `/tmp/access-trial-document-http-regression.log` **28/28**：文件请求契约、版本服务工作流及模块边界。类型 `/tmp/access-trial-document-http-types-final.log`、聚焦ESLint `/tmp/access-trial-document-http-lint.log`、diff检查通过。未修改页面，本节不新增截图或声称UI生命周期流程通过。

后续需增加安全的版本历史读取及页面选择/确认/错误反馈，并完成剩余模块、并发与整体本地验收。未部署、未合并main或推送；未变更真实员工及云配置。

## 文件版本历史与页面生命周期（2026-09-19，接续 b2b5569）

总体仍 `in_progress`。发现案件文件页仍引用旧F4占位组件，已切换到正式CaseDocumentsPanel，并增加版本/恢复管理。

- 新GET history接口事务内验证当前试用等级、真实角色及案件分类，L3拒绝。只返回版本编号、时间、状态、是否当前/可选及文件操作许可，不返回对象坐标、上传人或签名链接；暂停/关闭案件可读历史但不允许写入。恢复截止时间及法律保留由服务器返回。
- 页面按服务器许可展示操作，只有干净未撤销的版本可选择；回退排除当前版本。删除/恢复/回退均要求勾选确认，提交期间禁用，成功后重读文件和历史；不确定响应保留原幂等请求供同页重试，拒绝后清除历史展示。支持删除后刷新页面再选择版本恢复。
- `/tmp/access-trial-document-lifecycle-ui-final.log` **2/2**：真实Next/Chrome+一次性PG17。真实L1页面上传第二版本→回退第一个版本（核对DB活动指针）→删除→刷新→恢复；L3历史接口404，响应字段白名单验证。新增PG历史验证覆盖分类内L2、L3拒绝、恢复许可、撤销分类后历史读取拒绝。此前任务/邀请浏览器流程继续通过。
- `/tmp/access-trial-document-history-unit.log` **31/31**：客户端、版本服务工作流、模块边界；客户端拒绝对象坐标扩展字段和错误资源回执，检查写入请求键及字段。类型 `/tmp/access-trial-document-history-types-final.log`、聚焦ESLint `/tmp/access-trial-document-history-lint.log`、diff检查通过。
- `/tmp/access-trial-document-lifecycle-mobile.png` 已查看，390px下版本历史、版本选择、操作按钮及恢复反馈可见，无横向溢出。扫描仍为deterministic-fake，本节没有真实OSS或病毒扫描验收。
- 首次浏览器运行在既有L3上传阶段遇到upload-intents 404，新页面流程尚未开始；同一代码重跑该阶段及新增流程通过。保留 `/tmp/access-trial-document-lifecycle-ui.log` 失败证据，后续稳定性/并发排查仍需定位，不以一次重跑绿标记全系统稳定。

未新增迁移、未部署、未映射真实员工、未合并main或推送。继续并发、其余模块和整体本地试用验收后再完成合并推送目标。

## 角色撤销时间顺序与上传诊断（2026-09-19，接续 554242f）

总体仍 `in_progress`。继续调查稳定性时再次遇到access_role_bindings_timestamps_check，这次发生在独立schema夹具撤销旧角色阶段；与上传404分开处理。

- 旧角色触发器以transaction_timestamp覆盖updated_at，未考虑可见行的时间晚于事务快照。增加固定夹具：创建时间比当前事务晚2秒的角色绑定，然后撤销；旧代码稳定触发同一时间约束（`/tmp/access-trial-binding-clock-before.log`），并非靠重复运行期待失败。
- 追加069纠正迁移，更新时间取事务时间、旧更新时间、创建时间的最大值；身份不可变、状态/版本、员工资料及最后一个Founder约束均保留。不改历史迁移。基线当前68源迁移/69生成文件、612公共对象。
- `/tmp/access-trial-stability-after-final.log` **4/4**：PG17真实dry-run回滚/独立连接清洁校验、apply/RLS、固定角色撤销夹具、成员管理及并发最后Founder保护、Next/Chrome完整文件与任务/邀请流程、基线契约。基线生成/校验、类型 `/tmp/access-trial-stability-types.log`、聚焦ESLint `/tmp/access-trial-stability-lint.log`、diff检查通过。
- 首次新迁移草稿带内部BEGIN/COMMIT，基线dry-run的独立清洁校验正确拒绝；已按本仓库约定移除内部事务，由runner管理，最终dry-run确认无残留。未在共享数据库执行。
- 浏览器上传诊断增加JSON/非JSON响应区分及允许名单错误码，不输出私密URL、ID或响应正文。此次版本创建201、授权200、字节上传200，之前偶发授权404仍未定位，不能标记已修复；新增诊断供后续复现使用。

未部署、未变更真实员工、未合并main或推送。任务/文件并发锁顺序及原计划其余模块、整体本地验收仍继续。

## 任务与文件并发锁顺序（2026-09-19，接续 56aa7a5）

总体仍 `in_progress`。本节修复已实际复现的P3任务/文件锁顺序反转，不把它解释为此前未定位的上传404。

- 原P3任务命令先锁tasks_tasks再读取并锁案件，文件操作则案件→任务。新增双连接检查：独立连接持有案件UPDATE锁，实际浏览器发起接受任务；pg_blocking_pids确认任务事实查询确实等待，再以文件事务尝试任务SHARE NOWAIT。旧代码固定失败55P03（`/tmp/access-trial-task-lock-before.log`），证明等待案件时已占有任务锁。
- P3先无锁读取案件/目标定位，经Cases公开facts port按案件→学校目标/关系锁定，再锁任务并核对定位未改变，然后读取任务指派。命令及历史重放的试用授权均使用同一顺序；Cases SQL仍留在其所属模块，保留当前权限、版本、任务状态和证据检查。
- `/tmp/access-trial-task-lock-after.log` **27/27**：真实PG17/浏览器并发检查、任务策略/错误边界和模块边界。等待案件期间任务行不被占用，释放后真实接受命令200；后续上传、完成、文件生命周期、邀请及撤权流程继续通过。
- 将等待观测收窄到实际Cases事实查询后，`/tmp/access-trial-task-lock-final.log` **2/2**再次通过真实PG/Chrome。类型 `/tmp/access-trial-lock-order-types.log`、聚焦ESLint `/tmp/access-trial-lock-order-lint.log`及helper lint、diff检查通过。无新迁移或页面变化。

本节证明这一个跨模块锁顺序场景已修复，不代表全部并发组合已验收。此前偶发上传404在两次回归中均未复现，继续保留其诊断和未定位状态。其余模块、整体本地验收及最终合并推送仍未完成；未部署或变更真实员工。

## CRM 学生读取与查重范围（2026-09-19，接续 1d1394a）

总体仍 `in_progress`。修复学生列表/详情及查重提示仅按组织读取、未按L2分类收窄的问题。

- 事务内读取当前试用成员及真实角色；Founder/L1可读取正常业务主档，L2仅返回获授权分类案件关联的学生，L3及停用试用成员不回落到旧角色。Cases公开port只返回可见学生ID，CRM不直接访问Cases私有表。
- 学生及家长查重使用同一范围；家长须有当前有效关系关联可见学生。保留非空姓名/邮箱/电话匹配、重复警告及token语义，不自动关联或合并。未启用试用等级的旧账号保留原有业务授权路径。
- `/tmp/access-trial-crm-scope-final2.log` **34/34**：真实PG17、学生读取/接口契约、查重及建档既有回归、模块边界。分类内/外及未知分类、Founder/L1/L2/L3和旧Advisor、分类撤销、成员停用均覆盖。
- `/tmp/access-trial-crm-scope-browser-final.log` **2/2**：真实Next/Chrome与PG17。L2正式学生列表与数据库期望集合一致，越界详情404，查重HTTP不返回越界学生；L3列表403。既有任务、文件及邀请流程继续通过。
- 类型 `/tmp/access-trial-crm-final-types.log` 无错误；聚焦ESLint `/tmp/access-trial-crm-final-lint.log` 无错误，保留旧read-repository未使用函数警告1条；diff检查通过。无迁移。

建档、资料修改及其余CRM写入仍须适配新等级；本节不是整个CRM验收。整体本地试用验收、main合并与远程推送仍未完成；未部署、未变更真实员工。

## Founder/L1 学生原子建档（2026-09-19，接续 ef76aca）

总体仍 `in_progress`。修复L1已有学生建档能力但仓储仅接受旧Founder/Advisor角色的问题。

- 建档事务读取并锁定当前试用成员，只接受有效Founder/L1及对应真实角色；不与旧Advisor取并集。未启用试用等级的账号继续旧资格检查。幂等回执的第二次读取事务也重新验证权限，避免两事务之间撤权后继续返回。
- 保留学生/主要家长/唯一当前关系、查重确认、审计和outbox同事务写入，未增加迁移或修改建档字段。L2尚无未关联案件学生的分类归属规则，本节不放开独立建档；其现有拒绝行为保持，后续需要明确此业务决定。
- `/tmp/access-trial-crm-create-final.log` **30/30**：真实一次性PG17、Next/Chrome、建档仓储/服务及模块边界。真实L1登录后正式POST创建201、同键重放201且回执一致；数据库核对唯一主要关系及单条建档审计。L2同入口403。停用、L2/L3及失去实际L1绑定的仓储拒绝回归通过。既有文件/任务/邀请浏览器流程继续通过。
- 第一轮浏览器使用旧测试请求缺少新建家长kind及职责字段，被现有解析器400正确拒绝；已修正为正式契约，未放松生产校验。拒绝单测补齐幂等锁模拟后通过。
- 类型 `/tmp/access-trial-crm-create-types-final.log`、聚焦ESLint `/tmp/access-trial-crm-create-lint-final.log`、diff检查通过。本节验证正式HTTP建档，不代表已完成建档表单交互的新增浏览器验收。

资料修改、家长关系写入等CRM适配、整体试用验收及main合并/推送仍未完成。未部署、未变更真实员工或外发邮件。

## CRM 学生与家长资料修改（2026-09-19，接续 4a37176）

总体仍 `in_progress`。本节把资料修改仓储从旧Founder/负责Advisor判断接入当前试用等级和分类。

- 共用当前成员/真实角色/分类查询，以显式enrolled标记区分试用与历史账号；试用Founder/L1可维护正常主档，L2仅维护授权分类案件关联学生及其当前家长，L3拒绝。请求中旧等级与数据库当前等级不一致时拒绝；分类及关系在事务中锁定，旧角色不扩大新等级权限。
- 新命令和同键回执读取都经过当前权限校验。保留版本冲突、待删除禁止写入、唯一主要联系人及审计/outbox事务语义；已删除资料即使有旧成功回执也返回不存在。
- `/tmp/access-trial-crm-profile-final.log` **32/32**：PG17真实仓储/服务矩阵、资料服务和路由契约、模块边界。覆盖Founder/L1、分类内/外/未知分类L2、L3及历史Advisor，学生和家长分别验证；同键原回执、单份审计/outbox、旧版本拒绝、分类撤销及L1停用后的缓存请求/旧回执拒绝。修正既有测试夹具缺少当前AccessContext能力以及已确认gender/家长生日字段，未降低生产契约。
- `/tmp/access-trial-crm-profile-browser-final.log` **2/2**：真实Next/Chrome中L1打开学生详情，编辑学生及家长姓名、保存并刷新；数据库核对家长持久化。L2正式PATCH分类外学生/家长均403；既有文件、任务、邀请流程继续通过。
- `/tmp/access-trial-crm-profile-mobile.png` 已查看，390px下内容和操作可见，无横向溢出。第一次浏览器定位把必填标记计入label而超时，改用实际可访问textbox名称后通过，未修改页面规避测试。
- 类型 `/tmp/access-trial-crm-profile-types-final.log`、聚焦ESLint `/tmp/access-trial-crm-profile-lint-final.log`、diff检查通过。无新迁移。

家长关系列表/历史仍存在独立入口未按试用分类过滤，下一步须收窄；关系新增、交接、解除等写入仍须适配。整体试用验收及main合并/推送未完成；未部署或变更真实员工。

## 家长当前关系与历史读取范围（2026-09-19，接续 72c9190）

总体仍 `in_progress`。补齐独立家长关系列表/历史入口的分类检查，避免绕过学生详情读取联系人。

- 两个仓储入口在同一租户事务中验证当前试用成员、真实角色及分类；仅可见学生可返回当前关系和关系历史。拒绝范围返回不存在，停用/撤销分类没有历史角色回落；旧账号路径保持既有语义。
- `/tmp/access-trial-crm-relationship-read-final.log` **33/33**：真实PG17矩阵、Next/Chrome、关系仓储及解除关系回归、模块边界。四等级、两分类、未知分类、分类撤销均覆盖当前/历史两种读取；L2正式GET分类内200、分类外404，资料编辑和既有文件/任务/邀请流程继续通过。
- 类型 `/tmp/access-trial-crm-relationship-read-types.log` 无错误；聚焦ESLint `/tmp/access-trial-crm-relationship-read-lint.log` 无错误，保留旧toEndResult未使用参数警告1条；diff检查通过。单测旧假查询增加未启用试用成员的显式空结果，不绕过真实权限检查。无迁移或页面修改。

关系搜索、关联、主要联系人交接和解除等写入适配仍未完成；其余模块、整体试用验收及main合并/推送继续。未部署、未操作真实员工数据。

## 家长搜索、关联、交接与解除服务端（2026-09-19，接续 090713a）

总体仍 `in_progress`。本节接通新等级关系写入，同时修复真实PG流程暴露的既有缺陷；页面尚未接通。

- Founder/L1可维护业务关系，L2仅操作获授权学生；搜索与手动关联已有家长也要求其当前关联于可见学生，不能通过家长ID关联范围外对象。L3拒绝。新命令和旧幂等回执均事务内复查，解除回执的第二读取事务也重新授权；无历史角色并集。
- 按BR-025修正交接：关闭旧关系版本后，旧主要联系人建立非主要的新版本，继任人建立主要新版本，保留双方职责与历史；旧联系人须另行明确解除。仍保证唯一当前主要联系人。关联/交接回执不因后续结束历史行而改变原创建版本。
- 实际交接后立即解除暴露应用毫秒时钟与PG微秒/时钟偏差问题，旧解除写入可早于关系starts_at/updated_at。结束时间使用数据库当前时间及现有时间下界，严格晚于starts_at；增加应用时钟落后60秒的真实夹具，保持不可变历史约束。解除outbox移除未在数据库允许名单内的previous_record_version；之前版本继续保留审计metadata，不放宽数据库允许名单。
- `/tmp/access-trial-crm-guardian-regression-final.log` **41/41**：真实PG17、关系服务/仓储/接口契约、模块边界。四等级、两分类/未知分类、搜索越界、直接关联隐藏家长、主要联系人直接解除拒绝、交接后仍关联、明确解除、原回执重放、单条审计、数据库延迟约束，以及分类撤销/L1停用后全部命令旧回执拒绝。
- `/tmp/access-trial-crm-guardian-final.log`中真实Next/Chrome+PG子测试**2/2通过**：L1正式HTTP搜索→关联→交接→解除及原回执重试通过，数据库核对旧主要联系人保留到显式解除；既有资料编辑、文件、任务和邀请浏览器流程继续通过。该批整组40/41，唯一失败是旧解除单测仍期待已移除的outbox字段；修正测试后上项41/41通过。没有把该批整组写为全绿。
- 类型 `/tmp/access-trial-crm-guardian-types.log` 无错误；聚焦ESLint `/tmp/access-trial-crm-guardian-lint.log` 无错误，旧未使用参数警告1条；diff检查通过。无新迁移。

已确认家长管理页面仍使用旧F2契约，尚不能把本节正式HTTP证据当作关系页面验收。下一步接通搜索选择、交接和解除页面，并补齐已确认的新建家长关联入口。其余模块、整体试用验收和main合并/推送仍未完成；未部署或使用真实客户数据。

## 家长管理页面接通（2026-09-19，接续 9e7b90a）

总体仍 `in_progress`。替换实际页面使用的旧F2契约，接通已有家长搜索、关联、交接及解除；本节未实现新建家长关联。

- 页面从正式CRM客户端读取当前关系、学生状态与当前能力。已有家长通过姓名/电邮/电话显式搜索并手动选择，只展示脱敏提示；关系类型使用受控词汇，other填写说明，各职责分别选择。交接只选当前关联家长并确认；主要联系人不提供直接解除，非主要关系需单独确认。员工不输入内部ID或版本号。
- 统一同步提交锁，成功后重读权威关系；未知失败保存原操作指纹/幂等键，权限拒绝清空关系和候选。保留加载、空搜索、无权、旧版本、冲突和重载反馈。修复客户端关联请求漏传relationship_description，并新增严格绑定学生/关系ID、下一版本及结束时间的解除回执解析。
- `/tmp/access-trial-guardian-ui-browser3.log` **2/2**真实Next/Chrome+PG17通过：L1页面搜索→选择→关联→交接→确认解除→刷新，核对数据库与原回执；模拟服务器已保存但响应503，页面重试保留原幂等键；原主要联系人保留到明确解除。既有资料、文件、任务、邀请流程继续通过。
- `/tmp/access-trial-guardian-ui-mobile.png` 已查看，390px布局无横向溢出。首轮暴露旧selection-card样式隐藏radio，改成可点击原生单选；次轮明确下拉可访问名称，最终真实交互通过。
- `/tmp/access-trial-guardian-ui-unit-final.log` **24/24**：客户端、模块边界及UI边界。解除回执拒绝错误ID/版本/状态和额外私密字段；旧UI测试中已废弃的other_guardian/次要联系人及实现细节断言由当前边界检查与真实浏览器交互覆盖，未恢复过期词汇。旧客户端夹具补齐正式relationship_description字段。
- 类型 `/tmp/access-trial-guardian-ui-types-final2.log`、聚焦ESLint `/tmp/access-trial-guardian-ui-lint-final.log`、diff检查通过。无迁移。

新建家长并关联入口、其余CRM生命周期和其他模块、整体本地试用验收尚未完成；main合并和远程推送仍待整体验收。未部署或操作真实客户数据。

## 新建家长并关联服务端（2026-09-19，接续 359ba29）

总体仍 `in_progress`。按BR-024增加新建家长与非主要关系的原子入口；页面接入尚待下一步。

- 新POST `/api/v1/students/[studentId]/guardians/new`只接受家长最小资料及明确关系/职责，禁止客户端指定家长ID、主要联系人或身份字段；姓名、联系方式、生日、性别在服务层验证并规范化。复用关系创建的当前等级/分类重查、租户事务、审计/outbox及幂等；新家长默认不改变主要联系人。
- 新建前锁定规范化姓名/邮箱/电话查重范围，复用现有可见候选查询和签名确认token；发现重复且未确认时409，明确确认后新建独立家长，不自动匹配已有对象。同键重试排除服务器生成ID对请求哈希的影响，返回原关系回执。
- `/tmp/access-trial-new-guardian-final.log` **39/39**：真实PG17、关系仓储/路由与模块边界。新增四等级/分类允许拒绝矩阵、重复提交单份家长/审计、重复提示与明确确认、主要联系人保持唯一；注入审计失败后家长和关系一起回滚。
- `/tmp/access-trial-new-guardian-http.log` **2/2**：真实Next/Chrome+PG。L1正式HTTP新建201、同键原回执、未确认重复409、查重取得token后确认创建另一家长、无联系方式422、注入guardian_id400。既有关系页面、资料、文件、任务、邀请流程继续通过。新建入口自身此时是HTTP证据，不是新建表单验收。
- 新增路由字段边界契约 `/tmp/access-trial-new-guardian-contract-final.log` **7/7**；类型 `/tmp/access-trial-new-guardian-types-final2.log`、diff通过。聚焦ESLint `/tmp/access-trial-new-guardian-lint-final.log` 无错误，保留旧未使用参数警告1条。无迁移。

尚需新建家长表单与重复确认交互、其余CRM生命周期和其他模块、整体试用验收；main合并/推送未完成。未部署、未外发通知或使用真实客户资料。

## 新建家长表单与重复确认（2026-09-19，接续 1361eb0）

总体仍 `in_progress`。正式家长管理页面接入新建并关联入口。

- 表单收集最小资料、可选生日/性别及独立关系职责；保存前查询疑似重复，要求员工明确确认创建另一人，不自动匹配或合并。主要联系人不变。请求失败保留原提交内容及幂等键；权限拒绝交由父页面清空受保护内容。
- `/tmp/access-trial-new-guardian-ui-browser.log` **2/2**：真实Next/Chrome与PG17，页面填写并新建、成功刷新、再次填写触发重复警告、未确认时禁止提交、明确确认后创建独立家长。保留正式HTTP重放与非法字段/联系方式校验，以及既有关联/交接/解除流程。新建表单自身未单独注入丢失响应场景，不将旧关联入口的失败重试证据替代此项。
- `/tmp/access-trial-new-guardian-ui-mobile.png` 已查看，390px布局无横向溢出。`/tmp/access-trial-new-guardian-ui-unit-final.log` **25/25**，覆盖客户端严格回执解析及模块/UI边界。类型 `/tmp/access-trial-new-guardian-ui-types-final.log`、聚焦ESLint `/tmp/access-trial-new-guardian-ui-lint.log` 无错误。无迁移。

其余CRM生命周期、其他模块及整体试用验收仍需继续；main合并和远程推送未完成，未部署或使用真实客户资料。

## 客户软删除试用权限与正式接口修复（2026-09-19，接续 da60cef）

总体仍 `in_progress`。本节适配服务端删除申请/审批和待审批读取，不新增删除审批按钮。

- CRM仓储事务内重查当前试用成员、实际角色及分类；Founder/L1可申请和审批，L2仅对可见关联资料申请，L3拒绝，L2不得读取审批队列或作决定。新等级不使用旧Advisor责任关系扩权；无当前可见关系的家长不通过历史关系取得L2权限。停用后的旧决定回执也重新授权。
- 未结案学生、有当前关系的家长继续阻止删除；已删除资料不返回旧申请回执。申请、驳回、批准保留软删除与审计/outbox，不执行物理删除或恢复。
- 真实PG暴露并修复原有三个缺陷：事件额外字段违反数据库允许名单（类型/决定仍由事件类型、resourceType、action等正式信封字段表达）；审批CASE表达式缺少timestamp/UUID类型转换；连续驳回再申请时事务起点早于旧updated_at。数据库写入使用statement_timestamp及已存在时间下界，未放宽约束。
- 待审批页面客户端原先拒绝服务端request_id字段，现按正式七字段契约解析并绑定编号与资料类型/ID；不放宽任意额外字段读取。
- 新真实PG矩阵覆盖四等级、分类内外/未知分类及历史Advisor；Founder/L1申请→驳回→重新申请→批准、同键重试单份审计/outbox，注入审计失败后状态回滚，L1停用后拒绝旧命令/队列。正式HTTP覆盖L1同一流程及原回执，浏览器验证待审批队列载入、刷新和批准后消失。
- 审批操作目前仍是HTTP验证；页面只有待审批列表，审批按钮尚未接入。`/tmp/access-trial-deletion-queue-mobile.png`已查看，390px可见且无横向溢出。
- `/tmp/access-trial-deletion-browser2.log`真实PG+Next/Chrome子测试 **2/2** 通过（该批整组51/52，唯一失败为旧客户端学生详情夹具遗漏已确认gender/家长生日字段）；修正夹具后 `/tmp/access-trial-deletion-unit-final.log` **56/56** 通过。旧关系页面结构断言同步到当前能力和active状态检查，未恢复过期实现。
- 类型 `/tmp/access-trial-deletion-types-final3.log`、聚焦ESLint `/tmp/access-trial-deletion-lint-final2.log`及 `/tmp/access-trial-deletion-last-tests-lint.log`、diff检查通过。无迁移。中间一次独立PG批次在既有case_flow_foundation的background_blocker_rejections失败；最终浏览器批次包含同一检查且通过，未修改该检查或对应业务规则。

下一步仍须接入审批页面、完成其余模块与整体试用验收。main合并/远程推送未完成；未部署、未发送外部邮件、未迁移真实员工。

## 待删除审批页面（2026-09-19，接续 c5f0501）

总体仍 `in_progress`。待审批清单接通正式批准/驳回命令，沿用当前能力与服务器重查。

- 每项明确选择批准或驳回，再勾选确认；批准说明业务资料隐藏、历史保留且本期不可恢复，驳回说明恢复正常使用。审批时锁定其他行和分类筛选。页面移除无需用户理解的内部UUID/版本显示。
- 未知处理结果保留原决定和幂等键，只允许重试原决定；成功后重新读取清单。冲突/资料不存在要求重新载入；权限或登录失效清空受保护列表。客户端在发送前绑定请求编号与资料类型/ID，并严格校验返回资料、状态、下一版本和时间。
- 真实Next/Chrome+PG17流程覆盖页面驳回、批准前确认、服务端已成功但响应503后的同键重试、其他审阅者先处理后的冲突与刷新，以及模拟403后清空列表（服务端真实停用重查证据见上一节）。批准后刷新不再显示，数据库保持软删除。
- `/tmp/access-trial-decision-confirm-mobile.png` 已查看，390px确认文案及按钮显示完整。首轮浏览器流程通过后补充异常状态；一次补充测试因下拉标签定位超时，改用页面唯一combobox的可访问角色后通过相关步骤，未改变业务逻辑绕过验证。
- `/tmp/access-trial-decision-ui-final2.log` **32/32**：真实PG17/Next/Chrome、客户端与UI契约、模块边界全部通过；类型 `/tmp/access-trial-decision-ui-types-final3.log`、聚焦ESLint `/tmp/access-trial-decision-ui-lint-final2.log`及diff检查通过。无新迁移。

尚需客户来源、学校及其他入口的权限适配/复核、合成试用场景及整体本地验收；main合并与远程推送仍未完成。未部署或操作真实员工/客户数据。

## 客户来源目录与案件关联的试用权限（2026-09-19，接续 ef9673e）

总体仍 `in_progress`。本节适配来源服务端，未修改来源页面。

- 目录事务内加载当前试用成员并核对真实角色。Founder/L1维护目录；L2只能读取启用来源，过滤同时落实到服务与仓储，L3拒绝。停用试用成员不得退回历史角色；旧账号保持原规则。
- 案件来源读取/关联按当前等级、分类及案件分类过滤：Founder/L1处理明确分类案件，L2仅授权分类，L3拒绝，未知分类默认拒绝。写入及原幂等回执返回前均重查当前权限，保留Case状态、来源启用、并发版本及历史关系约束。
- `/tmp/access-trial-referral-final.log` **29/29**：真实PG17、目录与关联服务/仓储单测、模块边界。新增四等级/两分类/未知分类和历史Advisor矩阵；目录新建/修改/停用、关联与替换历史、重复提交单份审计、L1停用及L2分类撤销后拒绝旧请求。L2不能通过inactive筛选或直接ID读取停用来源，仍可在有权案件历史中看到已有来源关联。
- 正式HTTP新增L1新建→修改→案件关联→来源停用及原回执验证，停用后案件关联保留。来源自身的页面操作仍需验收，不能以HTTP证据替代。
- `/tmp/access-trial-referral-browser.log` **29/29**通过，包含真实Next/Chrome+PG及上项正式HTTP；既有删除审批、家长、文件、任务、邀请流程继续通过。类型 `/tmp/access-trial-referral-types-final.log`、diff通过；聚焦ESLint `/tmp/access-trial-referral-lint-final.log`无错误，保留既有未使用ReferralSourceCursor警告1条。无迁移。

来源页面、学校等其余入口和整体试用验收仍需完成；main合并/远程推送未完成。未部署或操作真实客户/员工数据。
