# 真实抓取产物 → school-crawl-handoff 2.0：全量 fit/gap 报告

**结论：完整转换 0 所，部分转换 585 所，完全无法开展字段转换 0 所；可合法交接的完整包是 0 所。Python 与 TypeScript 对全部 585 个尝试包均拒绝，错误码与路径完全一致。**

这是失败暴露报告，不是接入验收通过报告。两个仓库的契约、校验器、爬虫及生产运行路径均未修改。建议部分仅供审阅，不代表已批准修改。

## 1. 统计口径先说明

- **完整转换**：可由已有证据构造合法 v2 包，而且没有未解决的事实/来源/招生归属问题。
- **部分转换**：能明确定位学校并保留一部分 V1 值/观察，但仍有缺失或矛盾，整包不能合法交接。本次 585 所均属此类；绝不是“585 个部分成功的可导入包”。
- **完全无法转换**：连学校边界和任何可用的学校字段投影都建立不了。本次 0 所。若按“能否生成可交接整包”来问，则 **585 所全部不可交接**。
- 问题类别按学校去重；同校可出现在多类，不可相加当成总学校数。主 final 学年/年级未确定的 485/497 所以 529 所有选定 URL 的学校为分母，另外 56 所单列 NO_FINAL_ADMISSION_URL；不把它们隐去或算作身份已知。校验错误发生次数与问题学校数分别列出。
- `known` 在失败尝试包中只表示“从旧产物复制/明确解析出的上游断言”，不代表已验证学校事实。全部包拒绝且只留在探索目录，不作为候选发布。

## 2. 实际数据与分母

| 数据 | 实际读取量 |
| --- | ---: |
| merged/final/records.json | 585 条，585 个唯一 school_key |
| 12 个批次 final | 11×50 + 35 = 585 条，与 merged key 集合相同、无跨批次重复 |
| school_registry.json | 585 个 key |
| EDB schools 工作表 | 632 数据行 × 30 列（不含表头） |
| 可核对的唯一 EDB 六位编号 | 585；其中 3 行编号单元格空，从详情 URL 恢复 |
| discovery/candidates.json | 1,801 条，所有 12 批次均扫描 |
| evidence/packs | 585 个，全量读取 |
| PDF 文本缓存 | 334 个，全部按抓取器的 URL SHA256 文件名规则对应回证据包 |
| 原始 JSON 文件 | 727 个（本次运行目录，不把 registry 加到此数） |
| 指纹清单 | 1,063 文件 = 727 JSON + registry + XLSX + 334 文本 |

全部 632 行均按 EDB 编号并入对应学校，没有只挑可转换学校。其他批次 XLSX 是相同 JSON 的导出，本次不重复作为新学校计数；未重新抓取网站。merged 与批次 final 的 585 条完整对象均不完全相同：差异来自 merged 追加的注册表/EDB/学费字段，逐字段差异保存在 `schools.jsonl.gz.batch_sources`，不能把它当作 585 次政策变动。12 批次是一次运行的分片，不是同一所学校的 12 次重抓，无法据此宣称“本次无变化”。

固定输入路径（相对 school-tracker/hk-school-platform）：

```text
apps/crawler/output/partitioned/full_20260610_130102_llm_p3/
apps/crawler/config/school_registry.json
apps/crawler/output/edb_schools_20260610_enriched.xlsx
```

两个仓库起点均已 `git pull --ff-only`，来自干净 main：Tianxingguoji `541e227cf0214b126d1e8415ec0971acefc54476`，school-tracker `a4de65b4d7cc4f8a0924689acc6f6a3d38c1132a`。本票分支均为 `codex/contract-fit-gap-real-data`。

## 3. 怎么转换，哪里明确没有替数据做决定

1. 学校编号优先核对明确 school_number 与 URL 的 scrn；不同编号不合并，同一编号保留所有 XLSX 明细行。只用 EDB 编号关联，不做模糊校名匹配。3 个 key 后缀差异可以恢复，因此没有把它们算成身份失败。
2. 学校字段逐一投影；多校址、地址、授课时间等保留数组与行级组合。字段无值按 v2 `unknown/value:null/reason` 表达；不补无住宿、不推断学年。容量字符串不自动等价于正在提供住宿。
3. final 的申请日期、材料等原值保留；日期数组只拆明确的 ` / ` 分隔，不修非法日期、不取第一个日期。单值日期槽遇到多日期，故意留下原字符串让原验证器报告格式不符。
4. 主 final 之外，明确表单标题、成功的招生 PDF 标题和符合条件的额外 discovery 页另保留来源观察。只解析标题/有限 PDF 头部中的完整四位学年、明确小学/中学年级以及插班等词。**25-26/26-27 不自行补世纪；“全年”“各级”不补默认值。** 不将整校 final 的截止日期分发到每一份表单。共得到 777 个来源观察，**不是 777 条已确立业务招生记录**。
5. 对 `run` 中无法确认的单校任务/来源配置/检查时间/结果状态留缺，不伪造 `changed` 或 `failed`；这些槽不支持未知，包必须失败。`internal_school_id:null` 是 v2 明确允许的未绑定状态，不伪造内部编号。局部 raw/candidate 定位编号由探索工具生成，仅为定位，不伪装成旧任务或业务编号。
6. 原 JSON/单元格/PDF 文本保留为 raw，来源路径和字段定位保留；`text_quote` 必须确实出现在保存的原材料中，工具实际做包含断言。它是**导出产物的片段**，不冒充已定位的网页逐字段证据。缺采集时间、数值 confidence、checked_at 就省略，留下原校验错误；不从文件名、工作簿日期、生成时间、discovered_at 推断这些时间。
7. 全量 JSON 键扫描：没有 `crawl_id/task_id/source_config_version/checked_at/collected_at/change_status`；数值 confidence 出现 0 次。存在的 `started_at` 4 次是整批工作流步骤，`generated_at` 558 次是产物/配置生成，`discovered_at` 1,801 次是发现候选时间；语义不能替换成所有字段的采集/检查时间。
8. 未单列的注册详情、招生线索、容量、评分等留在 raw 或 `raw_only_final_fields` 中；这是保留原材料，不记作已结构化成功。PDF 段落、两位年份、复杂英文年级和上下文语义不做穷尽抽取；下列“未确定”是本探索工具在已说明规则下的结果，不断言全网或整份原文不存在答案。

## 4. 全量分类与可自行核对的例子

学校数可重叠。“已恢复/额外保留”是 fit；“诊断信号”需要人工复核；真正的包拒绝见第 6 节。自动类别不冒充人工事实结论。

| 类别 | 性质 / 具体问题 | 学校数 | 真实例子（名称 / EDB） |
| --- | --- | ---: | --- |
| `ADDITIONAL_DISCOVERY_OBSERVATION` | 额外保留：未选定但标记招生且标题有明确身份线索的发现页 | 25 | 藝術與科技教育中心 / 511072；中華基督教會方潤華中學 / 545228；中聖書院 / 134333 |
| `ADMISSION_FIELD_PROVENANCE_UNSCOPED` | 来源精度不足：final 单 URL/摘要不等于逐字段网页证据 | 529 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `ADMISSION_GRADE_UNRESOLVED` | 转换边界 / 不猜测：主 final 的标题/选中 PDF 不能按本工具规则明确年级 | 497 | 香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385；博愛醫院歷屆總理聯誼會梁省德中學 / 230910 |
| `ADMISSION_YEAR_UNRESOLVED` | 转换边界 / 不猜测：主 final 的标题/选中 PDF 不能按本工具规则明确学年 | 485 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `BOARDING_CAPACITY_NOT_BOOLEAN` | 含义不相同：dormitory_info 是课室/容量/注册说明，不能直接变为住宿布尔值 | 585 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `CROSS_LEVEL_TUITION_EVIDENCE` | 可保留 / 仍缺元数据：学费文本同时明确小学和中学课程 | 10 | 基督教香港信義會宏信書院 / 579530；播道書院 / 567337；培生學校 / 581259 |
| `DUPLICATE_EXACT_OBSERVATIONS_REQUIRE_RECONCILIATION` | 契约候选归并边界：多个来源观察得到同一三元组；未任取一个吞掉其他来源 | 5 | 五邑司徒浩中學 / 215040；鳳溪廖萬石堂中學 / 518379；九龍三育中學 / 131814 |
| `EDB_COLLECTED_AT_MISSING` | 契约必填 / 旧产物缺失：EDB 属性缺真实采集时间 | 585 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `EDB_NUMBER_CELL_MISSING_RECOVERED` | 已恢复 / 非未映射：工作簿 E 列空，从 P 列明确 scrn 恢复编号 | 3 | 旅港開平商會中學 / 170607；嘉諾撒聖家書院 / 170569；寶血會上智英文書院 / 213845 |
| `EMPTY_PDF_TEXT_RETAINED` | 原始失败材料表达：空 PDF 提取文本不能装进 minLength=1 的 raw.content | 16 | 佛教沈香林紀念中學 / 230782；宣道中學 / 311103；基督教中國佈道會聖道學校 / 250449 |
| `EVIDENCE_NUMERIC_CONFIDENCE_MISSING` | 契约必填 / 旧产物缺失：上游置信度是类别，不是数值 | 585 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `FORM_LABEL_PDF_YEAR_CONFLICT` | 真实来源冲突：表单标签学年与 PDF 正文招生标题不一致 | 1 | 香港仔浸信會呂明才書院 / 214485 |
| `FORM_SCOPE_NOT_LINKED_TO_FINAL_FIELDS` | 粒度 / 归属缺失：表单中有招生身份线索，但没有字段到该表单招生的对应 | 74 | 香港仔浸信會呂明才書院 / 214485；佛教筏可紀念中學 / 190128；佛教何南金中學 / 270172 |
| `INVALID_CALENDAR_DATE` | 旧数据错误：保留无效日期原值供原校验器拒绝 | 3 | 中華基督教會全完中學 / 113840；聖公會李炳中學 / 230871；香港真光中學 / 623857 |
| `MATERIALS_NON_APPLICATION_TEXT_SIGNAL` | 疑似污染 / 待人工核对：材料字段命中毕业礼/开放日等关键词；不是人工判定全部污染 | 4 | 迦密主恩中學 / 190560；匡智屯門晨曦學校 / 250651；匡智松嶺第三校 / 250414 |
| `MULTI_EDB_ROWS_RECOVERED` | 已恢复 / 可表达：同编号多行保留为一校多校址/时段属性 | 24 | 遵理學校 / 289094；遵理學校（旺角） / 524867；明愛陳震夏郊野學園 / 519162 |
| `NO_FINAL_ADMISSION_URL` | 旧产物缺失：没有 final 选定 URL；不等于学校不招生 | 56 | 遵理學校 / 289094；遵理學校（旺角） / 524867；明愛柴灣馬登基金中學 / 270040 |
| `REGISTRY_KEY_MISMATCH_RECOVERED` | 已恢复 / 非未映射：final key 与 registry key 不同，经明确 EDB URL 对上 | 3 | 旅港開平商會中學 / 170607；嘉諾撒聖家書院 / 170569；寶血會上智英文書院 / 213845 |
| `ROLLING_ADMISSION_NO_ASSUMED_YEAR` | 未知表达：选定页面有全年/rolling 信号，不据此填当年 | 11 | 協同國際學校 / 215996；炮台山循道衛理中學 / 516961；東莞工商總會劉百樂中學 / 190519 |
| `RUN_METADATA_MISSING` | 契约必填 / 旧产物缺失：没有单校任务/配置版本/检查时间/结果状态 | 585 | 香港仔浸信會呂明才書院 / 214485；香港仔工業學校 / 511102；孔聖堂禮仁書院 / 131385 |
| `SCALAR_DATE_MULTIPLE_VALUES` | 粒度 / 类型冲突：多个日期串占用一个申请起止/发布日期标量 | 34 | 庇理羅士女子中學 / 510378；何明華會督銀禧中學 / 170100；迦密中學 / 135968 |
| `SELECTED_PAGE_MARKED_NON_ADMISSION` | 上游诊断信号：选定页面在 discovery 中被标 is_admission_page=false | 160 | 泰來書院 / 612820；神召會夜中學 / 226653；神召會康樂夜中學 / 526720 |
| `SELECTED_URL_DISCOVERY_LINK_UNRESOLVED` | 证据关联不唯一：选定 URL 未唯一对应一条 discovery 候选 | 60 | AMERICAN SCHOOL HONG KONG[WHOLE DAY] / 603902；香港澳洲國際學校 / 216275；伯特利中學 / 511170 |
| `SELECTED_URL_OTHER_HOST_REVIEW` | 疑似错源 / 待核对：选定页面与学校网址主机不同；不一概认定非法来源 | 66 | 孔聖堂禮仁書院 / 131385；泰來書院 / 612820；神召會夜中學 / 226653 |
| `SOURCE_FETCH_OR_PDF_FAILURE` | 源请求失败：至少一条 discovery/PDF 有错误或非 ok；不等于整校失败 | 139 | 泰來書院 / 612820；神召會夜中學 / 226653；神召會康樂中學 / 212318 |
| `SUSPECT_FUTURE_DATE` | 语义质量 / 格式未必拒绝：2030 年后的日期值；阈值只用于本次诊断，不改契约 | 1 | 宣道中學 / 311103 |

每类至少 3 个例子（不足 3 所则全部）的原值、路径和摘录在 `gap-categories.json`；每所学校的全部类别与详情在 `schools.jsonl.gz`，并非只保留这张表中的例子。

### 关键实例的原始定位

| 学校 / EDB | 原值或证据 | 原位置与结论 |
| --- | --- | --- |
| 旅港開平商會中學 / 170607；嘉諾撒聖家書院 / 170569；寶血會上智英文書院 / 213845 | registry key 比 final 多 `_WHOLE_DAY`；EDB E 列空，P 列有完整 scrn | XLSX 第 417 / 415 / 416 行；三个身份均明确恢复，不是三所无法映射学校 |
| 英華女學校 / 511030 | 卑利士道 / 罗便臣道两个校址 | XLSX 18 / 19 行；同校保留两个 campus_variants |
| 聖迦利亞書院（九龍） / 577979 | 下午 / 上午 | XLSX 107 / 108 行；同编号不拆校 |
| 培僑書院 / 560553 | W222 同时出现小一 PRIMARY 1、中一 SECONDARY 1 | 同校多学段可表达；这个 final 没有选定招生 URL，不从学校课程反推招生记录 |
| 佛教大光慈航中學 / 190748 | `26-27 各級插班生_申請表`、`25-26 各級插班生_申請表` | merged index 28 的 application_form_links；拆来源观察保留原标题，年份不补世纪、各级不猜年级，学校级字段不强行分配 |
| 香港仔浸信會呂明才書院 / 214485 | 链接标题 `2025-2026 插班生詳程及表格_中二至中五`，对应 PDF 实际开头 `招收 2026-27 學年中二至中五級插班生` | merged index 0 与 batch001 evidence pack / PDF cache；同 URL 不是学年真值，冲突必须保留 |
| 香港紫荊書院 / 621374 | `香港紫荊書院現全年開放申請。` | merged index 227、batch001 discovery 对应 `/9月入學`；不按 2026 年抓取推定学年 |
| 中華基督教會全完中學 / 113840 | interview_date 含 `2025-11-39` | merged index 60，真实无效公历日期，不改成 11/30 |
| 聖公會李炳中學 / 230871 | exam_date 含 `2025-11-57` | merged index 447；原值保留，校验拒绝 |
| 香港真光中學 / 623857 | submission_deadline 为 `2026-04-00` | merged index 512；原值保留，校验拒绝 |
| 宣道中學 / 311103 | `2080-07-02`、结果日期有 `2080-07-14` 等 | 公历格式可以合法，语义可疑；契约格式校验不是招生质量审核 |
| 泰來書院 / 612820 | final_admission_url 为 `https://www.w3.org/WAI/WCAG2AA-Conformance` | final 选到了可访问的 HTTP URL，但不是学校招生内容；URL 格式正确不等于来源正确 |
| 道慈佛社楊日霖紀念學校 / 250520 | 学校域名 yyl.edu.hk，选定 bckps.edu.hk 页面标题是“插班生申請 – 佛教慈敬學校” | batch001 discovery；具体错校风险，不能因为 EDB 编号正确就信任招生来源 |
| 匡智松嶺第三校 / 250414 | required_materials 中出现 `匡智會聯校畢業禮` | merged index 221；原字符串可放入材料数组，但含义不是申请清单，schema 不会自动识别 |

住宿字段有 585 个非空 legacy 字符串，其中 553 以“課室”开头，32 以“學校”开头；38 个字符串提到“宿舍”，也不直接证明当前是否对申请学生提供住宿。保留容量/注册原文，boarding 仍为未知，不以 false 凑齐。

## 5. 装得下的部分

- 585 个 EDB 身份可准确定位；多校址/时段共 24 所，632 条 EDB 行都可进入学校属性组合；10 所的学费文本明确含小学与中学课程，可保留多学段。
- 名称、地址、官网、地区、性别、授课时间、资助类别等可直接保留导出值；电话 578 所、学费文本与 PDF 链接各 517 所有值，其余可标 unknown。
- 777 个不同来源/表单/PDF 的观察可以分别放入数组，不再只能保留学校级一个 admission_type。但“能放数组”并没有解决哪些字段属于哪次招生、哪个学年可信、重复三元组怎么归并。
- 本报告所说“可保留”只指值/结构，不包括其缺失的必填 provenance；不能因此把这些学校的整包标成通过。

## 6. 两侧实际校验

没有修改 schema 或任何验证函数，也没有专门跳过必填项。校验器结构层先返回错误，因此 **本次没有进入语义规则层**；例如上面的 5 所重复三元组是探索分析检出，不冒称由 v2 的 MATCH_KEY_DUPLICATE 实际报出。

| 原校验器错误码 | 实际错误发生次数 | 说明 |
| --- | ---: | --- |
| `SCHEMA_REQUIRED` | 67,093 | 缺单校任务元数据、检查/采集时间、数值置信度；详见逐路径统计 |
| `SCHEMA_PATTERN` | 39 | 多日期字符串进入单日期槽（14 开始 / 24 截止 / 1 发布） |
| `SCHEMA_MIN_LENGTH` | 19 | 19 个空 PDF 文本引用（涉及 16 所学校），没有填占位符 |
| `SCHEMA_FORMAT` | 3 | 三个真实非法公历日期 |

实际 stdout 摘录（完整文件见下节）：

```text
CONVERSION complete=0 partial=585 unconvertible=0
PYTHON {"accepted":0,"rejected":585}
TYPESCRIPT {"accepted":0,"rejected":585}
PARITY 585/585 identical; disagreements=0
PROTECTED schema and validator SHA256 unchanged before/after
INPUTS 1063 source SHA256 unchanged before/after
Original CLI parity: 585/585 outputs byte-identical; both exit 1
Library/CLI parity: all 585 full error arrays identical
Recorded complete Python/TypeScript CLI stdout, no truncation
```

校验有两条相互核对的执行路径：探索工具实际调用 Python 原 `validate_text`，TypeScript bridge 实际调用原导出的 `validateText`；然后把全部 585 个相同 JSON 临时文件交给两侧**原有 CLI** 再跑一遍。CLI 均退出 1 是 585 个包预期被拒绝，不是工具崩溃；全量对比/检查工具退出 0 只表示记录成功且一致，不表示数据通过。

额外核对：bundled openpyxl 与探索工具的标准库 XLSX reader 对 632×30 所有单元格逐一比对一致（包括空值与文本编号）。新 TS bridge 的定向类型检查与 ESLint 通过。没有跑爬虫/网络请求、数据库、产品端到端或生产构建。所有新增代码均由本票编写，未修改既有生产脚本。

## 7. 对契约的修改建议（proposed，仅建议）

| 建议 | 对应实测问题 | 不能借此放宽的边界 |
| --- | --- | --- |
| 单独设计“旧产物观察输入”与“受调度的抓取结果”两种信封；允许原始元数据 unknown，并记录导入/转换时间为独立字段 | 585 所缺单校任务 ID、来源版本和真实 checked_at，现有 run 不支持表达 | 不以转换时间冒充抓取时间，不伪造历史任务，正式抓取仍需完整任务上下文 |
| provenance 支持 `not_recorded`、源文档级时间及原始置信度类别/缺失；将数值 confidence 改为有明确来源时才填写 | 585 所没有数值 confidence；EDB 采集时间均缺 | 不把 high/medium/low 任意映射成 0.9/0.5/0.1；unknown 不具有启用资格 |
| 加“未决来源观察/冲突值”层，能保留多个值及各自证据，再映射到 N2 的业务三元组 | 74 所表单归属未明、1 所标题/PDF 学年冲突、5 所多观察同键 | 不改变 N2，不增加 URL/时段为第四个匹配键；不静默挑赢家、不把一个未知候选当作已归并 |
| 申请起止/发布日期不要只加大成数组；建议区分日期观察、精度、上下文及适用招生，再由业务层确定单条记录的日期 | 34 所多日期字符串，另有 3 所非法日期 | 无效日期仍应拒绝成为正式日期；不修成某个猜测日期，不把多个学年日期混成一个时段 |
| raw 失败资源可表达 URL、错误、空文本/未获取正文；与已取得非空正文区分 | 139 所至少一条源失败；16 所空 PDF 文本受到 minLength 限制 | 空材料不伪装为文档，不把一个失败 URL 推定为整校失败，也不忽略它 |
| 保留字段“上游抽取断言 / 待核对 / 有定位事实”区别；质量核对与格式校验分开 | 160 所选中页面被上游标非招生、66 所跨主机、4 所材料非申请文字信号、2080 年日期可过格式 | 不靠 schema 通过宣布事实正确，不把跨主机全部封禁，也不把 is_admission_page 布尔当人工判决 |

不建议改动 D4 的六位学校边界。3 个 school_key 缺口是可以由已有 URL 明确恢复的适配问题，不需要新增学校合并规则。工作簿、registry 与已知页面的不同名称不能成为跨编号合并理由。

这些建议有些需要后续契约技术审阅，有些是生产者质量/证据保留改进；本票没有实施任何一项。

## 8. 文件、完整输出与复现

所有新增文件都在 `explorations/school-handoff-fit-gap/`，**探索性、离线、不可用于生产**；没有注册到 package scripts、crawler CLI、worker、Schools runtime 或发布入口。

school-tracker（Git 根路径再加 hk-school-platform/）：

| 文件 | 内容 |
| --- | --- |
| `fit_gap.py` | 全量探索转换、问题分析及双语言结果比对 |
| `verify_full_cli.py` | 再对全部真实转换尝试调用两侧原 CLI，保留 stdout |
| `README.md` | 本报告 |
| `results/summary.json` | 全量分母、分类、逐错误路径/字段计数 |
| `results/gap-categories.json` | 每类学校数、真实学校例子、原值与定位 |
| `results/source-manifest.json` | 1,063 份输入的 SHA256，main SHA，契约与校验器前后指纹 |
| `results/schools.jsonl.gz` | 全 585 校的分类、全部问题详情、行号/路径、raw-only 清单 |
| `results/attempts.jsonl.gz` | 全 585 个真实转换尝试及原材料，**均不可导入** |
| `results/python-results.jsonl.gz` / `typescript-results.jsonl.gz` | 每校完整校验错误数组，未截断 |
| `results/stdout.txt` | 全量执行 stdout，逐校一行 + 分类统计，无省略 |
| `results/python-cli-stdout.txt.gz` / `typescript-cli-stdout.txt.gz` | 两侧原 CLI 的完整实际 stdout，逐错误路径不截断；压缩仅为控制体积 |
| `results/cli-verification.txt` | 原 CLI 与库调用全量对照结果 |

Tianxingguoji：`validate-attempts.ts` 为独立探索桥接脚本（只是调用现有校验器）；本报告、summary.json、gap-categories.json、stdout.txt 和 cli-verification.txt 为相同报告副本。原始大体积尝试/证据统一在 school-tracker，不复制进业务目录。

在 school-tracker/hk-school-platform 根目录（Python 3.9+ / Node 支持直接执行 TS；实际 Python 3.9.6、Node v25.9.0）：

```sh
python3 explorations/school-handoff-fit-gap/fit_gap.py \
  --producer /Users/karo/Documents/school-tracker/hk-school-platform \
  --consumer /Users/karo/Documents/Tianxingguoji \
  --output explorations/school-handoff-fit-gap/results

python3 explorations/school-handoff-fit-gap/verify_full_cli.py \
  --producer /Users/karo/Documents/school-tracker/hk-school-platform \
  --consumer /Users/karo/Documents/Tianxingguoji \
  --results explorations/school-handoff-fit-gap/results

gzip -dc explorations/school-handoff-fit-gap/results/python-cli-stdout.txt.gz
```

最后一条可展开全部实际原 CLI 输出；其中 `0000.json` 对应 merged 数组 index 0，顺序与 attempts/schools 一致。不要把这里的 partial 文件放入任何正常导入目录。
