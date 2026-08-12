# P1-08 Provisional School And Change Evidence

| Control | Value |
| --- | --- |
| Ticket | `P1-08` Advisor creates a provisional School and submits one change-evidence request |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-014`, `DEC-015`, `DEC-041` |
| External state | No RDS/Neon write, migration execution, Cognito call, crawler snapshot copy, network evidence check, deployment, commit, or push was performed |

## Scope And State

This ticket provides two SchoolIntelligence commands only:

- `POST /api/v1/schools/provisionals` creates one opaque `School` identity in
  `provisional` state from a required identity, district, system, stage, and
  reason. It accepts no official-URL field, so it cannot infer or guess one.
- `POST /api/v1/schools/:schoolId/change-requests` submits one field change
  with the immutable base snapshot ID/value hash, proposed JSON value, reason,
  and HTTPS evidence URL plus quote. It creates a P0-08 `candidate` overlay
  revision and exposes it as a `submitted` `SchoolChangeRequest` receipt.

```text
School:             provisional -> under_review -> verified -> retired
                       ^ P1-08 creates only this state

SchoolChangeRequest: submitted -> approved | rejected | withdrawn
                       ^ P1-08 creates only this state

P0-08 overlay:      candidate -> approved | rejected
                                 approved -> disabled
                       ^ P1-08 creates one candidate only
```

The ticket intentionally does not implement review/approval/rejection,
withdrawal/retirement, verified official-URL discovery, attachment upload,
resolved views, SchoolTarget pinning, snapshot publication, or crawler
synchronization. `P2-06` owns field/identity review and snapshot conflict
governance; `P1-09` owns resolved views and targets.

## Invariants And Owners

| Invariant | Enforcement owner |
| --- | --- |
| Only an opaque-session Advisor may create or submit | Route requires the current Identity runtime with `sensitiveAction: true`; `SchoolService` also checks the Advisor role |
| Provisional identity, district, system, stage, and reason are required | Route parser and `SchoolService` normalizers |
| No official URL is inferred or guessed | The provisional command has no URL input or derivation; the synthetic adapter persists `officialWebsite: null` |
| Change evidence includes an HTTPS source URL and non-empty quote | `SchoolService` validates only syntax/protocol; it performs no network claim or verification |
| A request carries base snapshot/value evidence and cannot alter it | Production repository must compare the visible P0-08 immutable base hash in its command transaction; candidate overlay content uses P0-08 canonical JSON/hash rules |
| Submitted change never approves, resolves, or mutates a base/overlay | `SchoolService` calls only `submitSchoolChange`; the repository port has no reviewer, approval, or resolver input |
| Requester cannot self-review | P1-08 exposes no review route or reviewer parameter; P0-08 `evaluateSchoolOverlayApproval` and its database trigger deny self-review when a future owner performs review |
| Exact idempotency replay returns the original receipt; changed reuse is denied | Repository-scoped idempotency record in the same transaction |
| Fact, candidate overlay/request, audit, outbox, and idempotency result commit together | `SchoolRepository` transaction port receives one `MutationEffectBundle`; synthetic adapter stages and swaps all state |
| Audit/outbox omit identity, reason, proposed value, evidence URL, and quote | `buildAuditEvent`/`buildOutboxMessage` allowlists only aggregate IDs, state, version, request ID, and effect type |
| Production has no local/JSON/Neon fallback | `modules/schools/runtime.ts` throws until an approved HK RDS composition installs the sole adapter |

`SCHOOL_IDENTITY_FIELDS` retain P0-08 field-class treatment, including the
Founder-only approval rule after P1-08. A name or URL is never used as a
relationship key. The synthetic adapter creates no base record and only uses
an existing immutable base record to demonstrate hash comparison; it does not
represent a real database or snapshot write.

## Error Mapping

| Condition | Public result |
| --- | --- |
| Malformed JSON, invalid school path UUID, or absent/invalid `Idempotency-Key` | `400 INVALID_REQUEST` |
| Valid framing but missing/invalid identity, reason, lifecycle fields, evidence, field class, base ID/hash, or JSON proposal | `422 VALIDATION_FAILED` |
| Missing or invalid opaque session | `401 UNAUTHENTICATED` |
| Current actor is not an Advisor | `403 FORBIDDEN` |
| School/base snapshot is absent or outside the transaction's visible organization | `404 NOT_FOUND` |
| Changed idempotency reuse, in-progress command, or stale base hash | `409 CONFLICT` |
| No approved Identity or School HK RDS runtime | `503 SERVICE_UNAVAILABLE` |

Route handlers use the P0-03 versioned envelope, no-store responses, stable
messages, request IDs, and empty error details. They do not return base
values, requested reasons, quotes, URLs, reviewer data, or authorization
facts.

## Deterministic Evidence

`node --test --test-reporter=tap tests/integration/school-change-workflow.test.ts`
passed `6/6` focused cases:

1. Required provisional-school facts create one provisional receipt, one audit,
   and one outbox effect while retaining no guessed URL.
2. A change submission creates a P0-08 candidate with immutable base hash and
   self-review denial evidence, without approved receipt or base mutation.
3. Exact idempotency replay returns the original change; altered reuse fails.
4. Missing provisional identity/reason, invalid evidence, and stale base hash
   leave all submitted facts/effects empty.
5. A non-Advisor is denied with no requester-controlled reviewer field.
6. Injected pre-commit failure leaves request, candidate overlay, audit, and
   outbox absent.

Additional local checks executed after implementation:

- `./node_modules/.bin/tsc --noEmit --pretty false`: passed with no diagnostics.
- `git diff --check`: passed.

`pnpm lint` and `pnpm build` were not run because `erp-frontend/AGENTS.md`
forbids them without separate authorization. No browser, real RDS, Cognito,
TOTP, network evidence-verification, crawler, or UI behavior is claimed.

## External Gate And Limitation

Before enabling either route, data, security, and operations owners must
approve an HK RDS adapter that performs session/Advisor policy lookup, school
visibility, immutable snapshot/base-hash comparison, candidate revision-number
allocation, idempotency, request/change persistence, and redacted audit/outbox
in one transaction. The existing P0-08 migration supplies Schools, immutable
snapshots, candidate overlays, and reviewer safeguards, but does not yet have
a dedicated persisted `ProvisionalSchool` or `SchoolChangeRequest` storage
shape for all P1-08 lifecycle facts. That storage mapping/schema decision is
an approved-decision blocker for real enablement and must be resolved without
mutating crawler snapshots or weakening P0-08 immutability.

The future approved runtime must also demonstrate same-organization and
cross-organization negative tests, row-lock/isolation behavior for a changing
base record, transaction failure/idempotency retention behavior, reviewer
separation for approval/rejection, safe evidence attachment handling after the
document workflow exists, HK residency, and actual TOTP/session wiring. No
local code or synthetic test authorizes a migration run, database write,
Cognito action, snapshot copy, deployment, or real School workflow.
