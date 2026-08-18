# P2-15 组织展示配置实现计划

| Control | Value |
| --- | --- |
| Ticket | `P2-15` Organization presentation configuration replaces fixed dates, preview authority and duplicated labels |
| Status | `planned_after_P2-14` |
| Decision | `DEC-069` |

## 目标与边界

用权威 organization timezone/locale、版本化 presentation catalogue 和真实 dashboard read model 替换页面中
固定的 2026-08 日期过滤、preview 权威数据及重复的 role/stage/admission/assessment label。

字段 label 由对应 schema manifest 或 catalogue owner 提供；展示配置只能改变呈现，不能改变状态机、
capability、资源可见范围、数据库事实或错误语义。品牌白标不属于 Release 1 的授权范围。

## 验收

- Today 使用 organization timezone 的当前日期和真实 API，不包含固定月份或 preview authoritative adapter。
- Navigation、Dashboard、SchoolTarget、Assessment 和 crawler 复用受控 label key，未知 key 安全显示且可观测。
- locale/timezone 缺失使用经过批准的 organization default，不读取浏览器值作为业务日期真相。
- 桌面、390px、键盘、长文本、空数据、加载、失败和权限不足状态均有验证。
- presentation catalogue 回滚不会改写历史业务数据，也不会扩大页面或 API 权限。
