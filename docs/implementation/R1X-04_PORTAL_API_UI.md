# R1X-04 Portal API/UI

| Field | Value |
| --- | --- |
| Run ID | `R1X-04-PORTAL-API-UI-20260813` |
| Status | Local bounded vertical slice implemented |
| Authority | Approved DP-01 through DP-05 baseline and R1X-01/R1X-02_03 contracts |

## Implemented Boundary

- `/portal/**` bypasses the internal AppFrame, internal session check, sidebar, and top bar.
- Public access redemption creates a separate `__Host-tx_portal_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/` so both Portal pages and `/api/v1/portal/**` receive it.
- Public credential-state failures use the generic `PORTAL_ACCESS_INVALID` response. Access keys are accepted only in request bodies and are not placed in URLs, browser storage, logs, or response bodies.
- Workspace reads rebuild the exact `portal_case_read_v1` DTO and return `private, no-store`; documents, downloads, exports, edits, and internal navigation are absent.
- Logout revokes through the runtime seam when available and clears the separate Portal cookie.
- Logout clears the browser cookie even when server-side revocation is unavailable; the response remains a typed `503` so the failed server-side cleanup is observable.
- The already implemented internal case access surface supports list, issue, revoke, and rotate with idempotency keys and optimistic versions. Issue and rotate return the raw secret once. Every cookie-authenticated mutation requires an explicit same-origin `Origin` header before authentication, while exported revoke and rotate handlers reuse the collection route's Identity session seam.
- Production defaults fail closed with `PORTAL_RUNTIME_UNAVAILABLE`; there is no fake, direct database, Neon, or in-memory production fallback.

## Evidence And Remaining Gates

Focused Node tests cover internal mutation envelopes, one-time secret responses, generic public authentication failures including the fourth-session limit, cookie attributes and failure-path clearing, trusted-origin rejection before authentication, workspace allowlisting/no-store, UI states, and AppFrame exclusion.

This slice does not claim a production RDS adapter, live migration/RLS/concurrency evidence, rate-limit infrastructure, browser/a11y evidence, Docker build, deployment, or production readiness. `pnpm lint` and `pnpm build` were prohibited and not run. No database, migration, network, cloud, Git index, commit, push, or deployment action was performed.
