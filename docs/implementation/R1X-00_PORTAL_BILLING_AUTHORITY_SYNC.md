# R1X-00 Portal/Billing Authority Synchronization

| Control | Value |
| --- | --- |
| Ticket | `R1X-00` Portal/Billing scope and architecture authority are synchronized |
| Date | 2026-08-11 (Asia/Hong_Kong) |
| Run ID | `R1-AWS-PORTAL-BILLING-20260811-v1` |
| Local status | `authority_synchronized` |
| Accepted authority | `DEC-064`, `DEC-065`, `DEC-066` |
| Open gates | `DP-01` through `DP-12`; `DEC-060` |
| External state | No migration execution, database write, cloud action, invite, notice delivery, commit, push, deploy, DNS, Vercel change or release-state change |

## Problem, Scope And Stakeholders

Release 1 previously carried contradictory authority: the PRD expressed a customer read-only outcome while the decision ledger and Phase 3/4 plans excluded parent portal and finance. The user approved adding a bounded External Portal and aggregate-only PlatformBilling surface. This ticket makes that scope durable without treating unresolved authorization, expiry, pricing, retention, subscription or delivery semantics as approved.

In scope is authority documentation, stable decision IDs, dependency mapping and the two approved database/audit architecture boundaries. Feature code, migrations, production adapters, cloud resources and all external actions are out of scope.

## Decisions And Enforcement Owners

- `DEC-064` assigns single-case, read-only external access to `ExternalPortalAccess` and aggregate contract/metric/charge-notice drafts to `PlatformBilling`. Open DP behavior fails closed.
- `DEC-065` assigns pre-tenant secret discovery to a dedicated `portal_auth` role that may execute only a hardened `SECURITY DEFINER` keyed-hash equality lookup. It has no table access, ownership or `BYPASSRLS`; full authorization occurs in a later tenant-scoped transaction.
- `DEC-066` assigns PlatformOperator audit to a separate append-only Platform Control aggregate. Tenant audit organization/actor invariants remain unchanged, and neither database role may use the audit path to read the other plane's detail tables.

## Dependency And Failure Contract

`R1X-00` is complete because scope and architecture authority are now synchronized. It does not unlock semantics by implication:

- `R1X-01` waits for `DP-01` through `DP-05` and `DP-10`.
- `R1X-05` waits for `DP-06` through `DP-08` and `DP-10`.
- `R1X-09` through `R1X-12` preserve `DP-09` through `DP-12`, `DEC-060`, existing Phase 3 evidence and exact production approvals.
- Completion of `R1X-11` does not authorize first use: the first portal grant and the first charge notice each require a separate exact-payload human go/no-go naming the organization/case or billing month, actor, policy version, expiry/cutoff and rollback/revoke owner as applicable.

Missing decisions must produce a planning/runtime unavailable or policy-denied state owned by the dependent ticket. Schema defaults, UI copy, fakes and configuration may not invent a baseline.

## Evidence And Residual Risk

Authority evidence is the independently reviewed current content across `PRD.md`, `docs/PRD_IMPLEMENTATION_DECISIONS.md`, `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md`, `docs/PHASE3_EMPTY_TENANT_PILOT_REVISION_PLAN.md` and `docs/IMPLEMENTATION_PLAN_AWS_HK_RELEASE1_PORTAL_BILLING.md`. Deterministic checks verified balanced code fences, consistent Markdown table widths, 66 contiguous DEC IDs with the documented status counts, and 13 unique R1X ticket IDs. The standards review found no actionable contradiction; the spec review's first-use-gate omission was corrected in this record. The backlog now contains 85 templates without renumbering existing P3 evidence identities.

The code-level decision registry still ends at `DEC-060` and retains pre-amendment statuses for `DEC-033`/`DEC-054`; updating it to current durable authority is a required TDD change before an R1X module calls `assertDecisionPremise("DEC-064")`. This documentation-only ticket does not silently widen the P0-01 source contract.

`pnpm lint` and `pnpm build` were not run because repository rules require separate user authorization and this ticket changes no runtime code.
