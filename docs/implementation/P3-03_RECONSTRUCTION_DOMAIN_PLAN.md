# P3-03 Historical Case Reconstruction Domain Contract

| Control | Value |
| --- | --- |
| Ticket | `P3-03` |
| Status | `implemented_local` |
| Date | 2026-08-12 (Asia/Hong_Kong) |
| Authority | `DEC-027`, `DEC-032`, `DEC-034`, `DEC-044`, `DEC-061`, `DEC-067` |
| Repository | `erp-frontend` |
| Release effect | None; additive unused schema and local domain/fake only |

## Problem And Boundary

The Customer Organization needs to reconstruct one approved opaque pilot case without sending real case PII to engineering or allowing historical entries to create current operational effects. The assigned Primary Advisor records a versioned history, a recorder-distinct Founder reviews it, and activation makes the approved facts visible atomically.

This ticket implements the CaseWorkflow-owned local contract, policy, repository port, service, transaction-faithful fake, additive migration, and deterministic tests. Route Handlers/UI (`P3-04`), the PostgreSQL adapter/composition (`P3-08`), P3-19 approval creation, migration execution, real data, deployment, and cloud state are out of scope.

## Model And Invariants

- The durable identity is `(organization_id, pilot_reference)`. `service_case_id` is nullable before activation; create does not accept or require one. Activation receives a typed `ReconstructionServiceCaseBinding` and the owning repository must verify and bind it in the same transaction. The fake fails closed when the binding is absent or not an existing tenant case.
- The reconstruction aggregate ID is stable across revisions. Every revision has a distinct `reconstruction_version_id` and `version_no`; `createNextDraft` never replaces the aggregate ID. Old revisions remain readable and frozen, and activation records the approved revision ID.
- Allowed history is limited to versioned ServiceCase, SchoolTarget, Task, and Document-metadata event types. Evidence is an allowlisted type plus opaque reference; no evidence body/content, PII, or free text is accepted. Server UTC time enforces `occurred_at <= recorded_at` and `(occurred_at, sequence_no)` ordering.
- Only the assigned Primary Advisor may create/revise/submit. A Founder reviewer must differ from the recorder. The review graph is `draft -> submitted -> approved -> activated` or `submitted -> changes_requested -> draft`; the third change request enters `needs_human` without creating a draft.
- Idempotency scope/hash includes organization, actor, command type, aggregate or pilot target, expected record version, and normalized business payload. It excludes request IDs, server timestamps, generated IDs, and the idempotency key. Fake receipts distinguish `in_progress`, `completed`, and `failed_reconcilable`; aliasing is rejected and replay has one effect.
- `RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN` is a typed local `503`, non-retryable result. In-progress and unknown commit states fail closed; callers must reconcile rather than blindly replay. The fake can inject post-commit uncertainty.
- Before activation no authoritative fact or outbox effect exists. Activation atomically binds the case, writes facts/history/approved gaps/audit/idempotency, and emits exactly one PII-free `case_reconstruction.activated.v1` event.
- A correction appends an immutable event carrying `correction_of_event_id`, a closed reason code, `correctedBy`, `recordedAt`, expected aggregate version, and revision ID/no. The target must be in the same tenant and aggregate and cannot itself be a correction; the original event is unchanged and audit is atomic.

## Ownership And Enforcement

| Invariant | Enforcement owner |
| --- | --- |
| Input/event/evidence/time shape | Reconstruction policy/service |
| Assignment, P3-19 pilot approval, state, reviewer separation, revision lineage, binding, idempotency and CAS | Reconstruction repository transaction |
| Fact/history/gap/audit/outbox/case binding atomicity | CaseWorkflow repository `activate` transaction |
| Tenant isolation, composite FKs, uniqueness, enum/time/order, correction chain, append-only effects and `FORCE RLS` | PostgreSQL migration constraints/RLS/triggers |
| Production adapter, real ServiceCase lookup, and authority verification | Deferred and fail-closed at `P3-08` / `P3-19`; no runtime adapter or fallback exists in P3-03 |

The migration creates no approval table, seed row, backfill, production role grant, or runtime DDL. It is a local contract only; production adapter and real-PostgreSQL evidence remain gated by `P3-08` and approval authority remains gated by `P3-19`.

## Interface And Failure Contract

`CaseReconstructionService` is the public command seam and `CaseReconstructionRepository` is the transaction boundary. Activation accepts an optional typed case binding so an absent binding is representable and rejected rather than fabricated.

Callers branch on stable codes, never error text. Reconstruction failures use `RECONSTRUCTION_*`; stale writes use `VERSION_CONFLICT`. Every typed error exposes HTTP and retryability metadata. In particular, in-progress is `409`/non-retryable and unknown commit is `503`/non-retryable pending reconciliation.

## Risks And Controls

| Risk | Control/evidence |
| --- | --- |
| Client invents a case before activation | Nullable preactivation identity plus repository-verified typed binding |
| Revision overwrite or activation of an unapproved revision | Stable aggregate, distinct immutable version IDs, old-version read test, approved-version activation pointer |
| Receipt aliasing or duplicate effects | Full scope/hash, fake receipt states, actor/operation/target collision tests, one-effect replay |
| Correction mutates history or crosses tenant/aggregate | Append-only event metadata, composite tenant FK, correction-chain trigger and negative fake test |
| Partial activation or lost response | Transaction-faithful rollback and post-commit uncertainty/reconciliation tests |
| PII or fabricated authority in migration | Opaque allowlists, no content columns, no approval rows/seeds/grants/runtime DDL |

## Verification Evidence

Focused command:

```text
node --test tests/integration/case-reconstruction-workflow.test.ts \
  tests/migration/case-reconstruction-schema.test.ts \
  tests/architecture/module-boundaries.test.ts \
  tests/migration/drift.test.ts
```

The workflow/schema tests cover preactivation without a case, stable aggregate and revision IDs, old-version reads, binding fail-closed behavior, scoped idempotency and alias protection, in-progress/unknown outcomes, correction metadata and immutability, atomic effects, composite tenant FK/`FORCE RLS`, migration ordering/drift, and absence of fabricated approval authority.

## Residual Risk And Next Gate

- The fake is deterministic; isolated PostgreSQL transaction/concurrency and production adapter evidence remain `P3-08` gated.
- Pilot approval and real-case binding remain repository-port responsibilities and require `P3-19`/`P3-08`; this local contract does not activate a real case.
- No Route Handler/UI or browser evidence exists; that remains `P3-04`.
- The additive migration was inspected by local tests only and was not executed against any database.
- `pnpm lint`, `pnpm build`, TypeScript compilation, DB migration execution, commit, push, deployment, and production/cloud actions were not run or authorized.

Terminal state: `passed` for the bounded local P3-03 contract; production/runtime state remains fail closed.
