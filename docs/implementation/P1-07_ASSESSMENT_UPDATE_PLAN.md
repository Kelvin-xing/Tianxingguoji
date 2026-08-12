# P1-07 Four-Layer Assessment Answer Update And Conflict

| Control | Value |
| --- | --- |
| Ticket | `P1-07` One four-layer assessment manifest supports safe answer update/conflict |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-012`, `DEC-013`, `DEC-026`, `DEC-043`, `DEC-044` |
| External state | No RDS write, migration execution, Cognito call, worker schedule, deployment, commit, or push action performed |

## Scope And Boundary

This ticket exposes one assessment read and one single-answer update over the
case's immutable, four-layer K12 manifest:

- `GET /api/v1/cases/:caseId/assessment` returns the manifest-derived,
  serializable screen model and the case's current answers.
- `PATCH /api/v1/cases/:caseId/assessment` updates exactly one answer with an
  `Idempotency-Key` and an answer `expected_record_version`.

`modules/cases/schema-resolver.ts` derives the shared UI/server field model
only from the case-pinned `K12ManifestComposition`. It preserves each field's
module layer, version-derived identity, value type, visibility, and blocker
stages without adding a parallel client validation catalogue.
`modules/cases/assessment-service.ts` owns command validation, canonical
request hashing, redacted audit/outbox construction, and the public transaction
port. Route Handlers are BFF adapters only. `AssessmentEditor` receives a
serializable DTO, preserves failed drafts, and never decides whether a value or
permission is valid.

Out of scope: approved field catalogue beyond the synthetic structural fields,
assessment status transition, manifest creation/retirement, field-level ACL,
bulk answer changes, RDS adapter implementation, database migration execution,
and changes to the legacy mock case page. P1-16 owns the integrated Case
workspace journey.

## State And Enforcement

```text
Answer for one (assessment, field)
  absent (expected version 0)
    -> record version 1
    -> record version N + 1

stale expected version -> 409 STALE_VERSION, no write
```

The update does not change the Assessment status. The existing P0-07 schema
retains `draft -> background_complete -> selection_ready` as a separately
guarded transition; this ticket cannot create one by completing a field.

| Invariant | Enforcement owner |
| --- | --- |
| UI and server consume the same four-layer field model | `resolveAssessmentSchema` derives a serializable DTO from the pinned manifest; UI renders that DTO only |
| A write uses one known field from that manifest | service resolves `fieldId`; production repository repeats the manifest/case join in its transaction |
| `provided` contains non-null JSON `{ type, value }` and type matches the manifest; other semantic states contain no value | `AssessmentService`, P0-07 structural checks, and future RDS transaction adapter |
| `unknown`, `not_applicable`, and `declined_to_provide` remain explicit states | command/parser plus `evaluateAssessmentAnswer`; no empty-string sentinel |
| Read access is current Primary Advisor ownership or a valid `education_profile` read capability; writing requires `education_profile:edit` for a collaborator | RDS repository policy read inside each request/transaction; synthetic adapter proves Primary Advisor and edit-grant paths |
| Two writes based on the same answer version cannot overwrite each other | repository compare-and-set on `(assessment, field, expected_record_version)`; stale path returns current version and opaque diff token |
| Same idempotency key replays only its original result | transaction-local idempotency record keyed by organization, actor, operation, and key |
| Answer, audit, outbox, and idempotency result commit together or not at all | repository transaction port receives `MutationEffectBundle`; test adapter stages then swaps all state |
| Audit/outbox do not contain answer content | `buildAuditEvent` holds before/after hashes; metadata/payload pass existing safe allowlists |

The production RDS adapter must lock or serialize all authorization-sensitive
inputs when updating: case/organization ownership, current primary Advisor or
unexpired `education_profile` grant, assessment and its manifest, current
answer version, idempotency row, answer, audit, and outbox. It must not use
local JSON, the test fake, Neon, or a last-write-wins fallback.

## Error Contract

| Internal condition | Public API result |
| --- | --- |
| Malformed case UUID, JSON, or missing/invalid `Idempotency-Key` | `400 INVALID_REQUEST` |
| Valid framing but invalid field, semantic state, typed value, or expected version | `422 VALIDATION_FAILED` |
| Missing/invalid opaque session | `401 UNAUTHENTICATED` |
| Current actor lacks case or `education_profile` capability | `403 FORBIDDEN` |
| Case/assessment outside the command context | `404 NOT_FOUND` |
| Reused idempotency key with changed request, or in-progress key | `409 CONFLICT` |
| Stale answer version | `409 STALE_VERSION` with only `current_version` and optional opaque `diff_token` |
| No configured HK case/identity runtime or malformed stored manifest | `503 SERVICE_UNAVAILABLE` |

All routes retain the P0-03 versioned envelope, request ID, fixed messages, and
redacted details. No response returns a competing answer value when resolving a
conflict.

## Deterministic Evidence

`tests/integration/assessment-workflow.test.ts` passes `6/6` focused tests:

1. A case resolves one serializable four-layer schema DTO from its pinned
   manifest.
2. A typed answer writes atomically and is visible through the same read model.
3. A non-value semantic state persists without becoming empty text.
4. Two updates from answer version zero produce one success and one stale
   conflict; no second effect occurs.
5. An active `education_profile:edit` collaborator may write; unknown fields
   and mismatched types are rejected.
6. Exact idempotency replay creates no second effect; injected pre-commit
   failure leaves answer, audit, and outbox counts at zero.

Additional checks passed:

- `node --test --test-reporter=tap tests/integration/case-creation-workflow.test.ts tests/integration/collaborator-scope-workflow.test.ts tests/integration/assessment-workflow.test.ts tests/architecture/module-boundaries.test.ts`: `23` pass, `0` fail.
- `./node_modules/.bin/tsc --noEmit --pretty false`: pass with no diagnostics.
- `node --check` for `schema-resolver.ts`, `assessment-service.ts`, and the
  assessment route: pass.
- `git diff --check`: pass.

`pnpm lint` and `pnpm build` were not run because `erp-frontend/AGENTS.md`
forbids them without separate explicit authorization. No browser journey is
claimed: P1-16 owns the integrated page and representative browser/a11y
evidence.

## External Execution Gate

Before enabling this command against RDS, the data, security, and operations
owners must approve the exact transaction adapter, role/RLS model, capability
lookup and expiry behavior, answer CAS SQL, idempotency retention, SQL
constraint evidence for semantic/type fields, audit/outbox persistence, race
tests for a concurrent case/grant revocation, error disclosure review, and the
HK runtime composition payload. No local source file or synthetic test
authorizes a migration run, database write, Cognito action, deployment, or
real assessment update.
