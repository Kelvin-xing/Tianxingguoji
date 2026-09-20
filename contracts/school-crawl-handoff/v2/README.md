# school-crawl-handoff 2.0：单校抓取结果契约

状态：本实施票冻结的数据契约。依据 BR-051 `BR-BASELINE-20260920-v56`「学校字段 V1」及 D4/N2；对照 SCH-INT-01 §8.3 / §11 和 SCH-INT-05 §2 / §3。这里不继承 SCH-INT-02/03 的存储设计。

## 包与版本

- UTF-8 JSON，一个文件只表达一次任务的一所学校；`schema=school-crawl-handoff`、`schema_version=2.0`、`package_type=single-school`。不是旧 `crawler-handoff/v1`，不能只换版本标签搬运旧批次。
- `contract.schema.json` 定义全部结构、字段与类型；下述语义规则同为规范。两侧离线校验器先验结构，结构通过再验语义；普通 JSON Schema 工具只验结构不足以验收。
- 属性一律显式提供，不认识的属性拒绝；禁止省略字段来暗示“沿用”或“删除”。以后增删字段、改变可接受集合或解释，必须新增契约版本，旧 `2.0` 不静默变义。
- 本票只提供离线 Python/TypeScript 验证器，不改现有爬虫产出/发布，不接 Schools 运行时。包是观察/候选，永远不是启用指令。

## 顶层与身份

| 路径 | 定义 |
| --- | --- |
| `run.crawl_id` | 一次抓取的唯一标识；传输重试沿用，新的抓取必须换新值 |
| `run.task_id` | 调用方任务标识，仅回传，不声明调用者权限 |
| `run.source_config_version` | 调用时的来源配置版本字符串；不指定版本如何存储、不代表来源获批 |
| `run.started_at / checked_at` | 开始/结束检查时间，UTC 秒 `YYYY-MM-DDTHH:mm:ssZ`，开始不得晚于结束 |
| `school.internal_school_id` | Tianxingguoji 提供的稳定内部编号，爬虫原样回传；首次未绑定为 `null`，不由爬虫生成 |
| `school.edb_school_number` | 六位 ASCII 数字字符串，保留前导零；EDB `scrn` 前六位，决定学校对象边界 |
| `school.crawler_source_id` | 爬虫源记录/目标的稳定定位标识，不替代任何上述编号 |
| `school.identity_evidence` | 身份来源证据；非全失败包至少一条。全失败可为空，不伪造抓到的数据 |
| `school.campus_variants` | 同校 EDB 行属性组合：完整十二位 `edb_scrn`、校址标识、地址、授课时间、学段。每行附逐字段观察；scrn 不重复且前六位必须与本校编号相同；校址标识已知时等于 scrn 第 7–10 位 |
| `admissions` | 本次取得的招生观察数组；空数组仅表示本次未取得记录，绝不表示删光既有招生 |
| `raw_records` | 本包内保留的原始文本/JSON 或 PDF 提取文本，按 `id` 引用；`content` 不得只剩摘要，`media_type` 描述所保留内容的类型 |

两种编号都已知时是**待核对的对应声明**，不意味着验证器已确认内部学校和 EDB 编号的真实绑定。已有人工学校的 EDB 尚未知时允许 `edb_school_number=null`、内部编号已知、校址变体为空；不伪造 EDB。两者不能同时未知。首次 EDB 发现允许内部编号为空，不影响系统后续生成稳定内部编号。

相同 EDB 六位编号的多个校址、上午/下午校、小学/中学都归于这一个 `school`。不同 EDB 编号不得因名称、机构或网址相同合并。`attributes` 中多值数组是学校层的属性集合，`campus_variants` 保留每条 EDB 行的地址/时段/学段对应，避免只留第一条或制造不存在的组合。建筑单元标识是属性，不是学校内部编号。

原始材料在此只定数据形状，不定存储位置/永久保留实现；PDF 原始二进制归档和传输清单/hash 属后续传输接入。源页面真实性、身份绑定、来源配置版本是否存在/获批、任务对应与原始材料完整性需 Stage B 核对。

## 逐字段观察

所有学校属性、校址行属性、招生字段（含三个身份分量）均用：

```json
{
  "state": "known",
  "value": false,
  "reason": null,
  "checked_at": "2026-09-20T02:00:00Z",
  "evidence": [{
    "source_url": "https://school.example/admissions",
    "raw_record_id": "raw-1",
    "text_quote": "合成材料：不提供住宿。",
    "locator": "第 3 段",
    "extraction_method": "synthetic-fixture",
    "confidence": 1,
    "collected_at": "2026-09-19T02:00:00Z"
  }]
}
```

| state | value / reason / evidence | 含义 |
| --- | --- | --- |
| `known` | 类型正确且非空，reason 为 null，至少一条证据 | 来源明确支持的值；`false` 是真实的“否”，不等同于未知 |
| `unknown` | value 为 null，reason 非空，evidence 可空 | 未提供、尚不能解析或无法确定；理由必须说明哪一种，不推断年份/住宿/全年招生 |
| `failed` | value 为 null，reason 非空，evidence 可空 | 请求/解析失败，本次未取得；无文档时不伪造证据，run.failure 提供失败来源 URLs |

空字符串、空数组不能作为已知业务值；需要空值时用未知并说明原因。字段的 `checked_at` 必须等于本次结束检查时间，证据 `collected_at` 可以来自过去但不得晚于本次检查。引用的 raw id 必须在本包存在，且来源 URL 和采集时间一致；历史证据被沿用时必须保留原采集时间，不能刷新成检查时间。一个字段可有多来源证据。采集时间、业务发布日期、申请日期分别表达。

`text_quote` 是原材料摘录，`locator` 是段落/页码/JSON 路径等定位；confidence 为 0–1 数值，不接受布尔值，不具有业务授权效力。包内可表达未知、失败和旧证据，均不能用来清空系统旧值。结构校验不证明摘录真实或足以支持所填事实。

## 学校字段 V1 映射

学校字段位于 `school.attributes`，全部必须出现；不支持/未取得的字段也要明确标成 unknown/failed。

| BR-051 字段 | 契约键 / 已知值类型 |
| --- | --- |
| 内部编号、EDB 编号、爬虫来源编号 | `school.internal_school_id / edb_school_number / crawler_source_id`（身份信封） |
| 注册编号、校址标识 | `registration_numbers / campus_identifiers`，非空字符串集合；行内标识另见 campus_variants |
| 中文、英文名称 | `name_zh / name_en`，字符串 |
| 官网、学校资料页 | `website_urls / profile_urls`，HTTP(S) URL 集合 |
| 学段、地区、地址 | `school_levels / districts / addresses`，字符串集合 |
| 电话、传真 | `phones / faxes`，字符串集合 |
| 学生性别类别、授课时间、资助类别 | `gender_categories / sessions / funding_categories`，字符串集合 |
| 特殊教育标记 | `special_education`，布尔值 |
| 学费说明、适用学年、来源 | `tuition_description` 字符串、`tuition_academic_year` 学年、`tuition_source_urls` URL 集合 |
| 住宿、住宿说明 | `boarding` 布尔值、`boarding_description` 字符串 |

本契约接收的是抓取观察，不是建档请求；校名未取得也可交付失败/未知观察。最低建档要求“至少一个中英文名称”仍由后续建档/启用环节执行，包通过不代表具备建档或启用资格。

## 招生字段与 N2

每条招生观察：`candidate_id` 是包内唯一定位符，其外部定位必须加上 `crawl_id`；不是数据库招生编号。`identity_mode` 为 `exact` 或 `new-candidate`。`fields` 必须包含：

| 字段 | 已知值格式 |
| --- | --- |
| `academic_year` | `YYYY/YY`，后两位必须是下一年的后两位；未知不按抓取年推断 |
| `admission_type` | 稳定、小写 ASCII token（例如 `general`、`transfer`），不混用同义词作为不同类别；这是传输表示，不批准新的业务类别/启用规则 |
| `grade` | 非空、无重复的年级集合；小学 P1–P6、中学 S1–S6，国际级别 G1–G13；无法可靠映射则 unknown 并保留原文，不自行把 G7 等同于 S1 |
| `published_date` | 信息发布日期，确切公历 `YYYY-MM-DD` |
| `application_open / application_deadline` | 申请开始/截止日期，确切公历日期 |
| `application_period / application_method` | 申请时段说明/方式，字符串；模糊日期放说明，不伪造精确日期 |
| `required_materials` | 所需材料字符串数组 |
| `application_form_urls / admission_page_urls` | 表单/招生页 URL 数组，不能与官网或学校资料页混用 |
| `exam_dates / interview_dates / second_interview_dates / result_dates` | 考试/面试/二面/结果日期数组，确切公历日期 |

同一学校内三个身份字段都 known 时，`identity_mode=exact`，比较三项 value；grade 比较集合（顺序不同仍相同）。同包重复的三元组拒绝为 `MATCH_KEY_DUPLICATE`，生产者必须先合成同一观察而非任取第一条。跨抓取同三元组对应同一招生记录，但本票不写更新逻辑。年级组 `[S2,S3,S4,S5]` 是一条适用于这些年级的招生记录；不等于四条单年级记录。地址、上午下午、页面 URL、candidate_id 都不是第四个身份条件；相关文本/差异保留字段证据，不能偷偷扩充 N2。

任何一个分量未确定则 `identity_mode=new-candidate`；不把未知等同于已知相同。特别是未知学年每次抓取都有新的 `(crawl_id,candidate_id)` 候选，不能更新旧未知候选，也不能从重复 URL 推导合并；未知年级同样不自动合并。类型未知也无法证明“三项全同”，因此保守地只交付候选，不新增业务启用资格。重复交付同一 crawl 不是新抓取；幂等处理留给后续接入。

## 抓取结果和无变化

| `run.change_status` | 约束与语义 |
| --- | --- |
| `changed` | 生产者声明有新的候选内容；可有 unknown，不可有 failed 字段 |
| `partial` | 部分取得，至少一个 known、一个 failed；必须有 failure |
| `failed` | 全失败；学校/校址字段全为 failed、admissions 为空；必须有 failure；允许保留带原时间的身份证据 |
| `unchanged` | 本次检查相对某个以前的抓取结果，业务值和招生键无变化；必须指明 comparison，不能含 failed 或新建候选模式 |

`failure={code,message,source_urls}` 是抓取诊断；changed/unchanged 的 failure 必须为 null。`comparison` 为 null 或 `{previous_crawl_id,basis:"business-values-and-admission-keys"}`，不得引用自己。它只引用历史**抓取结果**，绝不是“当前指针”、数据库 base_kind 或业务生效版本。无变化包仍交付已检查的观察及原证据，不用空包或 `null` 暗指旧值；只是证据刷新不等于业务值变化。未知学年每次产生候选，所以即便网页没变，也不能把含该新候选的包声明为 unchanged。

本地单包验证器无法证明两次内容真的相同，Stage B 需加载指定历史结果核对这项声明。抓取结果与业务当前有效资料可能不同，抓取“无变化”也不等于所有候选已被用户启用。

## 校验协议与复现

输出 JSONL：`{sample,valid,errors:[{path,code}]}`；错误按 JSONPath、code 的 Unicode 码点顺序排序。结构失败只报结构错误，避免后续语义访问损坏输入。有效退出 0，存在非法输入退出 1，缺参数退出 2。文件不可读属于工具 I/O 失败，不伪装为包校验结果。

零第三方运行依赖：Python 3.9+ 标准库、支持原生 TypeScript 类型擦除的 Node 22.18+。两侧只实现本 schema 使用的明确关键字（type/const/enum/required/additionalProperties/items/minItems/uniqueItems/minLength/pattern/format/minimum/maximum/本地 $ref），不是通用 JSON Schema 引擎。三个自定义 format 是 `utc-second`、`calendar-date`、`academic-year`；日期有效性两边实际校验。JSON 重复键、NaN/Infinity、溢出非有限数、孤立代理码点和超过 64 层嵌套统一报 `JSON_INVALID`；不纠正/强制转换输入。

在 Tianxingguoji 根目录：

```sh
node scripts/test-school-handoff-v2.ts /absolute/path/to/school-tracker/hk-school-platform
```

runner 先验证 schema、cases.json 和全部样本副本逐字节相同，再把 **Tianxingguoji 下同一组文件绝对路径** 分别交给 Python CLI 和 TypeScript CLI；各自输出都必须等于手写 `cases.json` 预期，并彼此完全一致。合法样本必须通过，非法样本必须按指定路径/错误码拒绝，不能只让“两边一起出错”也算通过。单独验证：

```sh
python3 /path/to/school-tracker/hk-school-platform/tools/validate_school_handoff_v2.py contracts/school-crawl-handoff/v2/sample-composite.json
node scripts/validate-school-handoff-v2.ts contracts/school-crawl-handoff/v2/sample-composite.json
```

错误代码及定位的固定反例在 `cases.json`；业务原因按字段状态、D4/N2、run 规则解释。校验不写文件、不联网、不入库。

## 样本来源与覆盖

**全部是假数据，不能导入真实目录。** 名称、900001/900002、地址、日期、URL、证据、内部编号均为虚构。只借鉴 SCH-INT-05 已描述的形态，没有复制或冒充真实抓取：

| 形态 / 依据 | 样本 |
| --- | --- |
| 同编号多校址、多时段（§2.1，英華女學校/聖迦利亞書院样式），小学中学同校（§2.4，培僑書院样式） | `sample-composite.json` |
| 同页多学年、多类型、多年级并存（§3.2） | 同上：5 条招生；每个分量单独不同的情形都覆盖 |
| 学年证据不足（§3.3）及连续两次抓取 | `sample-unknown-year.json`、`sample-unknown-year-repeat.json`；可重复 local id，但 crawl id 不同 |
| 年级/类型未知保护 | `sample-unknown-components.json` |
| 首次 EDB 发现；已有人工记录尚缺 EDB | `sample-unbound-edb.json`、`sample-unknown-edb.json` |
| 全失败；部分失败 | `sample-failed.json`、`sample-partial.json` |
| 无变化、保留旧采集时间 | `sample-unchanged.json` |
| 同名不同 EDB 不合并（§2.2 的边界） | `sample-same-name-other-school.json` |
| 同三元组换网址不改变身份（§3.1/3.2） | `sample-known-key-new-url.json` 与 composite；非法样本额外验证不同 URL 的重复键仍拒绝 |

41 个非法样本覆盖版本/类型/额外或缺失字段、混校、未知匹配、重复身份与年级顺序、证据缺失/引用、false 与未知、非法日期、失败/无变化矛盾及跨语言 JSON 边界。

版本号、任务/来源配置和抓取观察由包提供；实际发起人、启用人、启用时间、业务版本、变更前后值及恢复/人工补充履历由 Tianxingguoji 后续业务行为生成，不由爬虫自报。本票未冻结业务 API、候选存储、来源关联表、双基线、当前指针、手工合并或授权流程。
