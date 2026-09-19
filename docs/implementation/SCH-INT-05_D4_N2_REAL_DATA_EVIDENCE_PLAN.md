# SCH-INT-05 D4 / N2 真实抓取数据决策材料

状态：`proposed`，等待项目负责人审阅；仅收集证据，不回答 D4 / N2，不批准实施。

| 核对项 | 内容 |
| --- | --- |
| 日期 / Owner | 2026-09-20 / architect |
| 用途 | 为 SCH-INT-04 所列 D4「学校对象粒度」、N2「招生记录身份及跨批次对应」提供真实样本 |
| 数据固定版本 | school-tracker `c2d61e04bbab19a61be662cff25a8592c1ea2463`；下文均为此提交的已有文件 |
| 文档分支起点 | Tianxingguoji `main` / `origin/main`：`dcce25d8710c14f97b2904faf9d08132c35c28dd`；不承接 SCH-INT-02/03/04 分支链 |

## 1. 来源及读法

以下路径均相对 school-tracker 的 `hk-school-platform/`，学校名称上的 EDB 链接抄自数据，供负责人自行核对；**本票没有重新抓取或验证网页当前内容**。工作簿行号包含表头（第 1 行）。

| 代号 | 实际文件 / 范围 |
| --- | --- |
| X | `apps/crawler/output/edb_schools_20260610_enriched.xlsx`，`schools` 工作表：632 数据行、30 列，均标为中學 |
| R | `apps/crawler/config/school_registry.json`；另核对 `apps/crawler/output/school_registry_20260610_enriched.json`，两者各 585 个 key |
| S | `apps/crawler/output/edb_school_stats_deduped.json`：`non_kindergarten_registry_rows=9992`、`unique_school_ids=4999`、中學行数 633 / 唯一编号 585 |
| F06 / C06 | `apps/output/test_10schools_20260606_162456/final/records.json`（10 校）/ 同运行目录的 `discovery/candidates.json` |
| P | `apps/crawler/output/partitioned/full_20260610_130102_llm_p3/` |
| F10 / C10 | P 的 `merged/final/records.json`（585 校）/ `runs/full_batch_001_offset_0000/discovery/candidates.json`；本票三个 N2 样本也均在该 batch 的 `final/records.json` |

**计数和批次不能混用。**S 的 4999 按 EDB `scrn` 前六位计数；当前 spider 在幼稚园/目标学段过滤前登记该集合，9992 则是过滤后行计数，不能直接解释成同一范围的“9992 行去重成 4999 所非幼稚园学校”。X 也不是这 9992 行的全量明细，不能用 X 还原全部差异。P 下 12 个 batch 的学校 key 不重叠，是一次运行的分片，不是同校 12 次复抓；跨时点比较使用 F06 与 F10。

## 2. D4：学校边界样本

### 2.1 同一学校编号占多行（3 校）

X 字段：E=学校编号，G=学校地点标识，J=授课时间，O=地址，P=EDB 详情页。下列各组 A 均为「中學」，不是本表内的学段差异。

| 学校 / X 行 | 行之间的关键差异 | R 中实际保留结果 |
| --- | --- | --- |
| [英華女學校](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=511030000333)（511030）；18 / 19 | G：0003 / 0001；O：卑利士道 2 号 / 罗便臣道 76 号；J 均全日；P 的 scrn：511030000333 / 511030000133 | 一个 `YING_WA_GIRLS_SCHOOL`；地点 0003、卑利士道地址 |
| [聖迦利亞書院（九龍）](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=577979000132&type=)（577979）；107 / 108 | G 均 0001，O 相同（大角咀埃华街）；J：下午 / 上午；scrn：577979000132 / 577979000131 | 一个 `ST_GLORIA_COLLEGE_KOWLOON`；下午 |
| [地利亞修女紀念學校（協和）](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=216143000133&type=)（216143）；502 / 504 | G 均 0001，O 均观塘协和街 221 号；J：全日 / 下午；scrn：216143000133 / 216143000132 | 一个 `DELIA_MEMORIAL_SCHOOL_HIP_WO`；全日 |

### 2.2 团体系列、名称高度相似但编号不同（3 校）

选取「匡智松嶺」系列。**证据限度**：X/R 没有独立办学团体字段或编号；已有抓取出现「匡智會聯校畢業禮」等团体关联文字，但不足以单独完成三校的法定办学团体归属核验。因此这里提供同团体系的待核对样本，不把相似名称当作已证明的同一办学主体。

| 学校 / X 行 | 地址 / 地点标识 | R 独立 key |
| --- | --- | --- |
| [匡智松嶺學校](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=250244000433&type=)（250244）；402 | 大埔南坑、大埔市地段第 34 号 / 0004 | `HONG_CHI_PINEHILL_SCHOOL` |
| [匡智松嶺第二校](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=250384000333&type=)（250384）；407 | 大埔南坑第 1691 号及松岭村第 34 号新翼大楼 / 0003 | `HONG_CHI_PINEHILL_NO_2_SCHOOL` |
| [匡智松嶺第三校](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=250414000333)（250414）；406 | 大埔南坑 / 0003 | `HONG_CHI_PINEHILL_NO_3_SCHOOL` |

关联文字可在 F10 的 250244 `evidence_summary`、250414 `required_materials` 定位（后者也说明字段可能混入非申请资料）。三者在 R/F10 保持独立，不能从名称相近、同地区推导合并。

### 2.3 一条记录内含多个校舍 / 建筑单元（3 校）

这是「一条记录看起来包含多个实体」的实际长相：X 的单个 S 单元格同时列出多项校舍代码。**未在这些记录中证明存在多个独立学校身份**，不将建筑单元直接计成多所学校。

| 学校 / 单元格 | 同一单元格中的并存内容（节选） | 边界所在 |
| --- | --- | --- |
| [弘立書院](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=553190000333)（553190）；S85 | 0003 钢线湾道 1 号；0004 小学大楼 5/6 楼；0006 中学大楼 6 楼及天台；另有其他代码 | 一条记录的校舍清单跨建筑及学段 |
| [香港浸會大學附屬學校王錦輝中小學](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=567353000133)（567353）；S444 | 0001 安睦里 6 号；0002 王廖惠文大楼；0003 康体游泳大楼 | 同一地址下有三个校舍代码 |
| [拔萃男書院](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=510777000133)（510777）；S503 | 0001 亚皆老街 131 号（含宿舍等）；0002 IB 大楼；0003 艺术大楼 | 教学、住宿及其他建筑同存于一条记录 |

### 2.4 横跨小学与中学（3 校）

并非只凭校名判断：X 的 A 列都写「中學」，但 W（学费 PDF 文字摘要）的课程/级别同时出现小学与中学。这里仅引用课程名称，不据此决定产品学校粒度。

| 学校 / 单元格 | 同一课程清单中的小学项 | 中学项 |
| --- | --- | --- |
| [培僑書院](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=560553000133)（560553）；W222 | 小一 PRIMARY 1 | 中一 SECONDARY 1 |
| [國際基督教優質音樂中學暨小學](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=553867000333)（553867）；W364 | PRIMARY 1 (GRADE 1) | SECONDARY 1 (GRADE 7) |
| [播道書院](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=567337000133&type=)（567337）；W488 | 小一 PRIMARY 1 | 中一 SECONDARY 1 |

### 2.5 school-tracker 已有合并行为

本节及 §3.4 的源码路径相对 `hk-school-platform/apps/crawler/`。

| 层次 | 当前源码规则与样本表现 |
| --- | --- |
| EDB 统计 | `school_crawler/spiders/edb_school_excel_spider.py` 的 `school_id_from_detail_url` 使用 scrn 前六位；唯一编号统计折叠校址/授课时间变体，但 `parse_list` 只按完整详情 URL 跳过重复，不因此删除所有同编号明细行 |
| Layer 1 注册表 | `tools/build_school_registry.py::build_registry_from_excel` 调用 `tools/crawler_config.py::make_school_key`：优先英文名，缺失再取中文名、网址；转大写、非 ASCII 字母数字转下划线、截取 120 字符。学校编号、地点、时段、学段都没有加入 key |
| 字段合并 | 相同 key 经 `merge_first_nonempty` 主要保留先出现的非空值、后行补空；不是保存一组地点/时段版本。§2.1 三组在 R 都只剩一个 key；这是样本观察，不宣称按编号正确归并 |
| 保持独立 / 不拆分 | §2.2 英文名生成不同 key，三校保持独立；§2.3/2.4 的校舍清单和课程文字不生成额外学校 key。规则不比较办学团体，也不按网址把所有学校归成一个；名称变化/规范化碰撞的后果不能靠学校编号防住 |

以上是固定提交的源码及产物观察；没有重新运行 builder，也不据此认定其行为是 D4 的答案。

## 3. N2：招生记录身份样本（3 例）

下表的“前/后”指 F06/F10 的**抓取及抽取产物**，不是认定学校业务发生了变化。两次的输出字段和处理路径不同（F10 可见 `confirmed_url`），不能把抽取器升级、证据选择变化误报成学校改了招生政策。`字段不存在` 与空字符串 `""` 分开记录。

### 3.1 同链接，内容及字段变化

学校：[佛教大雄中學](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=170372000133)（170372）；key=`BUDDHIST_TAI_HUNG_COLLEGE`。

| 字段 | F06 | F10 |
| --- | --- | --- |
| final_admission_url | `https://www.bthc.edu.hk/Content/08_others/01_what_is_new/index.aspx?ct=latestNews&styleId=1&newsType=generalAnouncement#news1177` | 完全相同 |
| application_form_links 中该链接标题 | 2026-27年度插班生入學申請表格下載 | 同标题增加「(已截止)」 |
| application_dates | `5/6/2026 1/6/2026` | 相同 |
| application_open / submission_deadline | 两个字段均不存在 | `2026-06-01` / `2026-06-05` |
| admission_type | `s1_admission` | `s1_admission`（尽管链接标题写插班生） |

这里同时存在“同一 URL 的标题变化”和“旧版没有的结构化字段”；原始日期串未变。尚不能据此判断新招生记录、旧记录修订，或日期抽取修正；字段日期亦未经本票人工业务核实。

### 3.2 同页面跨次类型变化，且多学年 / 多类招生并存

学校：[佛教大光慈航中學](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=190748000133)（190748）；key=`BUDDHIST_TAI_KWONG_CHI_HONG_COLLEGE`。

| 观察项 | F06 / C06 | F10 |
| --- | --- | --- |
| final_admission_url | `https://www.btkchc.edu.hk/入學申請` | 同一路径采用百分号编码；解码后相同 |
| admission_type | `s1_admission` | `transfer` |
| 两个并存的 application_form_links | `26-27 各級插班生_申請表` → `/image/catalog/apply_form/C.pdf`；`25-26 各級插班生_申請表` → `/image/catalog/apply_form/S1form/175159569100146800.pdf` | 两组标题和链接仍相同 |
| 同页面其他招生文字 | C06 的 `nearby_text` 还有「25-26 中一轉校生須知」「中一自行分配學位 入學申請表」 | final 仍只有一个标量 admission_type，没有逐条招生对象数组 |

C06 定位：该 key、`page_title=入學申請 - 佛教大光慈航中學`、`discovered_at=2026-06-06T08:27:28Z`。一个页面中同时出现两学年插班表和中一申请信息；页面地址、表单地址、招生类别并非天然一一对应。本票不选择其中任何字段作为身份。

### 3.3 无法从已有有效证据确定学年的实际长相

学校：[香港紫荊書院](https://applications.edb.gov.hk/schoolsearch/schoolinfo.aspx?langno=2&scrn=621374000133)（621374）；key=`HONG_KONG_BLUEBELL_COLLEGE`。

| 字段 / 证据 | F06 | F10 / C10 |
| --- | --- | --- |
| final_admission_url / 类型 | 空字符串 / `unknown`；notes 指向 `/插班` 的 HTTP 404、无有效候选 | `/9%E6%9C%88%E5%85%A5%E5%AD%B8`（解码为 `/9月入學`）/ `general_admission` |
| 页面原文节选 | 无有效 final 证据 | 「香港紫荊書院現全年開放申請。」；page_title 为 `Application Process \| HKBC` |
| 日期和学年 | application_dates 为空，结构化申请起止字段不存在 | application_dates、application_open、submission_deadline 均为 `""`；final 没有 academic_year 字段 |
| 候选年度提示 | 不用失败页面推定学年 | C10：has_current_year=false、has_old_year=true；但现有 nearby_text 中这段申请说明没有明确招生学年 |

C10 定位：该 key、上述 URL、`discovered_at=2026-06-10T05:02:52Z`。布尔年度提示没有给出具体学年；“9 月”及“全年”也没有指明哪一年。本例是现有证据不足，**不是证明官网所有页面都没有学年**，更不为其填入抓取当年。

### 3.4 现有 final 的结构限制

`tools/select_final_admission_records.py::select_records/build_record` 按学校 key 分组，选择一份学校级 final，同时汇入多个证据链接/摘要；不是按“学校 × 学年 × 招生类别”分别输出招生对象。`tools/merge_partitioned_run_outputs.py::merge_records` 同样按学校 key 比较完整度等评分，较高者替换、相同保留先到者，不按最新抓取时间追加招生履历。因此 F06/F10 能对照学校产物，不能直接证明某条稳定招生记录跨批次的对应关系。

## 4. 本票记录

- status：`proposed`，证据材料完成，D4 / N2 仍待项目负责人决定。
- changed：仅新增本文，独立从 main 建分支；不修改 SCH-INT-01/02/03/04、业务需求或实现。
- evidence：只读核对固定提交的数据、XLSX 单元格、注册表、两次运行产物及合并源码；D4 每类 3 校，N2 共 3 例；核对文档差异与 Git 空白检查。
- not_run：未运行爬虫、builder、产品代码、测试、迁移或部署；未修改 school-tracker 的任何文件/配置；没有实时访问学校/EDB 页面；不创建 PR、不合并。
- risks：统计与样本范围不同；团体归属缺乏结构化证明，多个校舍不等于多所学校；抓取产物变化不等于业务变化，现有招生 final 缺少逐条身份。本文不给推荐答案、不建议采用哪种学校粒度或招生匹配规则，也不批准任何后续设计或实现。
