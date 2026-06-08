# 香港学校平台：Design-Driven Development 执行计划

## 1. 目标
把设计文档转成可以直接开发和验收的工程计划，确保每个功能都有：
1. 需求来源
2. 技术实现
3. 测试验收
4. 上线监控

---

## 2. 设计驱动开发流程（DDDv1）

### Step A: Design Freeze（冻结范围）
- 冻结 MVP 范围：仅包含“搜索 + 学校详情”
- 暂缓到后续阶段：对比、申请追踪、评论
- 冻结技术栈：Next.js 15 + FastAPI + PostgreSQL + Scrapy + Celery

### Step B: Requirement Slicing（需求切片）
把每条设计需求拆成可交付切片（Vertical Slice）：
- Slice 1: 学校数据入库（schema + seed）
- Slice 2: 学校搜索 API
- Slice 3: 搜索页面（含筛选）
- Slice 4: 学校详情页
- Slice 5: 性能与可观测性（监控、日志、告警）

每个切片必须同时包含：
- DB 迁移
- API 合约
- 前端页面
- 自动化测试
- 验收标准

### Step C: Contract First（先定义接口）
先写 API contract，再写实现：
- OpenAPI 定义请求/响应字段
- 明确错误码（400/401/404/422/500）
- 约定分页、排序、筛选参数

### Step D: Build by Priority（按风险优先开发）
优先顺序：
1. 数据可得性验证（EDB/schooland）
2. 搜索主流程（核心业务价值）
3. 管理后台基础 CRUD
4. 定时爬虫和审核流

### Step E: Evidence-based Acceptance（证据化验收）
每个切片完成前必须给出证据：
- 测试通过截图或日志
- API 示例请求/响应
- 性能指标（P95）
- 回归检查结果

---

## 3. Design -> Engineering Traceability

| 设计需求 | 工程模块 | 验收标准 |
|---|---|---|
| 定期爬取学校信息 | Scrapy + Celery Beat | 每周任务自动触发成功率 >= 95% |
| 半自动审核导入 | scrape_staging + admin 审核页 | 审核通过后主表数据正确更新 |
| 学校数据管理 | schools CRUD + grade_requirements CRUD | 管理员可增删改查且权限正确 |
| 顾问筛选推荐 | filter API + 三档分类算法 | 输出 reach/match/safety 且结果合理 |
| 成本可控 | 基础部署与监控 | 月成本在预算范围内 |

---

## 4. 开发前置 Gate（必须先完成）

### Gate 0: 数据源可行性（1天）
- 验证 EDB 是否可稳定抓取
- 验证 schooland 反爬强度与备选策略
- 输出结论：可自动抓取字段清单 + 失败降级方案

### Gate 1: 非功能指标落地（半天）
- API P95 < 500ms
- 搜索响应 < 2s（1000 所学校规模）
- 移动端可用（375px）

### Gate 2: 安全与权限（半天）
- JWT 鉴权
- 角色隔离：admin/advisor
- SQL 注入与 XSS 基础防护

---

## 5. 4周 MVP 执行计划（搜索 + 详情）

### Week 1
- 建库与迁移：schools / grade_requirements / success_cases
- 导入初始学校数据（先 100 所）
- 建立搜索索引（district / banding / type）

### Week 2
- 实现 POST /api/schools/filter
- 实现三档分类算法与排序逻辑
- 补齐单元测试（算法 + 参数校验）

### Week 3
- 前端筛选页（条件输入 + 三档结果）
- 学校详情弹窗/详情页
- 移动端适配与空状态处理

### Week 4
- E2E 测试（核心路径）
- 性能优化与监控接入
- 预生产部署与验收

---

## 6. 任务模板（用于 Jira/Linear）

### Feature Ticket 模板
- 背景：对应设计文档哪一节
- 输入：字段与参数
- 输出：页面/API/数据变化
- 验收标准：可度量（性能、准确率）
- 测试项：单测/集成/E2E
- 风险与回滚：失败时降级策略

### Bug Ticket 模板
- 复现步骤
- 期望行为 vs 实际行为
- 影响范围
- 根因定位
- 修复方案
- 回归清单

---

## 7. Definition of Ready / Definition of Done

### DoR（开始开发前）
- 需求有明确输入输出
- API contract 已确认
- 数据模型已确认
- 验收标准可量化

### DoD（完成开发时）
- 代码合并前测试全绿
- 关键路径有自动化测试
- 监控和日志可观测
- 文档已更新（接口、字段、变更）

---

## 8. 下一步
1. 先执行 Gate 0（数据源可行性）并输出结果。
2. 同步将 MVP 范围锁定为“搜索 + 详情”，其余进入后续阶段。
3. 按 Week 1 任务开工，并以本计划作为每日 standup 基准。
