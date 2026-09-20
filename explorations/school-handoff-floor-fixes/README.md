# 585 所共同问题修复：判断、实现与离线证据

日期：2026-09-21。技术契约状态仍为 **proposed**；2.0 草案修订，未宣称审批或冻结。
唯一业务依据：txgj-doc/business-requirements/50-schools.zh-CN.md，当前基线 BR-BASELINE-20260920-v56。未修改业务文档。

## 判断与 BR 原文

### 1. EDB_COLLECTED_AT_MISSING：改产出方，契约不放宽

BR 学校字段 V1 原文：“来源网址、证据摘要、采集时间、最近检查时间、缺失项／复核原因、版本号、变更前后值、发起人、启用人、启用时间、抓取结果”。
BR 原文：“保留旧值时同时保留旧值的来源和采集时间，不将本次检查时间伪装为旧值的新采集时间。”
BR 原文：“本次未取得数据而继续使用旧值时，保留旧值原有采集时间；本次抓取时间记录于检查/任务履历，不把旧资料标记为本次新采集。”

实现：EDB spider 在成功响应回调开始时记录实际 UTC 秒级采集时间，把该响应新提取/改变的字段与 source_url、collected_at 一起写入 edb_field_observations。分别覆盖列表、详情、子页、学费 PDF，不用一个学校级时间给所有字段盖章。复用旧字段保持原有记录；缓存响应不冒充新采集，collected_at 为 null。失败响应没有可用的新采集时间；PDF 解析失败不产生已提取事实。

该记录序列以 JSON 文本经过检查点与新增 Excel 列“EDB 逐來源採集記錄”，registry 导入保留所有行的观察，merged final 原样保留。导入不填写当前时间、不读取文件 mtime；同名 registry 行的观察追加保存，未变更既有学校匹配规则。本票没有实现完整 v2 出包器。来源字段与输出别名之间的关联仍需后续出包器明确处理，不能把记录中任一时间套用于所有最终字段。

### 2. EVIDENCE_NUMERIC_CONFIDENCE_MISSING：改两个仓库的契约

BR 原文：“注册详情、课室容量、PDF 原文、抓取评分等保留在原始记录中，不作为首版主要业务字段。”
BR 未要求每条字段证据都有数值置信度，更未规定 high/medium/low 对应什么数字。因此删除 evidence.required 中的 confidence；可选 confidence 如果提供，仍必须是 0–1 数值，布尔值、类别字符串、越界数值仍不合法。类别或缺失评分不转换成数字，类别原文保留在 raw_records.content，不成为业务字段。

只改 schema 的必填列表及解释，不改 Python / TypeScript 校验器。2.0 尚为 proposed，记录修订日期并保持协议标识；旧数值评分包继续通过，新省略评分包需配套本次 schema。部署/消费方不能将不同修订的 2.0 草案混用。52 个样本数及期望结果不变，其中 sample-unknown-components.json 改为省略证据评分、在原始材料保留合成 medium 类别，用来验证新增合法表达。

### 3. BOARDING_CAPACITY_NOT_BOOLEAN：改产出方，住宿契约不改

BR 原文：“是否提供住宿（是／否／未知）、住宿说明”。
BR 原文：“缺失信息为未知，不推断：无住宿资料不等于无宿舍，无截止日期不等于全年招生。爬虫尚不能提供的字段允许暂缺。”
结合上文“课室容量……保留在原始记录中”，当前契约 boarding 的 known true / known false / unknown null，以及独立 boarding_description，已经符合三态要求。不能把容量文本改成布尔字符串，或为提高通过率改成任意文本。

修复 registry builder 的两个污染入口：删除 dormitory_info 对批准课室/宿舍容量字段的别名，删除容量字段向 dormitory_info 的兜底复制。容量原文仍完整保留在 approved_classrooms_and_dormitory_capacity。仅明确的独立住宿说明列继续作为 dormitory_info，不从容量、关键词或注册说明推断住宿是/否。没有明确说明时产出方该字段缺失，v2 出包应使用 unknown，而不是 false。

既往 fit-gap 中此类别是语义诊断，不代表 585 个包都因 boarding 的 SCHEMA_TYPE 被拒；探索转换本来就把住宿标成未知。数值评分的诊断也不能代替原始验证错误统计。本票未修改旧探索脚本或重算它的分类报告。

## 验证和边界

完整实际输出见 validation-output.txt；两边保留同一份日志。

命令（Tianxingguoji 根目录）：

```sh
node scripts/test-school-handoff-v2.ts /Users/karo/Documents/school-tracker/hk-school-platform
node_modules/.bin/tsc --noEmit --strict --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck scripts/validate-school-handoff-v2.ts scripts/test-school-handoff-v2.ts
```

命令（school-tracker/hk-school-platform）：

```sh
/tmp/handoff-floor-tests/bin/python -m pytest -q apps/crawler/tools/test_handoff_floor_provenance.py apps/crawler/tools/test_edb_reliability.py apps/crawler/tools/test_registry_metadata_enrichment.py
```

测试环境：临时虚拟环境 /tmp/handoff-floor-tests，按仓库 apps/crawler/requirements.txt 安装依赖；未改仓库依赖。所有响应是本地构造的测试材料，未启动 Scrapy 网络爬取器；新测试用 socket 拦截禁止联网。未访问任何学校或 EDB 网站。Git pull/push 和依赖安装不属于真实抓取。

结果：55 个契约文件逐字节一致；同一 52 样本 Python / TypeScript 均为 11 接受、41 拒绝，52/52 决策、错误码及路径一致；定向 TypeScript 类型检查通过；28 项离线 Python 测试通过。离线测试覆盖不同源的时间、缓存/失败、旧值不刷新、PDF、Excel 回读、registry 与合并记录、同校多行观察、原文空格保留、明确住宿说明与容量分离。首次运行发现测试把“未知字段缺失”错误断言成空字符串，已改为断言字段不存在；没有为满足断言在产物补空值。

本票只改 EDB 产出来源时间、容量误映射及 proposed 契约的评分必填性。不处理学年/年级抽取，不修改 schools 运行时，不入库、不建表，不产生 PR 或合并。

## 旧产物的预期状态（不是重跑 585 包的结果）

既往全量报告在 school-tracker 分支 codex/contract-fit-gap-real-data、提交 f0cf36ced232743b51475154a93a952886546b47。此次 pull 后 main 未包含该探索报告，本票没有把旧分支改动带入新分支。

- 全部 585 所的旧 EDB 证据没有真实采集时间。这批原始快照永久不能无损转换为带完整旧事实/证据的合法 v2 包；后续新抓取只是新观察，不能恢复旧证据的时间。不得使用文件名、mtime、generated_at、导出时间或本次检查时间补齐。把旧事实丢弃后改为 unknown，不算完成旧资料转换。
- 类别评分本身不再是契约阻塞；须省略数值评分并保留原文。旧探索脚本的硬编码 EVIDENCE_NUMERIC_CONFIDENCE_MISSING 诊断不会自行消失，后续适配才可更新，本票不宣称旧报告成功率上升。
- 旧容量文本可保留原始记录，住宿保持 unknown；此票没有追写旧 registry、XLSX、records.json。已污染的旧 dormitory_info 不能因为代码修复而被当成可靠住宿说明。
- 原报告另外有 RUN_METADATA_MISSING 585 所，以及招生来源归属、学年/年级、日期等问题，仍未解决。未来 EDB 新产物也不因补来源时间而自动成为完整合法 v2 包。

## 分支与清单

两个仓库均先切 main 并 git pull --ff-only，再建立 codex/handoff-floor-fixes。
main 起点：school-tracker a4de65b4d7cc4f8a0924689acc6f6a3d38c1132a；Tianxingguoji 541e227cf0214b126d1e8415ec0971acefc54476。
改动文件完整清单见 changed-files.txt（按 Git 根目录）。提交 SHA 由交付回复记录，避免自引用。
