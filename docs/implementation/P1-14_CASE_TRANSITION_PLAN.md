# P1-14 Case Transition

| Control | Value |
| --- | --- |
| Ticket | `P1-14` Advisor performs one guarded Case transition and Founder rollback |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | Resolved `OD-04`; `DEC-010`, `DEC-027`, `DEC-041`, `DEC-044` |
| External state | No migration execution, RDS write, Cognito call, worker schedule, deployment, commit, or push action performed |

## Release 1 Slice

Resolved `OD-04` permits Advisor pause and Founder resume, Founder pre-submission
cancel, re-signing as a new Case, independently moving SchoolTargets, and
Founder close only after target and task conditions. This ticket intentionally
implements none of those exception paths. `DEC-027` keeps SchoolTarget state
separate from ServiceCase state.

The P1-14 command policy is exactly:

| From | To | Authorized actor | Required evidence | Reason |
| --- | --- | --- | --- | --- |
| `signed` | `background_collection` | Current Primary Advisor | Approved assessment manifest, P1-07 assessment status `background_complete`, and all declared background blockers complete | Not required |
| `background_collection` | `signed` | Founder | Immediate preceding state only | Non-empty |

Founder temporary Primary Advisor cover is allowed for the forward row only
when the current Case Primary Advisor relation names that Founder. Every other
state, source/target pair, OD-04 exception, actor, and actor relationship
denies. Collaborators cannot transition or roll back a Case.

## Ownership And Enforcement

`modules/cases/application/transition-service.ts` owns the narrow command policy and
constructs the immutable transition-fact ID, redacted audit event, redacted
outbox message, idempotency request hash, and versioned response. A raw
rollback reason is retained only in the authoritative transition fact and the
request hash. Audit/outbox metadata carries only the `reason_code` marker.

Each command requires a fresh TOTP session at
`app/api/v1/cases/:caseId/transitions`, an expected record version, and an
idempotency key. The route is a thin BFF adapter: it validates framing, calls
Identity with `sensitiveAction: true`, then maps results through the P0-03
versioned envelope.

`CaseTransitionRepository.transitionServiceCase` is the sole mutation boundary.
A production RDS adapter must, in one transaction, lock and re-read the Case,
its current version and stage, current Primary Advisor relation, actor role and
case visibility, approved manifest, P1-07 assessment status/blockers, and
idempotency record. It must then re-evaluate the exact policy before appending
the immutable transition fact, applying the controlled Case stage/version
update, writing audit/outbox effects, and finalizing the idempotency result.
A failed transaction commits no partial state or effects.

`modules/cases/infrastructure/transition-runtime.ts` deliberately provides no JSON, mock,
Neon, or cloud fallback. Production fails closed with `503 SERVICE_UNAVAILABLE`
until the approved RDS transaction adapter is composed.

## Error Contract

| Internal condition | Public result |
| --- | --- |
| Invalid path/body/idempotency framing | `400 INVALID_REQUEST` |
| Missing rollback reason or incomplete assessment/manifest blocker | `422 VALIDATION_FAILED` |
| Current Primary Advisor, Founder, or case-visibility failure | `403 FORBIDDEN` |
| Hidden/nonexistent Case | `404 NOT_FOUND` |
| Unsupported transition or idempotency payload conflict | `409 CONFLICT` |
| Stale expected version | `409 STALE_VERSION` |
| No approved Case-transition runtime/RDS adapter | `503 SERVICE_UNAVAILABLE` |

## Deterministic Evidence

`node --test tests/integration/case-transition-workflow.test.ts` passes `5/5`
tests covering:

1. Primary Advisor `signed -> background_collection` success only after complete manifest and assessment evidence, with transition fact, audit, outbox, and idempotency result.
2. Incomplete evidence denial with no Case/effect mutation.
3. Founder-only immediate rollback with a non-empty reason; Advisor and empty-reason rollback denials.
4. Case visibility, incorrect Primary Advisor, stale version, and unsupported target denial.
5. Exact idempotency replay plus an injected pre-commit failure that leaves no partial fact, audit, outbox, or idempotency state.

`./node_modules/.bin/tsc --noEmit --pretty false` passed with no diagnostics.
`node --test tests/architecture/module-boundaries.test.ts` passed `6/6`.
`pnpm lint` and `pnpm build` were not run because `erp-frontend/AGENTS.md`
forbids them without separate explicit authorization.

## Remaining Runtime And Schema Gates

P0-07 currently makes `cases_service_cases.stage` immutable after creation and
does not provide a Case-transition fact table. This implementation does not
weaken or alter that contract. Before a real Case can transition, data/security
owners must approve an additive migration and RDS transaction implementation
that provide controlled stage mutation, an append-only transition fact, the
required locking/authorization/evidence reads, idempotency retention, audit and
outbox writes, RLS negative cases, and timeout/retry behavior. No local source
or test authorizes that migration, an RDS write, an external Identity action,
or deployment.
