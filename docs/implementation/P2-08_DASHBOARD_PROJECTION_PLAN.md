# P2-08 Permission-Shaped Case Dashboard Projection

| Control | Value |
| --- | --- |
| Ticket | `P2-08` Dashboard projection is rebuildable and permission-shaped |
| Date | 2026-08-10 (Asia/Hong_Kong) |
| Run identifier | `p2-08-dashboard-projection-20260810` |
| Decision inputs | `P2-03`, `P2-04`, `DEC-001`, `DEC-052`, `DEC-055`, `DEC-057` |
| External state | No migration, RDS/Neon write, cloud/network call, real data access, commit, push, deployment, deletion, or release action is authorized |

## Problem, Stakeholders, And Boundary

Founder and Advisors need a compact operational view that does not require
opening each Case. A bounded CaseCollaborator needs only the dashboard sections
covered by current grants. Families, privacy/security owners, and Operations
need a stale or over-broad projection to be incapable of granting access.

In scope: a versioned C-class Case dashboard projection, deterministic rebuild
and hash comparison, request-time permission shaping, a fail-closed HK RDS
runtime seam, one authenticated API, and compact loading/empty/error/denied UI.

Out of scope: a migration or physical projection table, production rebuild job,
projection activation/swap, contractor dashboard access, admin/data-reviewer
semantics, export, sensitive identity/contact or internal-note fields, Case
writes, crawler data, alerts, performance execution, and any live adapter.

## Source Facts, State, And Ownership

The source snapshot is `case_dashboard_source_v1`: one organization, a stable
source snapshot identifier, capture time, and authoritative Case-derived facts.
Each input Case has immutable Case ID, display Case number, student display
label, canonical stage, blocker count, next action/due time, education-profile
completeness, SchoolTarget count, open Task count, and unread communication
count. Input validation rejects cross-organization, duplicate Case IDs, invalid
counts/times, or unsupported versions.

`case_dashboard_projection_v1` is C-class and owned by AuditOperations. It can
be dropped without authority or A/B fact loss. CaseWorkflow, CRM, Task, and
TenantAccess remain owners of their source facts. The projection stores no
grant, role binding, contact details, internal notes, document bytes, export
material, or authorization decision.

State is `absent -> built -> active/stale -> dropped -> rebuilt`. Activation and
storage are intentionally not implemented. A rebuilt projection for the same
canonical source snapshot/version must have the same SHA-256 content hash as a
live build, independent of input Case ordering.

## Request-Time Authority And Disclosure Matrix

The repository is the enforcement owner for one read-only HK RDS transaction.
It must re-read active organization membership, current role binding, current
Case assignments/collaborations/grants and current time while reading the
projection. It returns a transaction-local projection plus authority facts;
the service never accepts browser-supplied organization, assignment, scope,
capability, expiry, or projection rows.

| Authority fact | Visible Cases | Visible sections |
| --- | --- | --- |
| Founder | Every Case in actor organization | Summary, education profile, SchoolTargets, Tasks, communications |
| Assigned Advisor | Only currently assigned Case IDs | Same operational sections as Founder |
| CaseCollaborator | Only Cases with at least one current active `view`, `comment`, or `edit` grant | Only mapped granted scopes: `case_summary`, `education_profile`, `school_targets`, `task_workspace`, `communications` |
| Contractor, admin, data reviewer, inactive/unknown | None | Denied; no count, Case ID, label, hash, or stale metadata |

`identity_contact` and `internal_notes` are never dashboard fields even when a
sensitive grant exists. Export is absent from the DTO and cannot be inferred
from any capability. Revoked, pending, not-yet-started, expired, cross-case, or
cross-organization grants do not shape output. Grant expiry is checked with the
transaction timestamp on every request.

## Rebuild, Concurrency, And Failure Contract

Canonical hashing sorts Cases by stable Case ID and hashes the projection
schema version, source version/ID/time, organization, and exact derived rows.
The rebuild uses the same pure builder as the live path. A hash mismatch means
`stale`/`needs_human`; it never updates authority or silently activates output.

A stale projection may still be shaped only after current authorization, but
the API marks it stale so the UI does not present it as current. A malformed,
partial, cross-organization, or unsupported projection fails as unavailable;
no partial rows are returned. Concurrent revoke/expiry is resolved by the
repository transaction snapshot and is denied on the next transaction. No DB
read is blindly retried; a caller may retry one read-only `503` request.

API: `GET /api/v1/dashboard/cases`, dynamic and `Cache-Control: no-store`, using
the P0-03 envelope. Missing session is `401`; authenticated but unsupported
authority is `403`; missing HK RDS runtime, invalid/partial projection, or
unclassified repository failure is `503`. Errors contain no Case counts,
identifiers, roles, grant details, hashes, or projection freshness.

## Acceptance Evidence And Harness

Public seams under test are the pure build/rebuild contract, the service plus
single repository transaction result, and the GET adapter. Focused red-green
tests must prove canonical hash equality, source-change inequality, Founder all,
Advisor assigned-only, collaborator scope/capability/expiry/revoke shaping,
sensitive/export absence, contractor denial, malformed projection failure, and
runtime fail-closed behavior. UI source review must prove loading, authorized
empty, error, denied, ready and stale states do not render data before success.

Target remains general API P95 below 500 ms and main page P95 below two seconds
at 100 active/1,000 retained Cases; this ticket records the target but performs
no load test. Focused tests have two corrective retries and 60 seconds per run.
Repeated identical deterministic failure stops as `needs_human`; unavailable
external infrastructure stops as `blocked_external`. `pnpm lint` and
`pnpm build` remain prohibited without separate authorization.

## Local Verification Record

- RED 1: `node --test tests/integration/case-dashboard-projection.test.ts`
  failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created projection module.
- GREEN 1: the focused projection suite passed `6/6`, covering canonical
  live/rebuild hash identity, changed-source hash inequality, Founder all,
  Advisor assigned-only, collaborator scope shaping, revoke/expiry, contractor
  denial, and malformed/cross-organization fail-closed behavior.
- RED 2: the expanded API/runtime suite failed with `ERR_MODULE_NOT_FOUND` for
  the not-yet-created route adapter.
- GREEN 2: the focused suite passed `8/8`, adding the versioned no-store API
  envelope, safe `401/403/503`, and missing-HK-RDS runtime denial.
- Final focused plus architecture regression:
  `node --test tests/integration/case-dashboard-projection.test.ts tests/architecture/module-boundaries.test.ts`
  passed `14/14` with zero failures.
- Scoped `git diff --check` passed with exit `0`.
- A bounded `tsc --noEmit --pretty false --incremental false` emitted no
  diagnostics, but the tool did not return a reliable completion status before
  its 60-second boundary; no typecheck pass is claimed and it was not retried.
- `pnpm lint` and `pnpm build` were not run under repository rules. No HK RDS
  adapter, browser server, screenshot, load test, migration, or external action
  was executed. Runtime transaction locking, responsive browser behavior, and
  the `AC-22` P95 targets remain release evidence gaps.
