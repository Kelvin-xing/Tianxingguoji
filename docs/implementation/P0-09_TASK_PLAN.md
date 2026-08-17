# P0-09 Task And Transition Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_database_evidence`: task contract and migration payload are implemented; `OD-06` remains unresolved and therefore no production transition matrix is enabled |
| Candidate migration | `db/migrations/202608022230_005_expand_tasks.sql` |
| Migration SHA-256 | `2a617638b88be65c3c875e4689fa9ee87819d9deb7e11cb2d3147aff19daa4ac` |
| Runtime side effects | None |

## Problem And Boundary

P0-09 establishes the Task owning-module boundary without silently deciding the unresolved initial state or actor matrix. A candidate policy can describe a future matrix, but task creation and every transition fail closed until a policy carries an explicit `OD-06` resolved approval receipt.

In scope: versioned task states, candidate/approved/retired transition policies, rule-level actor kinds and allowed roles, task identity and tenant/case keys, assignment history, transition receipts, optimistic version checks, completion/approval separation, and contractor task-only redaction constraints.

Out of scope: choosing `created` versus `assigned` versus `accepted` as the real initial state, approving any real actor matrix, task routes/UI/service, automatic overdue jobs, audit/outbox delivery, real task records, staging/production migration, commit, push, cloud, or deployment.

## Invariants

- Task identity is an opaque UUID with a tenant-composite `ServiceCase` foreign key. Organization and case context must match on every decision.
- The policy is versioned and only one approved policy may exist per organization. Policy content and rules are immutable after insertion; approval and retirement are receipt-bearing status changes.
- Approval requires a separate Founder/Advisor reviewer, active role binding, explicit initial state, non-empty rules, and `OD-06: resolved`. No candidate policy can authorize a write.
- Task state is one of `created`, `assigned`, `accepted`, `rejected`, `reassigned`, `completed`, `approved`, `overdue`, or `cancelled`; rejected/reassigned/cancelled/approved transitions require a reason.
- `approved` can only follow `completed` and requires a distinct actor from the assignee. Completion is never treated as acceptance.
- State changes require an immutable transition receipt matching old state, new state, actor, reason, and expected record version. Stale versions fail closed.
- Contractor assignments and transitions require `task_only` redaction; no contractor path receives an unredacted task context.
- Assignment and transition receipt history cannot be updated or deleted. Task rows cannot be hard-deleted by this candidate schema.

## Public Contract

`modules/tasks/domain/contract.ts` owns task states, actor/rule/policy types, approval receipt shape, denial codes, and the public decision result. `modules/tasks/domain/transition-policy.ts` owns candidate policy creation, `OD-06` approval, task creation evaluation, and transition evaluation.

The policy evaluator checks approval receipt, organization/case identity, actor activity, optimistic version, exact rule, role and actor relationship, contractor redaction, approval separation, and reason requirements. The synthetic approved policy in tests is a harness fixture only; it is not a Release 1 default.

## Migration Payload

`202608022230_005_expand_tasks.sql` creates:

- `tasks_transition_policies` and `tasks_transition_rules` for versioned, receipt-bearing policy data;
- `tasks_tasks` for tenant/case-owned task facts;
- `tasks_task_assignments` for append-only assignment history; and
- `tasks_task_transition_receipts` for atomic state-change evidence and version matching.

The migration enforces one approved policy per organization, candidate-only rule insertion, explicit `OD-06` approval, active reviewer role binding, contractor redaction, task/case composite FK, immutable history, receipt/task linkage, approved rule lookup, actor role and relation checks, reason requirements, and separate completion/approval actors. No route or worker writes are added.

## TDD Evidence

- Red: `tests/unit/tasks/transitions.test.ts` failed because the Task contract and transition policy modules were absent.
- Green: the focused suite passes `8/8`, covering unresolved-policy denial, approval receipt/self-review, synthetic assignee completion, context/version denials, completion/approval separation, contractor redaction, invalid rule shapes, and migration payload checks.
- Migration/drift regression passes `10/10`.
- Complete local test set passes `78/78` runnable tests with `0` failures and `3` PostgreSQL skips from the existing P0-05/P0-06/P0-07 integration tests because `TEST_DATABASE_URL` is unavailable.
- OPA residency policy remains `7/7` on OPA `1.19.0`; `git diff --check` passes for the P0-09 files.

## Residual Risk And Gate

The SQL was not executed against PostgreSQL. The bounded `codex-p005` Colima attempt remains `Broken`; no retry, container, database, synthetic SQL execution, or database pass is claimed. Targeted TypeScript previously hung and was terminated with exit `130`; no TypeScript pass is claimed. Frontend lint/build remain unrun under `erp-frontend/AGENTS.md`.

Before P0-09 can be runtime-passed, repair a disposable local PostgreSQL profile and verify candidate policy rejection, resolved-receipt activation, one-approved-policy uniqueness, task/Case tenant FK, receipt/task atomic linkage, stale writes, role/actor mismatch, contractor redaction, immutable assignment/receipt history, and hard-delete rejection. This remains local synthetic verification only.

`OD-06` remains an unresolved business decision. Until Founder/Advisor approve the exact initial state and actor matrix, no policy receipt may be created and no real Task transition is enabled.
