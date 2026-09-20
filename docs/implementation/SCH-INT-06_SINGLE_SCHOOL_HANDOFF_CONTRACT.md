# SCH-INT-06 Stage A 第一块：单校结果契约草案与校验记录

状态：`proposed`，待项目负责人技术审阅。可执行校验已完成，不表示契约已获批准或冻结。

唯一业务依据：**BR-051 / `BR-BASELINE-20260920-v56`**。

日期：2026-09-20。范围：交接契约草案、合成样本、Python/TypeScript 离线校验。

## 核对依据与交付

- 直接读取 txgj-doc 的 BR-051 `BR-BASELINE-20260920-v56`（学校字段 V1、D4、N2）；没有修改需求。原文摘录见[契约草案的 BR-051 原文部分](../../contracts/school-crawl-handoff/v2/README.md#br-051-原文与审阅范围)。
- 参考资料与既往分析单独列明：SCH-INT-01 §8.3/§11 及 SCH-INT-02/03/05 均不构成依据、批准或授权。按照本票修正后的审阅安排，接口格式是 A 阶段技术审阅产出，本票不实施某份已批准设计。
- 两仓库都从干净 main 执行 `git pull --ff-only`，均 Already up to date，然后创建 `codex/stage-a-school-handoff-contract`。Tianxingguoji 起点 `3cb746a`；school-tracker 起点 `c2d61e0`。
- 技术契约草案：`school-crawl-handoff` / `2.0`，文档及完整 schema 在 [契约目录](../../contracts/school-crawl-handoff/v2/README.md)。校验器都不依赖 Schools 运行时、爬虫进程或第三方验证库。
- 11 个合法合成包、41 个非法包及明确的预期错误在 [cases.json](../../contracts/school-crawl-handoff/v2/cases.json)。所有名称、编号、地址、URL、日期及证据均为测试数据，未重新抓取真实网站。
- 学校字段全量显式表达；EDB 前六位边界、校址多值/组合、跨学段、一校多招生、未知学年每次新候选、未知年级不匹配、来源不作为第四匹配条件、逐字段证据与原采集时间、失败和无变化均有正反例。

## 实际运行

环境：Node `v25.9.0`、Python `3.9.6`。没有安装依赖。以下命令在 Tianxingguoji 根目录实际执行：

```sh
node scripts/test-school-handoff-v2.ts /Users/karo/Documents/school-tracker/hk-school-platform
node_modules/.bin/tsc --noEmit --strict --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck scripts/validate-school-handoff-v2.ts scripts/test-school-handoff-v2.ts
node_modules/.bin/eslint scripts/validate-school-handoff-v2.ts scripts/test-school-handoff-v2.ts
```

双语言 runner 退出 0；定向 TypeScript 类型检查、两脚本 ESLint 退出 0（无诊断）。runner 分别启动真实的 Python 与 Node CLI；两侧读取相同绝对路径的同一组文件，不能各自偷偷更换样本。先验两个仓库的契约/样本/预期文件字节一致，再验各侧输出与手写期望一致，并互相比对。混合合法/非法套件的单侧 CLI 必须退出 1，runner 在确认这是预期拒绝后退出 0。

完整 stdout：

```text
Artifact copies: 55 byte-identical files
ACCEPT sample-composite.json
ACCEPT sample-unknown-year.json
ACCEPT sample-unknown-year-repeat.json
ACCEPT sample-unknown-components.json
ACCEPT sample-unbound-edb.json
ACCEPT sample-unknown-edb.json
ACCEPT sample-failed.json
ACCEPT sample-partial.json
ACCEPT sample-unchanged.json
ACCEPT sample-same-name-other-school.json
ACCEPT sample-known-key-new-url.json
REJECT bad-edb.json $.school.edb_school_number:SCHEMA_PATTERN
REJECT bad-school-boundary.json $.school.campus_variants[1].edb_scrn:EDB_SCHOOL_MISMATCH
REJECT bad-version.json $.schema_version:SCHEMA_CONST
REJECT bad-extra-school.json $.schools:SCHEMA_EXTRA
REJECT bad-extra-field.json $.school.attributes.base_kind:SCHEMA_EXTRA
REJECT bad-missing-field.json $.school.attributes.boarding:SCHEMA_REQUIRED
REJECT bad-unknown-year.json $.admissions[0].identity_mode:NEW_CANDIDATE_REQUIRED
REJECT bad-unknown-grade.json $.admissions[0].identity_mode:NEW_CANDIDATE_REQUIRED
REJECT bad-known-mode.json $.admissions[0].identity_mode:EXACT_MODE_REQUIRED
REJECT bad-duplicate-key.json $.admissions[1].fields:MATCH_KEY_DUPLICATE
REJECT bad-duplicate-id.json $.admissions[1].candidate_id:CANDIDATE_ID_DUPLICATE
REJECT bad-known-null.json $.school.attributes.name_zh.value:KNOWN_VALUE_REQUIRED
REJECT bad-empty-name.json $.school.attributes.name_zh.value:SCHEMA_PATTERN
REJECT bad-boolean-string.json $.school.attributes.boarding.value:SCHEMA_TYPE
REJECT bad-evidence-missing.json $.school.attributes.boarding.evidence:KNOWN_EVIDENCE_REQUIRED
REJECT bad-evidence-reference.json $.school.attributes.boarding.evidence[0].raw_record_id:RAW_REFERENCE_MISSING
REJECT bad-confidence-boolean.json $.school.attributes.boarding.evidence[0].confidence:SCHEMA_TYPE
REJECT bad-date.json $.admissions[0].fields.application_deadline.value:SCHEMA_FORMAT
REJECT bad-year.json $.admissions[0].fields.academic_year.value:SCHEMA_FORMAT
REJECT bad-timestamp.json $.run.checked_at:SCHEMA_FORMAT
REJECT bad-check-order.json $.run.checked_at:RUN_TIME_ORDER
REJECT bad-unknown-value.json $.school.attributes.name_en.value:NON_KNOWN_VALUE_MUST_BE_NULL
REJECT bad-unknown-reason.json $.school.attributes.name_en.reason:REASON_REQUIRED
REJECT bad-failed-detail.json $.run.failure:FAILURE_DETAIL_REQUIRED
REJECT bad-failed-facts.json $.run.change_status:FAILED_RUN_HAS_FACTS
REJECT bad-unchanged-reference.json $.run.comparison:COMPARISON_REQUIRED
REJECT bad-unchanged-unknown-year.json $.admissions[5].identity_mode:UNCHANGED_HAS_NEW_CANDIDATE
REJECT bad-partial-unreported.json $.run.change_status:PARTIAL_STATUS_REQUIRED
REJECT bad-root-array.json $:SCHEMA_TYPE
REJECT bad-edb-newline.json $.school.edb_school_number:SCHEMA_PATTERN
REJECT bad-nbsp-name.json $.school.attributes.name_zh.value:SCHEMA_PATTERN
REJECT bad-edb-unicode.json $.school.edb_school_number:SCHEMA_PATTERN
REJECT bad-no-school-identity.json $.school:SCHOOL_IDENTITY_REQUIRED
REJECT bad-grade-order-duplicate.json $.admissions[5].fields:MATCH_KEY_DUPLICATE
REJECT bad-other-url-duplicate.json $.admissions[5].fields:MATCH_KEY_DUPLICATE
REJECT bad-json-syntax.json $:JSON_INVALID
REJECT bad-json-duplicate.json $:JSON_INVALID
REJECT bad-json-nan.json $:JSON_INVALID
REJECT bad-json-infinity.json $:JSON_INVALID
REJECT bad-json-depth.json $:JSON_INVALID
REJECT bad-json-surrogate.json $:JSON_INVALID
Python: 11 accepted, 41 rejected
TypeScript: 11 accepted, 41 rejected
PASS 52/52 expected decisions; identical error codes and paths
```

单独合法包的两侧命令也实际运行，均退出 0，输出均为：

```json
{"sample":"sample-composite.json","valid":true,"errors":[]}
```

## 证据边界

- changed：只新增本契约和测试资产、两个校验器、对比 runner 与本记录。双侧 schema 和样本都固定在版本目录。
- evidence：以上为实际离线执行；类型检查只覆盖两个新增 TS 脚本；提交前执行两仓库 `git diff --cached --check`。
- blocked：草案和离线校验交付无阻塞；技术契约仍待负责人审阅，不能将本记录视为批准。
- not_run：未运行真实爬虫、产品端到端、数据库、迁移、学校运行时、页面、云部署或业务启用；没有创建 PR、没有合并。
- risks：通过只证明包的形状及包内自洽，不能证明 EDB/内部编号真实对应、来源获批、事实准确或无变化声明真实。Stage B 再核对任务/来源配置/历史抓取与材料完整性；Stage C 再实现候选、启用和履历。本票不依赖来源关联表、base_kind 双基线、当前指针表等未批准设计，也不冻结 Schools 业务 API。
- 原 crawler AGENTS 引用的 `/Users/mingjiexing/Desktop/.../AGENTS.md` 在本机不存在；已读取可用的根 AGENTS、docs/AGENTS 和 PRODUCTION_WORKFLOW。本票不触碰那个历史前端路径或发布链。

## 改动文件清单

Tianxingguoji 单独新增：

```text
scripts/validate-school-handoff-v2.ts
scripts/test-school-handoff-v2.ts
docs/implementation/SCH-INT-06_SINGLE_SCHOOL_HANDOFF_CONTRACT.md
```

school-tracker 单独新增（相对其 Git 根）：

```text
hk-school-platform/tools/validate_school_handoff_v2.py
```

两仓库共同新增下列相同文件（school-tracker 的 Git 路径均加 `hk-school-platform/` 前缀）：

```text
contracts/school-crawl-handoff/v2/README.md
contracts/school-crawl-handoff/v2/contract.schema.json
contracts/school-crawl-handoff/v2/cases.json
contracts/school-crawl-handoff/v2/sample-composite.json
contracts/school-crawl-handoff/v2/sample-unknown-year.json
contracts/school-crawl-handoff/v2/sample-unknown-year-repeat.json
contracts/school-crawl-handoff/v2/sample-unknown-components.json
contracts/school-crawl-handoff/v2/sample-unbound-edb.json
contracts/school-crawl-handoff/v2/sample-unknown-edb.json
contracts/school-crawl-handoff/v2/sample-failed.json
contracts/school-crawl-handoff/v2/sample-partial.json
contracts/school-crawl-handoff/v2/sample-unchanged.json
contracts/school-crawl-handoff/v2/sample-same-name-other-school.json
contracts/school-crawl-handoff/v2/sample-known-key-new-url.json
contracts/school-crawl-handoff/v2/invalid/bad-edb.json
contracts/school-crawl-handoff/v2/invalid/bad-school-boundary.json
contracts/school-crawl-handoff/v2/invalid/bad-version.json
contracts/school-crawl-handoff/v2/invalid/bad-extra-school.json
contracts/school-crawl-handoff/v2/invalid/bad-extra-field.json
contracts/school-crawl-handoff/v2/invalid/bad-missing-field.json
contracts/school-crawl-handoff/v2/invalid/bad-unknown-year.json
contracts/school-crawl-handoff/v2/invalid/bad-unknown-grade.json
contracts/school-crawl-handoff/v2/invalid/bad-known-mode.json
contracts/school-crawl-handoff/v2/invalid/bad-duplicate-key.json
contracts/school-crawl-handoff/v2/invalid/bad-duplicate-id.json
contracts/school-crawl-handoff/v2/invalid/bad-known-null.json
contracts/school-crawl-handoff/v2/invalid/bad-empty-name.json
contracts/school-crawl-handoff/v2/invalid/bad-boolean-string.json
contracts/school-crawl-handoff/v2/invalid/bad-evidence-missing.json
contracts/school-crawl-handoff/v2/invalid/bad-evidence-reference.json
contracts/school-crawl-handoff/v2/invalid/bad-confidence-boolean.json
contracts/school-crawl-handoff/v2/invalid/bad-date.json
contracts/school-crawl-handoff/v2/invalid/bad-year.json
contracts/school-crawl-handoff/v2/invalid/bad-timestamp.json
contracts/school-crawl-handoff/v2/invalid/bad-check-order.json
contracts/school-crawl-handoff/v2/invalid/bad-unknown-value.json
contracts/school-crawl-handoff/v2/invalid/bad-unknown-reason.json
contracts/school-crawl-handoff/v2/invalid/bad-failed-detail.json
contracts/school-crawl-handoff/v2/invalid/bad-failed-facts.json
contracts/school-crawl-handoff/v2/invalid/bad-unchanged-reference.json
contracts/school-crawl-handoff/v2/invalid/bad-unchanged-unknown-year.json
contracts/school-crawl-handoff/v2/invalid/bad-partial-unreported.json
contracts/school-crawl-handoff/v2/invalid/bad-root-array.json
contracts/school-crawl-handoff/v2/invalid/bad-edb-newline.json
contracts/school-crawl-handoff/v2/invalid/bad-nbsp-name.json
contracts/school-crawl-handoff/v2/invalid/bad-edb-unicode.json
contracts/school-crawl-handoff/v2/invalid/bad-no-school-identity.json
contracts/school-crawl-handoff/v2/invalid/bad-grade-order-duplicate.json
contracts/school-crawl-handoff/v2/invalid/bad-other-url-duplicate.json
contracts/school-crawl-handoff/v2/invalid/bad-json-syntax.json
contracts/school-crawl-handoff/v2/invalid/bad-json-duplicate.json
contracts/school-crawl-handoff/v2/invalid/bad-json-nan.json
contracts/school-crawl-handoff/v2/invalid/bad-json-infinity.json
contracts/school-crawl-handoff/v2/invalid/bad-json-depth.json
contracts/school-crawl-handoff/v2/invalid/bad-json-surrogate.json
```
