# P2-04 Contractor Task Workspace

| Control | Value |
| --- | --- |
| Ticket | `P2-04` Contractor task workspace exposes only redacted assigned context |
| Date | 2026-08-10 (Asia/Hong_Kong) |
| Local status | `implemented_locally_pending_hk_rds_and_browser_evidence` |
| Decision inputs | Resolved `OD-06`; guarded `OD-07`; `DEC-008`, `DEC-028`, `DEC-055`; P0-09, P1-06, P1-13, P1-16, P2-03 contracts |
| External state | No migration execution, RDS/Neon write, cloud call, real data access, commit, push, deployment, or release action |

## Problem, Stakeholders, And Boundary

Contractors need enough information to accept, deliver, or return a currently assigned Task without receiving the surrounding Service Case. The contractor is the direct stakeholder; the Founder, Primary Advisor, family, privacy owner, and security owner need assignment revocation and data minimization to hold at the server boundary rather than only in navigation or React rendering.

In scope: one authenticated contractor reads one currently assigned Task through a dedicated repository transaction, receives an allowlisted task-only DTO, and opens a contractor-only server page. The direct API and page both fail closed when the actor, organization, assignment, task-only redaction, or production HK RDS composition is absent.

Out of scope: task creation, assignment/reassignment semantics, case grants, CaseCollaborator membership, identity contact, family/Guardian data, internal notes, full case workspace, documents, export, bulk task access, break-glass, absent Primary Advisor behavior, migration/schema changes, or any real database/runtime operation. `OD-07` is not inferred.

## Model, Identity, And Invariants

The entity path is `Organization User (Contractor) -> current TaskAssignment -> Task`. A Contractor is identified by stable User UUID plus active organization context; email is not authority. A Task assignment does not create a Service Case grant or collaborator relationship.

| Invariant | Enforcement owner |
| --- | --- |
| Actor must be the active Contractor in the request organization | Identity establishes the actor; `modules/access/policy.ts` performs the pure decision; the repository re-reads membership in the same transaction |
| Actor must be the current assignee of this exact Task | Task repository transaction locks/re-reads Task and current assignment before projection |
| Assignment must carry `task_only` redaction | Access policy and Task repository transaction; any broader/missing redaction denies |
| DTO exposes only task ID, title, task brief, due time, state, and record version | `modules/tasks/contractor-workspace.ts` constructs an exact allowlisted projection; repository input has no full-case payload |
| Identity contact, Student/Guardian/family fields, internal notes, case summary/ID, and raw case knowledge never appear | Server DTO type and exact-key tests; Route Handler serializes only that DTO; page receives only that DTO |
| Revoked/reassigned assignment denies on the next request | Repository performs assignment authorization and projection in one transaction at request time; no cached authorization |
| Production without approved HK RDS adapter denies | Dedicated contractor workspace runtime has no JSON, mock, Neon, or legacy fallback |

The permitted read transition is only `current assigned task -> redacted task projection`. Missing, revoked, reassigned, inactive, cross-organization, non-contractor, or non-`task_only` input produces no projection. No write transition is introduced by P2-04; existing P1-13 commands remain authoritative for Task state changes.

## Public Seams And Error Contract

- Service seam: `ContractorTaskWorkspaceService.getAssignedTask`.
- Repository seam: one `getAssignedTaskWorkspace` transaction containing membership, Task, current-assignment, organization, and redaction checks plus the redacted projection.
- API seam: `GET /api/v1/contractor/tasks/:taskId`.
- Page seam: `/contractor/tasks/:taskId`, server-rendered from the same service result.

| Condition | Public result |
| --- | --- |
| Invalid Task UUID | `400 INVALID_REQUEST` at API; page not found |
| Missing/invalid session | `401 UNAUTHENTICATED`; page redirects to login |
| Authenticated non-Contractor | `403 FORBIDDEN`; page not found |
| Hidden, nonexistent, revoked, reassigned, cross-organization, or non-task-only assignment | `404 NOT_FOUND`, without confirming Task/case existence |
| Missing approved HK RDS composition or unclassified repository failure | `503 SERVICE_UNAVAILABLE` |

Responses use the P0-03 versioned envelope, `Cache-Control: no-store`, and fixed messages. No error contains Task, assignment, case, Student, Guardian, or role details.

## Risks, Evidence, And Execution Harness

Security/privacy risk is accidental broad projection or enumeration through direct API access. Reliability/concurrency risk is a TOCTOU read after reassignment or revoke. Partial failure risk is returning a projection after only some authorizing reads. Performance target follows the general API P95 below 500 ms; the repository must use one bounded indexed Task/current-assignment query in one transaction. There is no migration or release boundary in this ticket.

Acceptance evidence is a focused red-green suite proving exact DTO keys, direct API denial, current-assignment/revoke behavior, cross-organization and role denial, task-only enforcement, and fail-closed runtime. A bounded browser-model test proves the page renderer has no link or label for a case, family, contact, notes, or export surface. Focused tests may be corrected twice; a repeated identical failure without new evidence stops in `needs_human`. No network/external request is allowed. `pnpm lint` and `pnpm build` remain prohibited without separate user authorization.

## Verification Record

TDD evidence:

- Red 1: focused integration failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created contractor workspace service.
- Green 1: service/access suite passed `4/4` for exact allowlist, current assignment, revoke/reassign, role, organization, actor status, and `task_only` enforcement.
- Red 2: direct API/runtime suite failed with `ERR_MODULE_NOT_FOUND` for the dedicated runtime; the first adapter placement also exposed Node's inability to load `next/headers` outside Next. The testable Web adapter was moved into the Task owning module while the Next route remained a thin cookie/runtime composition.
- Green 2: service/API/runtime suite passed `7/7`.
- Red 3: browser-model suite failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created model.
- Green 3 and final focused rerun: `node --test tests/integration/contractor-task-workspace.test.ts tests/unit/contractor-workspace-model.test.ts` passed `11/11`, including adapter-extra-field stripping and opaque API denial after revoke.
- Regression: Task transition, collaborator scope, and architecture suites passed `27/27`.
- `git diff --check` passed for the P2-04 paths.
- `tsc --noEmit --pretty false --incremental false` produced no diagnostic but hit the bounded 60-second timeout (`124`); no typecheck pass is claimed and it was not retried.

`pnpm lint` and `pnpm build` were not run because repository rules prohibit them without separate authorization. No runnable HK RDS adapter exists, so transaction locking and indexed query behavior remain unproven. No browser server/screenshot run is claimed; the deterministic browser model covers task-only keys, long text, action shaping, and absence of case/family/contact/notes/export navigation. Security/Founder review and an approved HK RDS composition are still required before enabling `CONTRACTOR_TASK_WORKSPACE_ENABLED`.
