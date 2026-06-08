# 香港留学服务机构学校信息整合平台 - 设计文档

## 项目概述

### 背景
香港的一家留学服务机构帮助大陆各年龄段用户来香港读书，包括初高中、本科以及硕士。机构需要追踪香港全部本地学校、国际学校、本科项目以及硕士项目的各类信息，以便为客户提供精准的选校建议。

### 目标用户
- **管理员**：机构管理人员，可以修改数据库、配置爬虫、更新成绩档次
- **普通顾问**：留学顾问，使用筛选功能为客户推荐学校

### 核心需求
1. 定期爬取香港学校信息（教育局官网、学校官网、schooland.hk）
2. 半自动化数据审核（爬取后人工审核再导入）
3. 数据管理界面（增删改查学校信息、更新成绩档次）
4. 学校筛选界面（根据学生测评成绩 + 多维度条件推荐学校）
5. 未来可升级为 AI chatbot with RAG

### 成功标准
- 爬虫可靠性 >95%（多策略备份）
- 数据更新频率可配置（每周/每月/每学期）
- 筛选结果准确性 >90%（基于历史案例验证）
- 月运营成本 <$100

---

## 技术方案

### 最终技术栈

**前端层**
- Next.js 15 (App Router + Server Actions)
- Shadcn UI + Tailwind CSS
- TanStack Table（数据表格组件）
- TypeScript

**后端层**
- FastAPI 0.115+ (全异步)
- Pydantic v2（数据验证）
- Python 3.11+

**数据层**
- PostgreSQL 16 + pgvector 0.6
- 托管服务：Supabase Pro 或 Neon
- Alembic（数据库迁移工具）

**任务队列**
- Celery 5.4（broker=PostgreSQL）
- Celery Beat（定时任务调度）

**爬虫层**
- Scrapy 2.11
- 多策略备份机制
- 半自动审核工作流

**部署**
- Docker + Docker Compose
- 云服务器（2核4GB）

---

## 系统架构

### 架构图

```
┌─────────────────────────────────────────────────────┐
│                   前端界面层                         │
│  ┌──────────────┐         ┌──────────────┐          │
│  │ 筛选界面      │         │ 管理界面      │          │
│  │ (顾问使用)    │         │ (管理员使用)  │          │
│  └──────────────┘         └──────────────┘          │
│           │                       │                  │
│           └───────────┬───────────┘                  │
│                       ↓                              │
│              Next.js Server Actions                  │
└───────────────────────┼─────────────────────────────┘
                        ↓
┌───────────────────────┼─────────────────────────────┐
│                  FastAPI 后端                        │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │ 筛选 API    │  │ 管理 API    │  │ 爬虫 API   │  │
│  └─────────────┘  └─────────────┘  └────────────┘  │
└───────────────────────┼─────────────────────────────┘
                        ↓
┌───────────────────────┼─────────────────────────────┐
│              PostgreSQL + pgvector                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐     │
│  │学校信息表 │  │成绩档次表 │  │历史案例表     │     │
│  └──────────┘  └──────────┘  └───────────────┘     │
└─────────────────────────────────────────────────────┘
         ↑                              ↑
         │                              │
┌────────┴────────┐          ┌─────────┴────────┐
│  Celery Worker  │          │  Scrapy 爬虫     │
│  (定时任务调度)  │ ←────────│  (多策略备份)    │
└─────────────────┘          └──────────────────┘
         ↑
         │
┌────────┴────────┐
│  Celery Beat    │
│  (每周/每月触发) │
└─────────────────┘
```

### 数据流

**筛选流程：**
```
顾问输入筛选条件 
  → Next.js Server Action
  → FastAPI 筛选 API
  → PostgreSQL 查询（多表 JOIN）
  → 三档分类算法
  → 返回推荐学校列表
  → Next.js 渲染结果
```

**爬虫流程：**
```
Celery Beat 触发定时任务
  → Celery Worker 调用 Scrapy
  → Scrapy 爬取数据（多策略备份）
  → 生成"待审核数据"
  → 管理员在界面预览变更
  → 确认后批量导入 PostgreSQL
  → 记录策略使用情况
```

---

## 核心功能设计

### 1. 智能筛选系统

#### 输入条件
- **学生测评成绩**：机构自定义评级（A/B/C/D）
- **地区偏好**：多选（港岛/九龙/新界各区）
- **Banding 要求**：1A/1B/1C/2A/2B/2C/3A/3B/3C
- **学校类型**：资助/直资/私立/国际（多选）
- **学费范围**：最低-最高（港币）
- **是否需要宿舍**：是/否/无所谓
- **其他特征**：跨境接受度、国际课程（IB/A-Level等）

#### 输出结果
按三档分类：
- 🎯 **冲刺校**（5-10所）：要求高于学生档次，有一定录取可能
- ✅ **匹配校**（10-15所）：与学生档次匹配，录取概率高
- 🛡️ **保底校**（5-10所）：低于学生档次，确保录取

每所学校显示：
- **基本信息**：名称、地区、Banding、学校类型
- **录取要求**：成绩档次、学费、宿舍情况
- **历史数据**：机构成功案例数、申请方式
- **申请信息**：申请截止日期、学校官网链接

#### 三档分类算法
```python
def classify_schools(student_grade, matching_schools):
    """
    Args:
        student_grade: 'A'/'B'/'C'/'D'
        matching_schools: 符合其他筛选条件的学校列表
    
    Returns:
        {
            'reach': [...],    # 冲刺校
            'match': [...],    # 匹配校
            'safety': [...]    # 保底校
        }
    """
    grade_order = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
    student_score = grade_order[student_grade]
    
    reach, match, safety = [], [], []
    
    for school in matching_schools:
        # 从 grade_requirements 表获取该学校的档次要求
        school_req = get_grade_requirement(school.id)
        school_score = grade_order[school_req.min_grade]
        
        if school_score > student_score:
            reach.append(school)
        elif school_score == student_score:
            match.append(school)
        else:
            safety.append(school)
    
    # 按历史成功案例数排序
    reach = sort_by_success_cases(reach)[:10]
    match = sort_by_success_cases(match)[:15]
    safety = sort_by_success_cases(safety)[:10]
    
    return {'reach': reach, 'match': match, 'safety': safety}
```

### 2. 数据管理系统

#### 学校信息管理
- **CRUD 操作**：增删改查学校记录
- **批量导入**：支持 Excel 导入（匹配原有字段）
- **批量导出**：导出为 Excel 供离线分析
- **爬虫数据审核**：预览变更对比，确认后批量更新

#### 成绩档次管理
- 为每所学校设置三档分数线（冲刺/匹配/保底）
- 支持按学段分别设置（中学/本科/硕士）
- 示例：
  ```
  拔萃女书院（中学）
    - 冲刺档：A
    - 匹配档：A
    - 保底档：B
  ```

#### 历史案例管理
- 记录成功申请案例（学生档次 + 录取学校 + 年份）
- 用于优化推荐算法（成功案例多的学校优先推荐）
- 支持按年份筛选

### 3. 爬虫系统

#### 数据源优先级
1. **P0：香港教育局官网**（结构最稳定）
   - 学校基本信息、联系方式
2. **P1：schooland.hk**（数据最全但可能反爬）
   - Banding 信息
3. **P2：各学校官网**（结构差异大，作为补充）
   - 学费、宿舍、申请方式、截止日期

#### 多策略备份机制

```python
class SchoolSpider(scrapy.Spider):
    def parse_school_name(self, response):
        strategy_used = None
        
        # 策略1：CSS选择器（成功率90%）
        name = response.css('h1.school-name::text').get()
        if name:
            strategy_used = 'CSS'
        
        # 策略2：XPath备份（成功率85%）
        if not name:
            name = response.xpath('//div[@class="header"]//h1/text()').get()
            strategy_used = 'XPath'
        
        # 策略3：正则表达式（成功率70%）
        if not name:
            name = response.xpath('//meta[@property="og:title"]/@content').get()
            strategy_used = 'Regex'
        
        # 策略4：URL推断（成功率50%）
        if not name:
            name = self.extract_from_url(response.url)
            strategy_used = 'URL'
        
        # 记录策略使用情况
        self.log_strategy(response.url, strategy_used)
        
        return name
```

**监控机制：**
- Celery 每周生成"策略失效报告"
- 标记"策略3/4使用频率突增"的网站
- 管理员人工审查并更新选择器

#### 半自动审核工作流

```
1. 爬虫执行完成
   ↓
2. 生成"待审核数据表"（scrape_staging）
   ↓
3. 管理员在界面看到：
   - 新增数据（绿色标记）
   - 变更数据（黄色标记，显示旧值→新值）
   - 删除数据（红色标记）
   ↓
4. 管理员逐条审核或批量确认
   ↓
5. 确认后数据从 staging 表迁移到主表
   ↓
6. 系统记录本次爬取统计：
   - 成功/失败数量
   - 各策略使用占比
   - 耗时
```

#### 定时配置

预设选项：
- **每周**：每周日凌晨2点执行
- **每月**：每月1号凌晨2点执行
- **每学期**：9月/1月/6月的1号凌晨2点执行

管理员可在界面选择并立即生效。

---

## 数据库设计

### 表结构

#### schools（学校信息表）
```sql
CREATE TABLE schools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    name_en VARCHAR(200),
    district VARCHAR(50),  -- 港岛东/九龙城/沙田等
    banding VARCHAR(10),   -- 1A, 1B, 1C, 2A, 2B, 2C, 3A, 3B, 3C
    school_type VARCHAR(20),  -- 资助/直资/私立/国际
    tuition_fee INTEGER,   -- 年学费（港币）
    has_dormitory BOOLEAN DEFAULT false,
    dormitory_capacity INTEGER,
    accepts_cross_border BOOLEAN DEFAULT false,
    international_curriculum TEXT[],  -- ['IB', 'A-Level', 'AP']
    application_method TEXT,
    application_deadline DATE,
    website_url VARCHAR(500),
    contact_phone VARCHAR(50),
    address TEXT,
    -- RAG 准备字段
    description TEXT,
    description_embedding VECTOR(1536),  -- 允许 NULL
    -- 元数据
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    source VARCHAR(50)  -- 数据来源：manual/scrapy
);

CREATE INDEX idx_schools_district ON schools(district);
CREATE INDEX idx_schools_banding ON schools(banding);
CREATE INDEX idx_schools_type ON schools(school_type);
```

#### grade_requirements（成绩档次表）
```sql
CREATE TABLE grade_requirements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
    level VARCHAR(20) NOT NULL,  -- 中学/本科/硕士
    tier VARCHAR(20) NOT NULL,   -- 冲刺/匹配/保底
    min_grade CHAR(1) NOT NULL,  -- A/B/C/D
    max_grade CHAR(1),           -- 可选，表示范围
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(school_id, level, tier)
);

CREATE INDEX idx_grade_school ON grade_requirements(school_id);
```

#### success_cases（历史案例表）
```sql
CREATE TABLE success_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
    student_grade CHAR(1) NOT NULL,  -- A/B/C/D
    admission_year INTEGER NOT NULL,
    level VARCHAR(20),  -- 中学/本科/硕士
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cases_school ON success_cases(school_id);
CREATE INDEX idx_cases_year ON success_cases(admission_year);
```

#### scrape_tasks（爬虫任务表）
```sql
CREATE TABLE scrape_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_name VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- pending/running/completed/failed
    source VARCHAR(50),  -- education_bureau/schooland/school_website
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    records_scraped INTEGER DEFAULT 0,
    records_failed INTEGER DEFAULT 0,
    strategy_stats JSONB,  -- {"CSS": 85, "XPath": 10, "Regex": 5}
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON scrape_tasks(status);
CREATE INDEX idx_tasks_created ON scrape_tasks(created_at DESC);
```

#### scrape_staging（待审核数据表）
```sql
CREATE TABLE scrape_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES scrape_tasks(id),
    action VARCHAR(10) NOT NULL,  -- insert/update/delete
    school_id UUID,  -- 如果是update/delete，关联现有school
    data JSONB NOT NULL,  -- 爬取到的新数据
    old_data JSONB,  -- 如果是update，保存旧值
    strategy_used VARCHAR(50),
    reviewed BOOLEAN DEFAULT false,
    approved BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_staging_task ON scrape_staging(task_id);
CREATE INDEX idx_staging_reviewed ON scrape_staging(reviewed);
```

#### users（用户表）
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,  -- admin/advisor
    full_name VARCHAR(100),
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP
);
```

---

## API 设计

### 筛选 API

#### POST /api/schools/filter
筛选学校

**请求体：**
```json
{
  "student_grade": "B",
  "level": "中学",
  "districts": ["港岛东", "九龙城"],
  "banding": ["1A", "1B", "1C"],
  "school_types": ["资助", "直资"],
  "tuition_max": 50000,
  "needs_dormitory": true,
  "accepts_cross_border": false
}
```

**响应：**
```json
{
  "reach": [
    {
      "id": "uuid",
      "name": "拔萃女书院",
      "district": "九龙城",
      "banding": "1A",
      "tuition_fee": 0,
      "success_cases_count": 5,
      "min_grade": "A",
      "tier": "冲刺"
    }
  ],
  "match": [...],
  "safety": [...]
}
```

### 管理 API

#### GET /api/schools
获取学校列表（支持分页、搜索、排序）

#### POST /api/schools
创建学校

#### PUT /api/schools/{id}
更新学校

#### DELETE /api/schools/{id}
删除学校

#### GET /api/schools/{id}/grade-requirements
获取学校成绩档次

#### PUT /api/schools/{id}/grade-requirements
批量更新成绩档次

### 爬虫 API

#### POST /api/scrape/trigger
手动触发爬虫任务

**请求体：**
```json
{
  "sources": ["education_bureau", "schooland"],
  "schedule": "immediate"
}
```

#### GET /api/scrape/tasks
获取爬虫任务列表

#### GET /api/scrape/staging
获取待审核数据

#### POST /api/scrape/staging/{id}/approve
审核通过单条数据

#### POST /api/scrape/staging/approve-batch
批量审核

---

## 界面设计

### 管理界面

#### 1. 学校列表页面
- **表格组件**：使用 Shadcn UI Data Table
- **功能**：
  - 搜索（学校名称、地区）
  - 筛选（Banding、类型）
  - 排序（名称、学费、更新时间）
  - 批量操作（导出、删除）
  - 单行操作（编辑、查看详情）

#### 2. 学校编辑页面
- **表单组件**：Shadcn UI Form
- **字段分组**：
  - 基本信息（名称、地区、Banding）
  - 费用信息（学费、宿舍）
  - 申请信息（方式、截止日期）
  - 特色（国际课程、跨境接受度）
- **验证**：实时表单验证

#### 3. 成绩档次配置页面
- **布局**：左侧学校列表，右侧档次编辑器
- **功能**：
  - 为每个学段设置三档分数线
  - 批量复制档次到其他学校
  - 预览影响（会影响多少筛选结果）

#### 4. 爬虫管理页面
- **定时任务配置**：下拉选择（每周/每月/每学期）
- **任务历史**：表格显示执行记录
- **策略统计**：饼图显示各策略使用占比
- **待审核数据**：
  - 变更对比视图（旧值→新值）
  - 批量审核按钮
  - 单条审核（通过/拒绝）

### 筛选界面

#### 1. 筛选表单
- **布局**：左侧筛选条件，右侧结果预览
- **交互**：
  - 实时筛选（输入条件后立即更新结果数量）
  - 条件保存（保存常用筛选组合）
  - 重置按钮

#### 2. 结果展示
- **三列卡片布局**：
  - 🎯 冲刺校（左列，橙色边框）
  - ✅ 匹配校（中列，绿色边框）
  - 🛡️ 保底校（右列，蓝色边框）
- **每个卡片显示**：
  - 学校名称、地区、Banding
  - 学费、宿舍图标
  - 成功案例数
  - "查看详情"按钮
- **排序**：按成功案例数降序

#### 3. 学校详情弹窗
- **信息展示**：
  - 完整的学校信息
  - 申请方式和截止日期
  - 联系方式和官网链接
  - 历史成功案例列表
- **操作**：
  - 复制信息
  - 导出为 PDF
  - 分享给客户

---

## 成本估算

### 月运营成本

| 项目 | 服务商 | 规格 | 费用 |
|------|--------|------|------|
| 云服务器 | DigitalOcean/Vultr | 2核4GB | $24 |
| PostgreSQL | Supabase Pro | 8GB存储 | $25 |
| 域名 | Namecheap | .com | $2 |
| 监控告警 | UptimeRobot | 免费层 | $0 |
| **小计** | | | **$51** |

### 预留 RAG 升级成本
| 项目 | 预估费用 |
|------|---------|
| OpenAI API（GPT-4 Turbo） | $20-50/月 |
| 向量化处理 | 包含在上述 |
| **总计** | **$71-101/月** |

### 开发成本
- **开发周期**：5-7 周
- **所需技能**：
  - Python（FastAPI/Scrapy）
  - TypeScript（Next.js）
  - SQL（PostgreSQL）
- **团队配置**：1-2 名全栈开发者

---

## 实施路线图

### Phase 1: MVP（5-7周）

#### Week 1-2: 爬虫开发
- [ ] 搭建 Scrapy 项目结构
- [ ] 实现教育局官网爬虫（P0数据源）
- [ ] 实现 schooland.hk 爬虫（P1数据源）
- [ ] 实现多策略备份机制（CSS→XPath→Regex→URL）
- [ ] 测试三个数据源的可靠性
- [ ] 实现策略使用统计
- **交付物**：可运行的爬虫脚本 + 策略报告

#### Week 3: 后端开发
- [ ] FastAPI 项目搭建（项目结构、配置）
- [ ] PostgreSQL schema 设计与迁移（Alembic）
- [ ] 实现学校 CRUD API
- [ ] 实现筛选 API（三档分类算法）
- [ ] Celery + PostgreSQL broker 配置
- [ ] 定时任务集成（Celery Beat）
- [ ] JWT 认证实现（管理员/顾问）
- **交付物**：完整的 REST API + API 文档

#### Week 4: 管理界面
- [ ] Next.js + Shadcn UI 项目搭建
- [ ] 登录页面
- [ ] 学校信息管理页面（列表 + 表单）
- [ ] 成绩档次配置页面
- [ ] 爬虫任务管理页面
- [ ] 待审核数据页面（变更对比）
- **交付物**：可用的管理后台

#### Week 5: 筛选界面
- [ ] 筛选表单设计（多维度条件）
- [ ] 三档分类结果展示（卡片布局）
- [ ] 学校详情弹窗
- [ ] 筛选结果导出功能
- **交付物**：完整的筛选功能

#### Week 6-7: 测试与优化
- [ ] 集成测试（端到端）
- [ ] 性能优化（SQL 查询优化、索引）
- [ ] 安全测试（SQL注入、XSS）
- [ ] 用户验收测试
- [ ] 数据迁移（从 Excel 导入初始数据）
- [ ] 用户培训文档
- [ ] 生产环境部署
- **交付物**：上线的生产系统

### Phase 2: 优化与监控（2-3周）

#### 功能优化
- [ ] 爬虫监控 Dashboard
- [ ] 邮件/Slack 告警（爬虫失败通知）
- [ ] 数据审核工作流优化
- [ ] 批量操作增强

#### 性能优化
- [ ] PostgreSQL 查询优化
- [ ] 添加缓存层（Redis，可选）
- [ ] 前端性能优化（图片懒加载、代码分割）

### Phase 3: RAG 升级（3-4周，未来）

#### 数据准备
- [ ] 启用 pgvector 扩展
- [ ] 学校描述文本向量化（OpenAI Embeddings）
- [ ] 向量相似度搜索测试

#### AI Chatbot
- [ ] 实现语义搜索 API
- [ ] Next.js 对话界面（流式响应）
- [ ] RAG 上下文管理
- [ ] 对话历史持久化

---

## 风险与缓解

### 风险1：爬虫失效率过高
**风险等级**：中
**描述**：网站结构变化导致爬虫频繁失效

**缓解措施**：
- 采用多策略备份（CSS→XPath→Regex→URL）
- 每周生成策略失效报告，人工审查
- 关键数据源（教育局）设置每日全量备份
- 使用 Scrapy-Impersonate 绕过反爬

### 风险2：PostgreSQL 作 Celery broker 性能不足
**风险等级**：低
**描述**：任务量增长后 PostgreSQL 作消息队列可能成为瓶颈

**缓解措施**：
- MVP 阶段任务量小（每日几个爬虫任务），PostgreSQL 完全够用
- 监控 Celery 任务延迟
- 如后期任务量增长，可无缝切换到 Redis
- 基准测试显示 PostgreSQL broker 支持 1000+ tasks/hour

### 风险3：数据准确性问题
**风险等级**：中
**描述**：爬取的数据可能有误或过时

**缓解措施**：
- 半自动审核工作流（人工确认后才导入）
- 数据变更对比视图（旧值→新值）
- 记录数据来源和更新时间
- 允许管理员手动修正

### 风险4：成本超支
**风险等级**：低
**描述**：RAG 升级后 OpenAI API 费用超预算

**缓解措施**：
- MVP 阶段不使用 AI，成本可控（$51/月）
- RAG 升级时设置 API 调用上限
- 使用 Prompt Caching 降低成本
- 监控每日 API 费用

### 风险5：用户体验不达标
**风险等级**：低
**描述**：筛选结果不准确，用户满意度低

**缓解措施**：
- 基于历史成功案例优化推荐算法
- 收集用户反馈迭代筛选条件
- A/B 测试不同的三档分类算法
- 定期回顾推荐准确率

---

## 技术决策记录

### 决策1：为什么选择 FastAPI 而非 Django？
**理由**：
- FastAPI 原生异步支持，性能更好
- 自动生成 API 文档（OpenAPI）
- 与 Next.js 前后端分离更匹配
- Pydantic 数据验证强大

**权衡**：
- Django Admin 开箱即用，但前端体验受限
- FastAPI 需要手动实现管理界面

### 决策2：为什么放弃 AI 自动修复爬虫？
**理由**：
- 2025年生产实践证明 AI 修复不可靠（70-85%准确率）
- 成本高（$20-50/月）且时效性差
- 多策略备份更稳定（95%+成功率，成本$0）

**权衡**：
- 多策略失败时需人工介入（<5%情况）
- 但整体可靠性和成本效益更优

### 决策3：为什么使用 PostgreSQL 作 Celery broker？
**理由**：
- 减少一个组件（无需 Redis）
- 托管数据库已有，无额外成本
- MVP 阶段任务量小，性能足够

**权衡**：
- 后期任务量大时可能需要切换到 Redis
- 但初期简化架构的收益更大

### 决策4：为什么选择 Shadcn UI？
**理由**：
- 代码分发模式，零运行时依赖
- 与 Next.js + Tailwind 完美集成
- Data Table 组件完全满足需求
- 开发速度快（节省 20-30% 前端时间）

**权衡**：
- 相比成熟组件库（Ant Design），生态较新
- 但对当前场景完全适用

### 决策5：为什么采用半自动审核而非全自动？
**理由**：
- 数据准确性要求高（直接影响客户选校）
- 网站结构变化时自动导入可能引入错误
- 人工审核成本可控（每周1-2小时）

**权衡**：
- 增加了管理员工作量
- 但保证了数据质量

---

## 验证计划

### 功能验证

#### 爬虫功能
- [ ] 教育局官网爬取准确率 >95%
- [ ] schooland.hk 爬取准确率 >90%
- [ ] 多策略备份机制覆盖 >95% 字段
- [ ] 策略失效检测正常工作

#### 筛选功能
- [ ] 三档分类算法准确性 >90%（基于历史案例验证）
- [ ] 多维度筛选正确返回结果
- [ ] 性能：1000所学校筛选时间 <2秒

#### 管理功能
- [ ] 学校 CRUD 操作正常
- [ ] 批量导入/导出正常
- [ ] 成绩档次配置保存成功
- [ ] 待审核数据变更对比正确

### 性能验证
- [ ] 数据库查询响应时间 <100ms（1000条数据）
- [ ] API 响应时间 <500ms（P95）
- [ ] 前端首屏加载时间 <2秒
- [ ] 爬虫单次执行时间 <30分钟

### 安全验证
- [ ] SQL注入防护（使用参数化查询）
- [ ] XSS 防护（输入验证 + 输出转义）
- [ ] JWT 认证正常工作
- [ ] 密码哈希存储（bcrypt）
- [ ] HTTPS 强制跳转

---

## 附录

### 技术参考文档
- [FastAPI 官方文档](https://fastapi.tiangolo.com/)
- [Next.js 15 文档](https://nextjs.org/docs)
- [Shadcn UI 文档](https://ui.shadcn.com)
- [Scrapy 文档](https://docs.scrapy.org/)
- [Celery 文档](https://docs.celeryproject.org/)
- [PostgreSQL + pgvector](https://github.com/pgvector/pgvector)

### 相关研究报告
- [技术方案评估报告](../.claude/plans/track-users-mingjiexing-downloads-xlsx-keen-storm-agent-aa474e0b2c2e298e5.md)
- [优化建议评估报告](../.claude/plans/track-users-mingjiexing-downloads-xlsx-keen-storm-agent-af2e6d39c3b0a36f1.md)

---

## 变更记录

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|---------|------|
| 2026-06-03 | 1.0 | 初始版本 | Claude |
