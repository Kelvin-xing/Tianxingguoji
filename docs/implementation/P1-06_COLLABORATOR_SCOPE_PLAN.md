# P1-06 Bounded Collaborator Scope Grant And Revoke

| Control | Value |
| --- | --- |
| Ticket | `P1-06` Primary Advisor grants/revokes one bounded collaborator scope |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-007`-`DEC-011`, `DEC-029`, `DEC-032`, `DEC-046` |
| External state | No RDS write, migration execution, Cognito call, worker schedule, deployment, commit, or push action performed |

## Scope And Boundary

This ticket implements one scope-grant decision for one Advisor on one active
K12 case. It creates or reuses the case's `CaseCollaborator` relationship and
creates exactly one `ScopeGrant` in the same repository transaction. An
ordinary scope begins `active`; `identity_contact` and `internal_notes` begin
`pending_approval` and are not access grants until a distinct Founder approval
is persisted by a later approved command.

The public commands are:

- `POST /api/v1/cases/:caseId/collaborators`: one collaborator user, one
  scope, one capability, optional shorter expiry, and one `Idempotency-Key`.
- `POST /api/v1/cases/:caseId/collaborators/:collaboratorId/grants/:grantId/revocations`:
  one expected grant version, reason, and `Idempotency-Key`.

Both routes require a current opaque session plus TOTP re-authentication. They
are thin BFF adapters over `AccessScopeService`; no route owns role, case, or
grant authorization. `modules/access/infrastructure/runtime.ts` remains fail closed until an
approved HK RDS composition installs the production transaction adapter.

Out of scope: Founder sensitive-grant approval, collaborator removal, case
transfer, break-glass access, bulk grants, grant renewal, UI, RDS adapter
implementation, real data, and any Cognito or database action. `OD-07` still
blocks absence/break-glass/bulk semantics; this ticket denies them by omission.

## State And Enforcement

```text
ordinary grant:  create -> active -> revoked | expired
sensitive grant: create -> pending_approval -> active -> revoked | expired
```

The existing P0-05 database trigger allows only the transitions above. This
ticket does not introduce an unsupported `pending_approval -> revoked`
transition.

| Invariant | Enforcement owner |
| --- | --- |
| Only the current Primary Advisor can issue or revoke a scope | RDS repository locks and verifies the case primary binding in the command transaction; synthetic adapter proves the port behavior |
| Target is an active Advisor in the same organization, never a Contractor | RDS repository resolves membership/Advisor binding in the command transaction; P0-05 composite FKs constrain persisted collaborator rows |
| One command contains one predefined scope and `view`, `comment`, or `edit` capability | route parser plus `AccessScopeService` and `modules/access/domain/policy.ts`; P0-05 checks persist the catalogue |
| Start is now, expiry is positive and no later than seven days | `resolveGrantExpiry`; P0-05 duration check; repository rejects inactive/closed cases so a new grant cannot outlive an active case |
| Sensitive scopes require a non-empty reason and begin pending Founder approval | `AccessScopeService`; P0-05 sensitive initial-state and approval constraints |
| Collaborator export is always denied | existing `evaluateScopeGrant` short-circuits `export`; no export capability exists in P0-05 schema |
| Revocation and expiry deny at the next request | request-time `evaluateScopeGrant`; revocation transaction changes grant status before commit returns |
| Writes preserve optimistic concurrency | revocation requires `expectedRecordVersion`; repository maps version mismatch to `COLLABORATOR_SCOPE_STALE_VERSION`, then route returns `409 STALE_VERSION` |
| Same idempotency key replays only its original result | repository-scoped idempotency ledger in the same transaction; changed request hash is rejected before facts/effects are written |
| Grant/revoke plus audit/outbox are atomic and redacted | repository transaction port receives `MutationEffectBundle`; `modules/audit/domain/contract.ts` allowlists safe event data only |

The production adapter must read the current case primary, active case state,
target Advisor binding, collaborator tuple, idempotency row, and revoke version
under one RDS transaction. It must map a closed/nonexistent case without
leaking cross-organization information, use row locking or an equivalent
serialization rule, and never fall back to local JSON, Neon, or the test
adapter.

## Error Contract

| Internal condition | Public API result |
| --- | --- |
| Invalid UUID, command shape, scope/capability, reason, expiry, or key | `422 VALIDATION_FAILED` after valid request framing; malformed JSON/missing idempotency header is `400 INVALID_REQUEST` |
| Missing or invalid session | `401 UNAUTHENTICATED` |
| Caller is not the current Primary Advisor | `403 FORBIDDEN` |
| Target is not an active Advisor | `422 VALIDATION_FAILED` |
| Case is inactive or not visible in the command context | `404 NOT_FOUND` |
| Idempotency conflict, duplicate active grant, or terminal grant revoke | `409 CONFLICT` |
| Stale revoke version | `409 STALE_VERSION` |
| No approved identity/access runtime | `503 SERVICE_UNAVAILABLE` |

Error bodies use the P0-03 versioned envelope, fixed messages, request ID, and
no internal row, role, reason, or provider details.

## Deterministic Evidence

`tests/integration/collaborator-scope-workflow.test.ts` passes 6/6 focused
tests:

1. Ordinary grant creates one collaborator/scope decision, defaults to exactly
   seven days, becomes usable, expires at the boundary, and still denies export.
2. Revoke with the current version becomes unusable immediately and produces a
   second audit/outbox effect.
3. Exact idempotency replay has no second effect; changed key reuse is denied.
4. Sensitive contact scope records `pending_approval` and cannot authorize
   access.
5. Overlong expiry and a non-Primary Advisor are denied without partial facts.
6. A simulated pre-commit failure leaves collaborator, grant, audit, and
   outbox counts at zero.

Additional local checks passed:

- `node --test tests/integration/collaborator-scope-workflow.test.ts tests/architecture/module-boundaries.test.ts`: 12 pass, 0 fail.
- `node --check` for access policy/service/runtime and both collaborator route
  handlers: pass.
- `./node_modules/.bin/tsc --noEmit --pretty false`: pass with no diagnostics.
- `git diff --check`: pass.

`pnpm lint` and `pnpm build` were not run because `erp-frontend/AGENTS.md`
prohibits them without separate explicit authorization. This ticket has no RDS
adapter or browser journey, so it does not claim runtime PostgreSQL locking,
route session wiring, or UI/a11y evidence. P1-17 remains the owner of the full
negative vertical failure suite.

## External Execution Gate

Before enabling this command against an RDS environment, security, data, and
operations owners must approve the exact RDS transaction implementation,
cross-tenant negative tests, case-close race behavior, lock/isolation and
timeout policy, idempotency row retention, alerting for sensitive/abnormal
access, and the HK runtime composition payload. No local source file or test
authorizes an RDS migration, data write, Cognito action, deployment, or real
collaborator access.
