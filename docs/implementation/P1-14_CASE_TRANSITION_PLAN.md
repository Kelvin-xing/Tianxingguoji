# P1-14 Case Transition

| Control | Value |
| --- | --- |
| Ticket | `P1-14` Advisor performs one guarded Case transition and Founder rollback |
| Date | 2026-08-18 (Asia/Hong_Kong) |
| Local status | `accepted_local` |
| Decision inputs | Resolved `OD-04`; `DEC-010`, `DEC-027`, `DEC-041`, `DEC-044` |
| External state | Local migrations `024` through `026` applied to loopback PostgreSQL only; user accepted the slice and authorized its code commit/push; no RDS, Cognito, worker, or deployment action performed |

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

`modules/cases/infrastructure/transition-runtime.ts` composes
`PostgresqlCaseTransitionRepository` only in explicit `local-synthetic` mode.
There is no JSON, mock, Neon, or cloud fallback. Non-local modes continue to
fail closed with `503 SERVICE_UNAVAILABLE` until a separately approved RDS
composition exists.

Migration `024` adds the append-only
`cases_service_case_transition_facts` table and the tenant-bound
`cases_apply_service_case_transition` function. The application role cannot
update `cases_service_cases` directly; the function is the only granted stage
write boundary and rechecks actor, current Primary binding, version, stage,
approved manifest, assessment status, and blocker evidence.

Migration `025` bounds transition time and reason length, then takes final
shared locks while rechecking the active actor authority and assessment
evidence immediately before the Case update. Migration `026` preserves that
guard while giving its assessment and manifest PL/pgSQL variables unambiguous
names; this corrective migration was appended after the already-applied `025`
rather than rewriting migration history.

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

The focused workflow and PostgreSQL repository suites pass `8/8` tests
covering:

1. Primary Advisor `signed -> background_collection` success only after complete manifest and assessment evidence, with transition fact, audit, outbox, and idempotency result.
2. Incomplete evidence denial with no Case/effect mutation.
3. Founder-only immediate rollback with a non-empty reason; Advisor and empty-reason rollback denials.
4. Case visibility, incorrect Primary Advisor, stale version, and unsupported target denial.
5. Exact idempotency replay plus an injected pre-commit failure that leaves no partial fact, audit, outbox, or idempotency state.

The migration boundary and local runner suites pass `11/11`; architecture tests
pass `15/15`. Migration `024` moved the local ledger from 22 to 23 and public
tables from 61 to 62. The hardening and corrective dry-runs then selected only
`025` and only `026`; their applies moved the ledger to 25 without changing the
62-table count. Browser verification completed two Advisor advances and two
Founder rollbacks with reasons before a final Advisor advance. The final
synthetic Case is `background_collection` at record version 6 with five
transition facts, five audit events, five pending outbox rows, and five
completed idempotency records. Refresh preserved version 6, and a direct
`tianxing_app` table update was denied.

The repository-wide strict TypeScript check still reports existing unrelated
baseline diagnostics; the Phase 2C focused suites and runtime compilation did
not expose a Phase 2C failure. `pnpm lint`, `pnpm build`, and the full test suite
were not run under the current execution limits.

## Remaining Production Gate

Only the local synthetic database has migrations `024` through `026`. Before a
real Case can transition, data/security owners must separately approve the
production migration and RDS runtime composition, including production RLS
negative cases, timeouts, retries, recovery, monitoring, and deployment
evidence. This accepted local slice does not authorize an RDS write, external
Identity action, worker schedule, or deployment.
