# LOCAL-03 Identity Mode Implementation Record

| Control | Value |
|---|---|
| Date | 2026-08-18 |
| Status | `local_identity_runtime_validated` |
| Scope | 服务端身份模式开关、本地角色登录、opaque session、Cognito 普通登录边界 |
| Data | 固定 UUID 的合成组织和角色；没有真实用户资料 |
| External action | 无 AWS/Cognito 建立或部署操作；代码提交与推送按用户确认另行执行 |

## 结果

新增服务端 `AUTH_MODE=local-synthetic|cognito`。本地模式只允许搭配非生产
`APP_RUNTIME_MODE=local-synthetic`；模式缺失、值无效或生产环境启用本地身份时
fail closed。该变量不向浏览器公开，切换后必须重启 Next.js。

`local-synthetic` 登录页提供 Founder、Admin、Advisor、Data reviewer 和 Contractor
五个确定性角色。登录生成随机 32-byte opaque secret，浏览器只保存 HttpOnly、
SameSite=Lax session cookie；统一 `IdentityRuntime` 负责验证、敏感操作再认证时限和登出
撤销。同一角色再次登录会替换旧的本地会话。

`cognito` 模式隐藏本地表单，使用现有 PKCE authorize flow。普通回访登录不再错误地
依赖 pending invite activation cookie；成功交换并验证 Cognito token 后，仍由
PostgreSQL `identity_sessions` 保存应用会话。登出同时撤销应用会话并跳转 Cognito
managed logout endpoint。

## 已执行验证

- 12 项身份、Cognito、模式保护和本地会话定向测试通过；连同 11 项架构边界测试共 23 项；
- Founder 登录返回 HTTP 303 和 HttpOnly `tx_session`；
- 携带 Cookie 调用 `/api/v1/auth/me` 返回 HTTP 200、固定 organization 和 founder role；
- 浏览器实际登录后进入 `/today`；
- `1440x900` 与 `390x844` 页面无横向溢出，登录控件完整可见。

## 剩余 Gate

本记录交付时，本地身份仓库仍是进程内适配器。该 Gate 已由
`LOCAL-04_IDENTITY_POSTGRESQL.md` 关闭：合成组织、用户、membership、role binding
和本地 session 已迁入 PostgreSQL，Session 已验证可跨 Next.js 进程重启。
真实 Cognito 仍需要已批准的 User Pool/App Client/domain、香港 RDS 连接、加密密钥和
生产 composition root。首次邀请激活依赖的正式 Cognito verifier/repository 尚未装配，
在完成该 Gate 前会返回 service unavailable，不会降级到本地身份。
