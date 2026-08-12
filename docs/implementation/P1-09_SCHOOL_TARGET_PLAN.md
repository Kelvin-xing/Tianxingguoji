# P1-09 Resolved SchoolTarget Pin And Rollback Evidence

| Control | Value |
| --- | --- |
| Ticket | `P1-09` Approved overlay resolves a pinned SchoolTarget and rolls back consistently |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-016`, `DEC-027`, `DEC-041`, `DEC-044`, `OD-05` |
| External state | No RDS/Neon write, migration execution, Cognito call, crawler snapshot copy, deployment, commit, or push was performed |

## Scope And State

This ticket adds three bounded endpoints and the corresponding service ports:

- `GET /api/v1/schools/:schoolId/resolved` returns the current P0-08 reduced
  view, field provenance, base snapshot ID, source overlay revision ID, and
  current resolved-revision receipt ID when available.
- `POST /api/v1/cases/:caseId/school-targets` creates one `SchoolTarget` only
  in `candidate` state. It takes a caller-supplied current resolution hash and
  persists an immutable pin; it does not implement later target transitions.
- `POST /api/v1/schools/:schoolId/overlays/:overlayRevisionId/disables` disables
  one approved P0-08 overlay and appends a new resolved-revision receipt for
  the resulting rollback view.

```text
P0-08 overlay:       approved -> disabled
Resolved current view: latest approved overlay -> prior approved overlay/base
SchoolTarget:         candidate
                          ^ P1-09 creates only this state and immutable pin
```

`resolvedRevisionId` and `overlayRevisionId` deliberately have different
meanings. The former is a new immutable `schools_resolved_revisions` receipt;
the latter identifies the approved P0-08 source overlay selected by the
reducer. Disabling the newest approved overlay therefore creates a new resolved
receipt whose fields, hash, provenance, and `overlayRevisionId` come from the
previous active overlay (or the base snapshot). Existing target pins are never
rewritten.

The P0-08 resolver remains the sole field reducer. Candidate, rejected, and
disabled overlays never contribute to a resolved view. P1-09 creates only a
`candidate` target under `DEC-027`; `OD-05` transition/template evidence is
versioned policy for later target transitions and is not hard-coded here.

## Invariants And Owners

| Invariant | Enforcement owner |
| --- | --- |
| Pin contains base snapshot, source overlay revision, provenance, deterministic resolution hash, and immutable resolved-revision receipt | `resolveSchoolTargetView` and `persistResolvedSchoolPin`; real repository persists the receipt and pin together |
| Only an approved current P0-08 overlay affects a resolved view | P0-08 `resolveSchoolView`, plus `resolveSchoolTargetView` rechecks the selected receipt status |
| Disabling a bad approved overlay restores the prior active overlay/base deterministically | `disableSchoolOverlay` followed by a fresh P0-08 reduction over the transaction's locked inputs |
| Existing pins survive rollback unchanged | `SchoolTargetRepository` has no pin-update operation; P1-09 creates a new rollback receipt only |
| A stale target pointer fails instead of selecting a new view silently | `SchoolTargetService` compares `expectedResolutionSha256`; repository repeats the comparison inside its write transaction |
| A stale overlay disable fails instead of last-write-wins | `expectedRecordVersion` is checked by the disable repository transaction |
| Only the current Primary Advisor can create a target | `SchoolTargetRepository` authorizes the active case, organization, Advisor role, and primary ownership under the transaction |
| Only an active Founder or Data Reviewer can disable an overlay; self-review stays denied | `ResolvedSchoolViewService` validates the reviewer role; the repository and P0-08 disable guard enforce current authorization and requester separation |
| Exact replay returns the original target or rollback receipt; changed idempotency reuse fails | Scoped idempotency records and request hashes are transaction facts |
| Target/receipt, idempotency, audit, and outbox commit together | Both repository ports require one transaction; the synthetic adapter stages state then swaps it only on commit |
| Effects are redacted | P0-03 audit/outbox builders emit only aggregate IDs, state/version, request ID, and effect type, never field values, provenance values, or reasons |
| Production cannot fall back to local state | `school-target-runtime.ts` and `resolved-view-runtime.ts` throw until the sole approved HK RDS composition root is installed |

## Authorization And Error Contract

Write routes require a current opaque Identity session with `sensitiveAction:
true`; the resolved-view read requires a current opaque session without a
sensitive reauthentication step. Authorization still runs inside the repository
transaction, so route authentication is not the authority boundary.

| Condition | Public result |
| --- | --- |
| Malformed JSON, invalid path UUID, or invalid/missing `Idempotency-Key` | `400 INVALID_REQUEST` |
| Valid framing but invalid target/disable data | `422 VALIDATION_FAILED` |
| Missing or invalid session | `401 UNAUTHENTICATED` |
| Non-Primary-Advisor target write, non-reviewer disable, self-review, or unreadable school | `403 FORBIDDEN` without authorization facts |
| Absent case, school, or visible resolution input | `404 NOT_FOUND` |
| Stale target resolution hash or stale overlay record version | `409 STALE_VERSION` |
| Duplicate target, disabled/not-approved overlay, changed idempotency reuse, or in-progress request | `409 CONFLICT` |
| No approved Identity/SchoolTarget/ResolvedView runtime or an unrepresentable resolver input | `503 SERVICE_UNAVAILABLE` |

All routes use the P0-03 versioned envelope with no-store responses, request
IDs, stable messages, and empty error details. Target and disable success
responses expose opaque IDs and hashes only; the resolved-view response exposes
the approved fields/provenance authorized for the caller.

## Deterministic Evidence

`node --test --test-reporter=tap tests/integration/school-target-workflow.test.ts tests/integration/document-scan-workflow.test.ts`
passed `11/11` cases:

1. An approved overlay creates an immutable candidate target pin with base,
   overlay, hash, and provenance.
2. A target command with an older resolved hash fails as a stale conflict.
3. Disabling the latest approved overlay creates a distinct valid resolved
   receipt, restores the prior overlay's hash and provenance, preserves the
   original target pin, and replays exactly by idempotency key.
4. A cross-case Advisor and a non-reviewer are denied without a state change.
5. Target idempotency replays once; an injected transaction failure leaves no
   target, resolved receipt, audit, or outbox fact.
6. The co-executed document scanner suite remains green (`6/6`), confirming
   no P1-09 edit changed its workflow.

No browser, real RDS, Cognito, TOTP, crawler, or UI behavior is claimed by this
synthetic evidence.

## External Gate And Limitation

Before enabling these routes, data, security, and operations owners must
approve one HK RDS adapter that locks the overlay and current resolution inputs,
authorizes the actor/case in the same transaction, compares the hash or record
version, appends `schools_resolved_revisions`, persists `cases_school_targets`
with the immutable pin, records idempotency, and emits the redacted audit/outbox
bundle atomically. It must also apply organization scoping, P0-08 approval and
self-review constraints, and real unique/index/foreign-key rules.

The local synthetic adapter is intentionally not a production fallback and no
real `schools_resolved_revisions` or `cases_school_targets` migration was run.
Real enablement still requires RDS concurrency/rollback evidence, same- and
cross-organization negative tests, transaction-failure tests for both write
paths, session/TOTP wiring, audit/outbox delivery verification, and approval by
the relevant Data Reviewer/Founder, privacy, and operations owners.
