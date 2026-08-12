# Identity Revoke Reconciliation Runbook

## Boundary

This runbook covers a committed `identity.user_disabled` outbox effect. It
does not authorize Cognito calls, RDS writes, migration execution, scheduler
installation, account re-enable, or a retry beyond the three-attempt budget.

The application access decision is already final before this runbook starts:
the User is disabled and current local sessions are rejected. Cognito outcome
changes only the provider-side reconciliation evidence.

The original disable command must have passed its `expectedRecordVersion`
guard. A stale command creates neither access change nor revoke work; it must
be reread and reauthorized through the future account-management workflow,
not retried by this runbook.

## Inspect

Use the Operations query path with a tenant-scoped connection to retrieve the
effect ID, audit request ID, outbox state, attempt count, lease version, and
minimal revoke receipt. Do not place provider subject, tokens, email, or raw
error payload in tickets, logs, or ad hoc commands.

Expected states:

| State | Meaning | Next action |
| --- | --- | --- |
| `pending` | Due now or waiting for the bounded backoff | Let an approved worker claim it |
| `processing` | A worker holds the 30-second lease | Do not concurrently replay; wait for lease expiry or terminal result |
| `delivered` | Cognito revoke succeeded and one delivered receipt exists | Close as reconciled |
| `dead_letter` | No further automatic retry is legal; failed receipt exists | Identity/Operations review the safe failure code |

## Approved Worker Invocation

Only an approved worker runtime may call the bounded
`reconcileCognitoRevokes` entry point. The production Cognito adapter must
enforce a five-second call timeout and classify only verified transient
failures as retryable. Its two backoffs are 60 seconds and five minutes; the
third failure is terminal.

Capture only effect ID, request ID, state, attempt count, safe error code,
receipt outcome, UTC time, and reviewer identity. A worker lease conflict is
evidence of a concurrent/late worker, not permission to bypass the repository
or create another receipt.

## Stop And Escalate

Stop automatic replay at `dead_letter`, after a non-transient provider error,
or if identity/RLS/audit/outbox consistency is missing. Escalate to the named
Identity and Operations owners with the minimal evidence above. They may
investigate provider configuration and approve a new, idempotent remediation
only after confirming the account remains disabled.

Re-enable is not a repair action in this runbook. It requires the separately
approved future workflow and must create new audit evidence; no row or receipt
may be rewritten.
