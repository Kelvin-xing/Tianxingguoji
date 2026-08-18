# P2-14 类型化运行配置实现计划

| Control | Value |
| --- | --- |
| Ticket | `P2-14` Typed runtime configuration removes scattered operational constants |
| Status | `planned_after_P2-13` |
| Decision | `DEC-069` |

## 目标与边界

建立一个经过 schema 校验的 server-only `RuntimeConfig` composition root，收口目前散落的 session/invite
时长、API timeout、重试次数、upload intent TTL、object-store region/bucket 和 organization default
timezone。领域服务只接收类型化 policy object，不直接读取 `process.env`。

安全上限、香港驻留、production/local 模式互斥和 fail-closed 规则仍由代码约束，不能通过环境值放宽。
Secret value 只保存在受管 secret/config source，不进入 Git、错误响应、日志或浏览器 bundle。

## 验收

- 每个设置登记 owner、source、type/range、default policy、reload/restart 和 redaction 规则。
- production 必填项缺失或非法时阻止启动；local synthetic default 必须显式且不能进入 production。
- session cookie 与服务端 absolute timeout 使用同一经过校验的 policy，避免双份常量漂移。
- storage region 不再由 Documents Service 写死；超时和重试有上下限与聚焦测试。
- 默认配置下行为与迁移前一致；不运行云端或 production 配置变更。
