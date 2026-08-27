# R1X-01 External Portal Core Contract

| Attribute | Value |
| --- | --- |
| Run ID | `R1X-01-PORTAL-CORE-20260813` |
| Date | 2026-08-13 (Asia/Hong_Kong) |
| Repository | `erp-frontend/` |
| Status | `passed` for the pure-logic slice only |
| Binding business decisions | `txgj-doc/business-requirements/80-portal-billing.zh-CN.md`, confirmed `BR-060` |

## Outcome And Scope

This slice establishes the smallest fail-closed `ExternalPortalAccess` contract and policy seam needed by later repository and route tickets. It covers grant actor authorization, grant duration, request-time effective access, the `portal_case_read_v1` positive field allowlist, bounded session expiry, and stable internal/public error contracts.

It does not implement a database, migrations, RLS, transactions, repositories, routes, UI, secrets, hashes, cookies, rate limiting, runtime composition, audit/outbox effects, or production activation. No shared registry or package file changed.

## Model And Invariants

- One grant is scoped to one organization and one case. Cross-organization or cross-case access is denied.
- Only an active same-organization Founder or the case's current active Primary Advisor is authorized. Inactive users, memberships, role bindings, cases, and viewer relationships deny. There is no fallback for an absent Primary Advisor.
- `expires_at` is required, later than authoritative server `now`, no more than seven days later, and no later than an optional case access horizon. Renewal is outside this slice and cannot mutate expiry through this API.
- Effective access is recalculated from supplied current facts. Revoked/expired/non-active grants, expired/revoked sessions, inactive viewer relationships, ended cases, unauthorized issuers, inactive organizations, and scope mismatches deny immediately. `past_due` is intentionally not an authorization predicate.
- Capability `portal_case_read_v1` selects only approved case, visible school-target, customer action-item, and customer-visible message fields. Documents, downloads, export, comments, edits, and deletes are explicitly denied. Unknown capability versions fail closed.
- A grant supports at most three active sessions. Session idle expiry is 15 minutes and absolute expiry is the earlier of eight hours or grant expiry.
- Internal failures retain stable typed codes. Public secret, grant-state, and session-state credential failures map to the same generic `401` response to prevent grant enumeration. Scope, relationship, issuer, and organization authorization denials remain generic `403` responses.

## Enforcement Ownership

`modules/external-portal/domain/contract.ts` owns constants, typed inputs, validation, errors, and public response shapes. `modules/external-portal/domain/policy.ts` owns pure authorization, effective-state, allowlist projection, session-bound, and public-error decisions.

A future tenant-scoped Portal repository remains responsible for fetching actor, case, viewer, organization, grant, and session facts in one transaction and atomically allocating session slots. This pure-logic slice does not claim concurrency, RLS, secret storage, audit, idempotency, or transaction guarantees.

## Risks And Controls

| Risk | Current control | Remaining owner |
| --- | --- | --- |
| Stale authorization facts | Policy requires request-time facts and defaults unknown states to rejection | R1X-02/R1X-03 repository transaction |
| Concurrent fourth session | Pure policy rejects count `>= 3` | Repository lock/constraint and concurrency test |
| DTO field drift | Named-field constructor and pinned capability version | Source-module adapters and response tests |
| Credential enumeration | Constant-shape public `401` mapping | Route, timing, and rate-limit implementation |
| Secret or cookie leakage | No secret/cookie implementation exists in this slice | R1X-02/R1X-03 security implementation |

## Deterministic Evidence

Command:

```text
timeout 30 node --test tests/unit/portal/contract-policy.test.ts
```

Result after the bounded counterexample correction: exit `0`; 7 tests passed, 0 failed, 0 skipped, 0 cancelled. The public-error test exhaustively groups invalid secret, inactive/expired/revoked grant, and invalid/expired session failures into one generic `401`, while separately asserting authorization denials remain `403`.

`pnpm lint` and `pnpm build` were not run because repository instructions and task scope prohibit them. No network, cloud, database, migration, commit, or push action was performed.
