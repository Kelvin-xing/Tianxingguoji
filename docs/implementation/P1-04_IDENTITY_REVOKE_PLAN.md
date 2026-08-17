# P1-04 Identity Disable And Cognito Revoke Plan

| Control | Value |
| --- | --- |
| Ticket | `P1-04` Disable immediately denies and eventually reconciles Cognito revoke |
| Date | 2026-08-06 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapters` |
| Decision inputs | `DEC-007`, `DEC-020`, `DEC-023`, `DEC-032` |
| External state | No RDS migration execution, Cognito call, scheduler, deployment, commit, or push action performed |

## Problem And Scope

Disabling an internal account cannot depend on Cognito availability. The
Identity module must make the Hong Kong authority reject existing opaque
sessions immediately, then reconcile the provider-session revoke as a bounded
external effect with evidence of its terminal outcome.

In scope: the server-only `IdentityRevokeWorkflow` command/query seams, one
transactional repository port, a bounded Cognito reconciliation worker,
synthetic failure injection, and additive receipt migration `010`.

Out of scope: an account-management HTTP route/UI, authorization policy for
who may issue a disable command, re-enable, an installed worker schedule,
actual RDS composition, running migration `010`, a Cognito User Pool call, or
any real account data. The workflow receives a previously authorized actor
context; an adapter may not substitute that context with client-supplied data.

## Invariants And Ownership

- `Account Disable` is the only Release 1 transition represented here:
  `active -> disabled`. An invited User is rejected, and a disabled User has no
  implicit re-enable path.
- The Identity repository owns one atomic command: set User status to
  `disabled`, increment both `record_version` and `session_version` exactly
  once, revoke active local sessions, append the redacted audit event, and
  create the Cognito revoke outbox effect. It never calls Cognito in that
  transaction.
- A disable command carries the current `expectedRecordVersion`; a mismatch is
  rejected before any access change, audit/outbox write, or provider effect.
- Every session lookup compares its immutable captured version to the current
  User version and current status. Provider timeout, denial, or DLQ cannot
  restore access.
- One actor/organization/operation/idempotency-key tuple maps to at most one
  revoke effect. A byte-identical replay returns the original effect reference;
  a different command using the same key is rejected.
- A worker leases work with a version token. Late/concurrent completion is
  rejected by the repository. Transient failure retries after 60 seconds, then
  five minutes; no fourth provider attempt is legal.
- Terminal work is `delivered` or `dead_letter` and has exactly one minimal
  `Revoke Receipt`. The receipt does not include provider subject, tokens,
  email, or raw provider payload.

`identity_users` and `identity_sessions` already enforce the status/session
version relationship in migration `001`. Migration `010` adds
`identity_cognito_revoke_receipts`, linked to the tenant-scoped audit outbox
and protected by the same `tianxing_app` RLS policy. Its trigger verifies the
same IdentityUser aggregate, idempotency key, attempt count, and terminal
outbox state before accepting one append-only receipt. The production RDS
repository must implement each terminal outcome and its receipt in one
transaction; the in-memory adapter is only a deterministic contract adapter.

## Public Interfaces

`modules/identity/application/revoke-workflow.ts` exposes:

- `IdentityRevokeWorkflow.disableUser(command)`: validates identifiers and
  expected record version, validates reason/idempotency codes, creates matching
  audit/outbox evidence, then asks the repository for the atomic local
  transition. It returns the new record/session versions.
- `IdentityRevokeWorkflow.getCognitoRevokeStatus(revokeWorkId)`: returns only
  work state, attempt count, and a minimal terminal receipt.

`workers/reconcile-cognito.ts` exposes `reconcileCognitoRevokes(...)`. It is a
bounded invocation (`1..100` work items), not an unbounded loop. Its result is
an observable count of claimed, delivered, retried, and dead-lettered items.
The Cognito client port accepts only an opaque request ID and provider subject;
its provider error contract must expose a safe code plus whether the error is
retryable.

## Recovery Loop Contract

| Field | Contract |
| --- | --- |
| Trigger | Approved worker schedule, manual Operations invocation, or reconciliation run |
| Goal | Every due revoke effect reaches `delivered` or `dead_letter` with one receipt |
| Snapshot | Committed User/session/audit/outbox state and lease version |
| Allowed actions | Claim one due effect, call Cognito once, write a lease-guarded outcome |
| Evidence | Outbox state, attempt count, terminal receipt, and redacted audit linkage |
| Feedback | Safe provider code and retryability only; no raw token, subject, or email in telemetry |
| Budget | 5-second provider timeout in the production adapter; three total attempts; 30-second lease; 60-second then 5-minute backoff |
| Terminal state | `delivered`, `dead_letter`, or `needs_human` for a failed receipt requiring Operations review |
| Escalation | Identity/Operations receives effect ID, request ID, attempt count, safe failure code, and receipt state |

An unknown or deterministic provider error becomes `dead_letter` immediately.
Only an explicitly transient error may retry. A duplicate/late worker result is
a lease conflict and must not create another receipt.

## Deterministic Evidence

`tests/integration/identity-revoke-workflow.test.ts` uses only public Identity
and worker seams with a synthetic Cognito fake. It proves:

1. Local session rejection happens before a provider timeout can be reconciled.
2. Three transient timeouts produce one `dead_letter` effect and one failed
   receipt, with three provider calls total.
3. A replayed disable has one effect; timeout then success produces one
   delivered receipt and no work on the following reconciliation pass.
4. An invited User cannot bypass the approved `active -> disabled` lifecycle.
5. A stale User version leaves local session access and revoke work unchanged.
6. Migration `010` keeps receipt data tenant-scoped, outbox-linked, bounded to
   three attempts, free of provider identity/token/email fields, and matched to
   the terminal outbox aggregate/effect/attempt count by a database trigger.

## External Execution Gate

Before running a real disable or reconciliation, Identity, Operations,
Security, and Privacy owners must approve one exact payload containing the
Cognito User Pool/client and revoke API settings, the 5-second timeout and
error classifier, worker schedule/queue/DLQ, IAM permissions, HK log/audit
destination, migration `010` plan, RLS/tenant negative tests, idempotency and
lease concurrency tests, named on-call owner, and the reviewed re-enable
approval workflow.

No local test, migration source file, or plan in this document authorizes
those actions.
