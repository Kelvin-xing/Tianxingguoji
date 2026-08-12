# P2-06 School Governance Plan

| Control | Value |
| --- | --- |
| Ticket | `P2-06` School governance covers field/identity review and snapshot conflict |
| Date | 2026-08-10 (Asia/Hong_Kong) |
| Run ID | `p2-06-school-governance-20260810` |
| Local status | `implemented_locally_pending_hk_rds_transaction_adapter` |
| Decision inputs | `P1-08`, `P1-09`, `P2-03`, `P2-05`, `DEC-014`, `DEC-015`, `DEC-016`, `DEC-042`, `DEC-050`, resolved `OD-12` |
| External state | No RDS/Neon write, migration, snapshot copy/publish/sync/activation, crawler run, warning acceptance, cloud call, real data, commit, push, deployment, or release-state change |

## Problem, Stakeholders, And Scope

Advisors can submit evidence-backed School field changes, but Release 1 still
needs a governed review command and a deterministic response when a later
immutable crawler snapshot agrees or conflicts with an approved human value.
Data Reviewers need to decide ordinary field requests, Founders need to decide
identity-class requests, Advisors need approved corrections to become visible,
and data/operations owners need a reversible, auditable history.

In scope:

- approve or reject one submitted School change request with a mandatory
  reason, optimistic version, idempotency, requester/reviewer separation, and
  role-by-field-class policy;
- activate an approved overlay and resolved-revision receipt atomically;
- reconcile one approved overlay against one already-visible immutable base
  snapshot: matching values close the override, conflicting values preserve
  the approved human value and append a review-required item;
- fail-closed admin Route Handlers and a DTO-consuming admin page.

Out of scope:

- crawler warning recommendation/acceptance, manifest validation, snapshot
  publication, copy, synchronization, pointer activation, or release action;
- merge/split/retire/official-identity semantics beyond the existing
  field-class gate, provisional lifecycle breadth, real migration/RDS wiring,
  and any interpretation not approved by `OD-12`;
- editing snapshot files or base records, silently rewriting pinned targets,
  accepting a warning, or resolving a human conflict automatically.

## Entity And State Model

```text
SchoolChangeRequest: submitted -> approved | rejected
OverlayRevision:     candidate -> approved | rejected
Approved overlay:    approved -> closed_by_snapshot
                                      | conflict -> remains approved
                                      + appends snapshot_conflict review_required
Resolved revision:   append-only receipt on approval/reconciliation
Immutable base:      never updated by this workflow
```

The requester is the actor recorded on the submitted change/overlay. The
reviewer is the current authenticated RDS User in the active organization; a
client-supplied requester or reviewer is never accepted. The same User cannot
review their own request. A Data Reviewer may decide only `general` fields. Any
request containing an `identity` field requires a Founder. Approval and
rejection both require a non-empty reason. A rejection appends the decision
history but does not create an active resolved revision.

A reconciliation references an existing approved overlay and an immutable
snapshot ID already visible to the repository transaction. If every governed
overlay value equals the new base value, the repository appends a close receipt
and resolves from the base. If any governed value differs after the base has
changed, the approved human value remains authoritative and one deduplicated
`review_required` conflict item is appended. An unchanged base retains the
override without creating a false conflict. Existing SchoolTarget pins and
prior resolved receipts are immutable.

## Invariants And Enforcement Owners

| Invariant | Enforcement owner |
| --- | --- |
| Requester cannot self-review | `SchoolGovernanceService` validates the policy from repository-owned facts; HK RDS constraint/transaction is authoritative |
| Identity-class change requires Founder | Pure School field-class policy plus locked candidate recheck in the repository transaction |
| Ordinary fields require Data Reviewer or Founder | Pure policy and repository authorization recheck; Advisor is denied |
| Base snapshot and prior revisions are immutable | School repository/schema; ports expose append/activate/close operations only |
| Approval immediately activates one resolved revision | Single `reviewChangeRequest` repository transaction |
| Matching crawler value closes the approved override | Canonical JSON hash/equality and locked reconciliation transaction |
| Conflict preserves approved human value and creates review | Resolver/reconciliation policy plus atomic review-item append |
| Existing pins never move silently | No target-pin write exists in this ticket; resolved receipts are append-only |
| Authorization, current role/requester, locks, expected versions, decision/reconciliation, revision activation, audit, outbox, and idempotency commit together | HK RDS repository transaction; Route Handler and UI are adapters only |
| Production fails closed without HK RDS composition | `school-governance-runtime.ts` has no local/JSON/Neon/snapshot fallback |
| Audit/outbox contain no values, evidence, quotes, URLs, or human reason | Service builds allowlisted aggregate IDs/state/version/effect metadata only |

No name, URL, email, or crawler source key is an identity join key. UUIDs and
versioned repository relations remain authoritative. `DEC-042` duplicate
candidate/merge history is not altered by governance review or reconciliation.

## Interface And Error Contract

Public commands require a fresh sensitive opaque session and an
`Idempotency-Key`. The review command includes decision, reason, and
`expected_record_version`. The reconciliation command includes the immutable
`snapshot_id` and `expected_overlay_record_version`; it intentionally has no
warning-acceptance or snapshot-activation input.

| Condition | API result |
| --- | --- |
| Malformed JSON/path/idempotency framing | `400 INVALID_REQUEST` |
| Invalid decision, missing reason/snapshot/version | `422 VALIDATION_FAILED` |
| Missing/invalid session | `401 UNAUTHENTICATED` |
| Wrong role, self-review, or unauthorized organization/resource | `403 FORBIDDEN` |
| Hidden or absent request/overlay/snapshot | `404 NOT_FOUND` |
| Stale expected version | `409 STALE_VERSION` |
| Already decided/closed, changed idempotency reuse, or duplicate/in-progress conflict | `409 CONFLICT` |
| Missing approved Identity or School HK RDS runtime | `503 SERVICE_UNAVAILABLE` |

Responses use the versioned P0-03 envelope, `no-store`, stable codes, request
IDs, and empty safe error details except the existing stale-version allowlist.
The UI consumes response DTOs and does not infer authorization from local state.

## Risk, Recovery, And Partial Failure

- Concurrent reviewers or snapshot reconciliations could double-activate or
  lose a decision. The repository locks request/overlay/current resolution and
  compares expected versions; stale work returns `409`, never last-write-wins.
- Authorization may change between page render and submit. Every command
  re-reads the current actor role and organization visibility inside the write
  transaction.
- An audit/outbox or resolved-revision write may fail after a decision. All are
  in the same transaction, so the command rolls back to the prior state.
- A later snapshot can disagree with an approved human correction. The system
  preserves the human value, appends a review item, and can recover by a later
  reviewed revision or by disabling the bad revision; it never edits history.
- A matching snapshot can make the override redundant. Closing is append-only;
  recovery restores the prior snapshot pointer or disables the corrective
  revision under a separate human decision, without changing existing pins.
- Snapshot warning acceptance is externally consequential. This ticket exposes
  no warning receipt or activation operation and cannot perform it.

## TDD Seams, Evidence, And Harness

Confirmed public seams are `SchoolGovernanceService.reviewChangeRequest`,
`SchoolGovernanceService.reconcileApprovedOverlay`, their admin Route Handlers,
and `/admin/schools` as a pure DTO consumer. Tests use a deterministic synthetic
repository only as the HK RDS boundary; they assert results and durable public
snapshots, not private call order.

Acceptance evidence:

1. self-review and Advisor review are denied with no state/effect change;
2. Data Reviewer approves/rejects ordinary fields, while identity approval is
   Founder-only, with atomic decision/resolved revision/audit/outbox;
3. a matching immutable snapshot closes an approved override;
4. a conflicting immutable snapshot preserves the approved human value and
   appends one review-required item;
5. stale versions, changed idempotency reuse, and injected pre-commit failure
   produce no partial state;
6. the runtime and admin APIs fail closed without the configured HK RDS adapter;
7. focused School resolver and target regressions remain green; bounded
   TypeScript check and `git diff --check` pass.

Allowed commands are read-only inspection, `apply_patch`, focused local
`node --test`, bounded `tsc --noEmit`, and `git diff --check`. No network or
external calls are allowed. One deterministic failure may be corrected then the
full focused gate is rerun. Identical transient checks may retry at most three
times; two repeated failures without new evidence stop as `needs_human`.
`pnpm lint` and `pnpm build` remain prohibited without separate authorization.

## Approval And Release Boundary

Local implementation does not authorize a production adapter, migration, RDS
write, crawler warning acceptance, snapshot publication/copy/sync/activation,
real-data review, commit, push, deployment, or release change. Enabling the
workflow requires reviewed HK RDS schema/adapter evidence and exact human
approval by data, security, operations, and the field-appropriate Reviewer or
Founder. Rollback is an audited disable/corrective revision or restoration of
the previously approved snapshot pointer, never a history or snapshot edit.

## Local Verification Evidence

The final focused command completed with `25/25` passing tests and no skips:

```text
node --test --test-reporter=tap \
  tests/integration/school-governance-workflow.test.ts \
  tests/unit/schools/resolver.test.ts \
  tests/integration/school-target-workflow.test.ts
```

The nine P2-06 cases cover ordinary approval, self-review denial, identity
Founder gate, matching snapshot closure, conflicting snapshot preservation and
review creation, rejection without resolved activation, stale/idempotency
conflicts, transaction rollback, and fail-closed runtime. Sixteen resolver,
pin/rollback, and migration-planner regressions also passed.

`git diff --check` passed for the two tracked navigation edits. Each new P2-06
file also produced no `--check` diagnostics under `git diff --no-index`; exit
status `1` there denotes a new-file diff, not a whitespace error.

`./node_modules/.bin/tsc --noEmit --pretty false` emitted no diagnostics but did
not complete within the bounded 90-second observation window and was cancelled
with exit `130`. It is therefore a verification gap, not a pass. `pnpm lint`
and `pnpm build` were not run because repository policy prohibits them without
separate authorization. No browser or real HK RDS behavior is claimed.
