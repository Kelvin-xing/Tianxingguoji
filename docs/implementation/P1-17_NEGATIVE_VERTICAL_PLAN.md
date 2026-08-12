# P1-17 Negative Vertical Slice

## Scope

P1-17 adds the Release 1 negative gate only. It composes the public, deterministic
workflow fakes and worker entry points already introduced by P1-03 through P1-15;
it does not change routes, UI, production services, migrations, or runtime wiring.

The gate is split by responsibility:

- `tests/e2e/vertical-slice-negative.spec.ts` runs the authorization, optimistic
  concurrency, altered-idempotency, and resolved-view rollback contracts.
- `tests/failure-injection/vertical-slice.test.ts` runs all pre-commit failure
  contracts plus document scan and in-app delivery worker failures.

Each aggregate executes the existing integration suites in a fresh Node test
process. This preserves their direct assertions over typed error code/status,
durable record state, audit history, outbox count, and idempotency receipt count.
Explicit required-title checklists make every plan-named denial, replay, rollback,
pre-commit, scan, and delivery contract fail the aggregate when it is removed,
renamed, omitted from the selected suites, or fails.

## Required Negative Evidence

| Category | Public seam and expected observable | Durable invariant |
| --- | --- | --- |
| Cross-case and unauthorized access | Case transition returns `CASE_TRANSITION_CASE_NOT_FOUND`; target returns `SCHOOL_TARGET_CASE_FORBIDDEN`; document returns `DOCUMENT_VERSION_CASE_FORBIDDEN`. | No transition/target/document idempotency, audit, or outbox effect. |
| Collaborator expiration, revoke, and export | Scope evaluation returns `GRANT_EXPIRED`, `GRANT_NOT_ACTIVE`, and `COLLABORATOR_EXPORT_DENIED`. | Grant history remains bounded and revocation is evaluated at request time. |
| Assessment/case/target/task/document stale commands | Typed stale errors include `ASSESSMENT_ANSWER_STALE_VERSION`, `CASE_TRANSITION_STALE_VERSION`, `SCHOOL_TARGET_RESOLUTION_STALE`, `TASK_TRANSITION_STALE_VERSION`, and `DOCUMENT_VERSION_STALE`. | Record versions and all effect counts remain unchanged. |
| Altered idempotency replay | Each workflow rejects altered reuse with its typed `*_IDEMPOTENCY_KEY_REUSED` code. | One original receipt/audit/outbox fact, never a second effect. |
| Document scan duplicate, failure, DLQ, and reconciliation | Exact duplicate reports `duplicate`; retries are retryable then dead-letter on attempt three; reconciliation reports requeued/ignored totals. | Quarantined/failed versions never become downloadable; work count is stable. |
| Notification duplicate, failure, and lost access | Duplicate delivery reports `duplicate`; access revoked after claim reports `suppressed`; third completion failure reaches DLQ. | One producer fact is retained; one receipt/notification at most; unread count is zero after suppression/DLQ. |
| Resolved-school rollback and provenance | A stale disable reports `SCHOOL_OVERLAY_STALE_VERSION`; valid disable produces a new resolved revision. | Existing target pin and its provenance hash are not rewritten. |
| Runtime unavailable | Document scan and in-app runtime getters throw their typed `*RuntimeUnavailable` errors. | No fallback or unconfigured worker effect is permitted. |
| Pre-commit injected failure | Case creation, assessment, collaborator, school change/target, task, document upload/version, scan, and case transition fakes each have a one-shot transaction failure seam. | No partial business fact, audit, outbox, idempotency, or receipt persists. |

## Verification

Run only the P1-17 gates:

```sh
node --test tests/e2e/vertical-slice-negative.spec.ts
node --test tests/failure-injection/vertical-slice.test.ts
```

These tests are local deterministic fake-backed evidence. They do not constitute
real-browser, configured-RDS, staging migration, restore, or external delivery
evidence. Those remain explicit P1-18 / human go-no-go gates.
