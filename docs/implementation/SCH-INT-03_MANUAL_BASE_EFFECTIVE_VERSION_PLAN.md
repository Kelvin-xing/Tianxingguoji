# SCH-INT-03 无爬虫快照学校的有效版本补充设计

状态：`proposed`，等待项目负责人审阅，尚未批准实施。

| 控制项 | 内容 |
| --- | --- |
| 日期 / Owner | 2026-09-20 / architect |
| 核实基线 | `d9435d64c15169ed037fa17aa656a2d4a679ac37`；开始时工作区干净 |
| 业务依据 | [BR-051](../../../txgj-doc/business-requirements/50-schools.zh-CN.md)、[BR-033](../../../txgj-doc/business-requirements/30-cases.zh-CN.md)、[BR-070/071](../../../txgj-doc/business-requirements/70-notifications-audit.zh-CN.md)；当前需求索引 v54 |
| 补充对象 | [SCH-INT-01](SCH-INT-01_CRAWLER_INTEGRATION_PLAN.md) 的读取空白、[SCH-INT-02 §5.2](SCH-INT-02_MANUAL_SCHOOL_CRAWLER_LINK_PLAN.md#52-无快照学校的有效资料与读取) 的互斥基线方向；不修改两份原文 |
| 本票范围 | 无快照 School 的有效资料与固定版本读取设计；只新增本文并独立分支提交推送 |

## 1. 独立核实结果

背景第 1 点需限定措辞：SCH-INT-01 确为 `draft_for_review`、v53；§9/§10 没有无爬虫快照学校的有效版本方案。但其最低建档规则允许资料暂缺，§10 也写了“无来源时提示提交来源审批”，不能据此说它完全排除了无来源学校。准确缺口是：没有定义人工初始有效版本、无快照的读取分支及随后固定版本引用。

背景第 2 点准确：SCH-INT-02 为 `proposed`，§5.2 明确提出人工/爬虫互斥基线，同时保留单校版本契约待补齐。背景第 3 点在本次阅读范围内成立：未发现两文在稳定身份、启用分离、不可变履历及来源审批上真正矛盾。两文都是审阅稿，原则依据仍是 confirmed BR，不能把技术建议当作已批准实施。

具体依赖不仅是一个非空字段：

| 位置（当前源码） | 具体依赖与影响 |
| --- | --- |
| [迁移 004](../../db/migrations/202608022030_004_expand_school_overlay.sql)：`schools_overlay_revisions`、`schools_resolved_revisions` | 第 83、247 行均为 `base_snapshot_id uuid NOT NULL`，各有到 snapshots 的组织范围外键；resolved 本身按 `(id, organization_id, school_id)` 被 Cases 引用。单纯创建 provisional 不能插入合法人工 resolved |
| [迁移 070](../../db/migrations/202609190130_070_expand_provisional_school_intake.sql)；[建档 repository](../../modules/schools/infrastructure/postgresql-provisional-repository.ts) | 人工原记录固定版本 1，拒绝 UPDATE/DELETE/TRUNCATE；建档只插入 School 与 provisional，没有有效版本。保留此事实，不通过修改原表补救 |
| [resolved transaction](../../modules/schools/infrastructure/postgresql-resolved-view-transaction.ts)：`readSources`、`appendResolvedRevision` | 第 146–164 行内连接活动 snapshot 与本校 record；无记录则详情抛 `SCHOOL_RESOLUTION_NOT_FOUND`，目录不包含该校。写 resolved 及幂等重读也要求 snapshot ID |
| [directory repository](../../modules/schools/infrastructure/postgresql-directory-repository.ts)：`find`、`listProvisionals` | 详情在 resolved 后再次读取 snapshot record 生成基础字段 hash；人工列表是独立查询，不能代替有效版本详情 |
| [domain contract](../../modules/schools/domain/contract.ts)、[resolver](../../modules/schools/domain/resolver.ts)、[pin 契约](../../modules/schools/application/resolved-view.ts) | base/pin 强制 snapshot ID、来源键；provenance 只有 crawler/approved overlay 且仍要求 snapshot。resolver 把基础字段标成爬虫来源，不能把人工数据直接塞入旧类型 |
| [change repository](../../modules/schools/infrastructure/postgresql-change-repository.ts)、[review repository](../../modules/schools/infrastructure/postgresql-review-repository.ts)、[迁移 072](../../db/migrations/202609190150_072_record_school_change_reviews.sql) | 提交、历史查询、审批及冲突检查连接 snapshot record；审批触发器禁止改原基线。后续迁移未解除非空依赖。只放宽详情，人工补充仍会卡住 |
| [options repository](../../modules/schools/infrastructure/postgresql-school-options-repository.ts)：`active_snapshot/current_overlay/selectable` | 固定版本必须属于活动 snapshot 并有 snapshot record、匹配当前 overlay 才进入选校查询；新增人工 resolved 行本身仍不足以被读到 |
| [Cases target repository](../../modules/cases/infrastructure/postgresql-school-target-repository.ts)：`toTargetItem` | 已固定版本读取仍要求主表 `source_school_key` 非空，否则 `SCHOOL_TARGET_RESOLUTION_INVALID`；即使人工版本有合法 ID/hash 也会失败 |
| [迁移 040](../../db/migrations/202608260040_040_expand_candidate_list_case_flow.sql)、[迁移 062](../../db/migrations/202609190050_062_fix_candidate_command_runtime.sql) 及迁移 004 的 target pin 校验 | Cases 主要引用 resolved ID、School、组织及 hash，并非直接引用 snapshot。可保留此引用边界；名单提交还验证截止日期等业务条件，不能因读取修复而绕过 |
| [详情 API](../../app/api/v1/schools/[schoolId]/resolved/route.ts)、[directory decoder](../../modules/schools/infrastructure/directory-client.ts)、[resolved decoder](../../modules/schools/infrastructure/resolved-client.ts)、[修改表单](../../components/schools/SchoolChangeForm.tsx) | API、严格解码及提交参数仍假定 snapshot 字符串；必须一起扩展，不能只改数据库 nullable |

以上为静态核实，未连接数据库或运行页面。既有 resolver 只选择最新一条 approved overlay 的局限是 SCH-INT-01 §8.2 已指出的旧实现差距，不是两份设计之间的矛盾；本稿不为人工学校复制这一局限。

## 2. 推荐设计：同一有效版本容器，两类明确基线

有效版本表示“系统当前可读取、可追溯的资料”，不表示资料已验证、来源获准抓取或学校获得新的选校资格。继续以 School UUID 为身份，以 `schools_resolved_revisions` 的 ID/hash 为对外固定引用，避免为人工学校另造一套 Cases 引用体系。

### 2.1 逻辑 schema 增量（仅建议，不含迁移或 DDL）

| 对象 | 建议调整与约束 |
| --- | --- |
| overlay 与 resolved | 引入 `base_kind`：`manual_intake` 或 `crawler_snapshot`。人工分支要求 `manual_base_school_id=school_id`、snapshot 为空；爬虫分支要求 snapshot 非空、人工引用为空。恰好一种基线，禁止两个都空/都有 |
| 人工基线引用 | 新列单列外键引用现有 provisional 的 `school_id` 主键，再以等值 CHECK 及已有 School/组织复合外键保证本校归属；读取重验组织。无需给 provisional 增列、索引或调整保护 |
| 爬虫基线引用 | 保留现有 snapshot 外键，并校验该 snapshot 中有本校记录；历史行保持 crawler 分支语义，不更换 ID、hash、字段或来源证据 |
| resolved 内容 | 保留完整 fields/provenance/conflicts；新格式另有 resolver/hash 格式版本、前一有效版本引用及产生本版本的建档/审批/启用/恢复履历引用。每个实际生效变化追加新版本，不更新旧行 |
| 当前版本投影 | 建议新增 `schools_current_resolutions`：组织、school_id、resolved_revision_id、预期版本号；一校最多一个当前指针，复合外键保证本组织本校，可由生效履历重建。指针推进与有效版本/必要审计同事务 |

保留 resolved 的不可变约束和 Cases pin 外键/hash 校验。后续如实施，只能追加纠正迁移以扩展其他表约束及相关触发器；**不修改 `schools_provisional_records` 及其不可变约束，也不改写历史迁移**。

`base_kind` 表示版本的基础记录类型，不表示所有字段只有同一种来源。人工基线上的后续版本可以包含经启用的爬虫字段，每个字段各自保留来源；不因第一次出现爬虫包就强制把整校基线切换成 crawler。

### 2.2 版本形成与后续变化

1. **初始人工版本 M1**：在成功建档事务中，从不可变 provisional 显式映射名称、地区、学制、学段等已有业务字段，生成持久化 resolved ID/hash 并设置当前指针；原因等治理说明留在建档履历。未知资料仍未知，保留未验证标记。此举物化已提交建档事实，不伪造 Founder 审批或爬虫启用。已有人工记录按 School ID 通过幂等初始化命令物化，同源重复调用返回同一版本；普通 GET 不隐式写入，未初始化明确返回版本未就绪。
2. **人工补充 M2**：仍提交 ChangeRequest，由既定审批流程批准后形成 overlay revision；基线指向人工记录，预期值另指向用户查看时的当前有效版本/字段 hash。从当前完整版本仅改变批准字段，保留其他已生效修订。驳回/待批不推进当前指针，不能依赖“最新一条 overlay 覆盖全部资料”。
3. **首次抓取**：来源关联和任务完全沿用 SCH-INT-02。结果包只进入候选；抓取完成、失败、无变化或来源获批均不切换 M2。用户启用所选有效字段后才生成 M3，未选/空值/人工冲突按 SCH-INT-01 保留，字段 provenance 指向真实任务/原记录及启用履历。M3 可继续以人工记录为根基线，避免整体套用候选数据。
4. **恢复/停用修订**：按已有授权与保护规则生成后继有效版本或回滚结果；只改变受影响字段，保留中间版本及原审批履历，禁止改写已固定的 M1/M2。并发变更要求重新查看确认，不静默覆盖。

新版本 hash 使用明确版本化的规范化内容，覆盖 School/组织、基线类型及引用、前序版本/生效依据、实际字段和逐字段来源。重复同一生效请求幂等；恢复到相同文字也仍可追溯新的操作和版本。旧 crawler hash 算法及既存 hash 不重算，按格式版本分别核验。

人工 provenance 明确包含建档记录、记录版本 1、创建人/时间；人工补充包含 overlay 与审批引用。人工记录没有采集时间，不能用创建时间伪装爬取时间；crawler 字段保留其真实采集时间。基线字段 hash 来自对应原始记录，effective hash 来自当前有效版本，未知使用统一空值表达，两者不可混用。

## 3. 现有读取路径如何接入

| 路径 | 设计行为 |
| --- | --- |
| 学校目录/详情 | 有新当前指针的学校按其 resolved 读取；manual 分支不连接活动 snapshot，基础 hash 从原建档记录取。四块详情展示当前资料、未知/未验证、待处理及履历；按 School UUID 去重，不把 provisional 和 M1 展示成两校 |
| 既有 crawler 学校 | 尚未采用新当前指针的旧学校继续现有 crawler 查询、resolver 和 hash 语义；不修改它们的基线/版本，不将读取失败静默降级成人工。新指针存在但损坏时明确失败，不能退回旧版本冒充当前 |
| Schools API / 页面 | 对 base 使用可辨别的两类引用，manual 的旧 snapshot/source key 字段为真实空值，不塞 UUID 或 `manual:` 假爬虫键。API、decoder、pin 类型、表单同时识别新格式；crawler 分支保留原值。严格旧客户端未适配前不向其返回新形状 |
| Cases 选校资料读取 | 从统一当前版本集合取得 school_id、名称、resolved ID/hash；按同一排序及游标规则分页。人工行不被 snapshot JOIN 过滤；可供查看的资料与是否允许提交选择分开判断 |
| Cases 固定版本读取 | 继续按本校 resolved ID/hash 读取当时 fields，名称从固定版本的中/英文名取得；来源键仅是旧 crawler 的兼容显示后备，不再作为人工版本完整性要求。禁止名称或 hash 回落到当前目录值 |

当前版本集合采用明确互斥选择：有新指针用新版本，无新指针的既有 crawler 用旧路径；不能对所有学校简单 UNION 后按时间取最新。后续第一次单校启用为旧 crawler 学校建立新指针时，应承接其当时有效资料并只追加批准变化，不切组织级 active snapshot，也不改变其他学校。

**Cases 的边界**：本设计交付可供该读取链路消费的技术有效版本和 pin，不以 M1 存在自动授予候选名单提交/申请资格。现有案件权限、名单审批、Guardian 确认、日期等校验继续执行；SCH-INT-02 的 D7 保持原状，不在此重开或决策。若现有已确认业务资格不足以允许该校被选中，可读取其资料及阻塞原因，提交仍保持阻塞；不能把“来源键为空”当作业务资格规则，也不能把去除技术空键检查解释为放行。此限制不是两份设计矛盾。

## 4. 设计校验与范围边界

后续实施审阅至少应验证：仅名称人工学校拥有稳定持久 pin 且详情可读；无 snapshot 的补充审批可形成新版本；重复初始化/审批及并发不重复生效；crawler 旧详情、options、hash 和历史 pin 不变；首次抓取未启用时当前版本不变，逐项启用后人工旧值/来源可追溯；来源键为空不破坏合法人工 pin 的读取；Cases 业务资格检查未被削弱；原始 provisional 仍固定版本 1 且不可修改/删除。

本票不重写 SCH-INT-01/02，不重新讨论 D1–D7，不设计批量导入、自动/定时抓取、学校验证状态转换、来源审批新权限或新的选校资格。不扩展门户白名单，不实现完整招生/抓取契约。无产品代码、SQL、迁移、测试或配置变更；不执行数据库、抓取、部署，不创建 PR 或合并 main。

## 5. 本票记录

- status：`proposed`，等待项目负责人审阅，尚未批准实施。
- changed：仅新增本文；授权交付为独立分支提交及推送。
- evidence：重新阅读 SCH-INT-01/02、当前 BR-051/033 及需求索引；静态核对迁移 004/040/062/070/072、overlay 提交/审批、resolved 生成/读取、目录详情、options、Cases pin 读取及 API/decoder；文档链接、空白及单文件差异检查。
- not_run：未执行测试、lint、build、数据库操作、浏览器、抓取或远程业务验证；文中行为均为建议，不是实现结果。
- risks：新旧 resolver/hash 格式、互斥基线约束、当前投影和 API 兼容需在实施前冻结并验证；技术有效版本不决定 D7。未发现两份既有设计真正矛盾，旧实现的 snapshot/最新 overlay 假设仍需相应改造，但本票不实施。
