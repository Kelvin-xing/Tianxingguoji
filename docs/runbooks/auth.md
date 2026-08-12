# Authentication And Revoke Alerts

## Trigger

`auth.failure_burst` fires at 10 authentication failures in five minutes.
`auth.revoke_backlog` fires when the oldest pending Cognito revoke reaches ten
minutes. These are versioned pilot detector defaults, not SLAs.

## Stop State

Authentication policy continues to fail closed. A disabled RDS user and its
local sessions remain denied regardless of Cognito backlog. Do not re-enable a
user, restore an old session, or weaken TOTP/session controls to clear an alert.

## Safe Evidence

Use only alert/occurrence ID, request ID, optional organization UUID, detector
count/age, retry attempt count, safe error code, outbox/work state, and redacted
receipt ID. Do not record email, name, provider subject, token, cookie, invite
secret, IP-derived identity, raw provider payload, or free-text disable reason.

## Triage

Identity Operations owns triage; Security or Operations is backup and Founder
owns business-hours escalation. Check detector freshness, current RDS denial,
lease/attempt count, and whether work is `pending`, `processing`, `delivered`,
or `dead_letter`. Perform at most two read-only diagnostic checks. A provider
retry is permitted only through the separately approved worker, its existing
idempotency key, and its three-attempt ceiling.

## Recovery And Close

Close only after the failure detector returns below threshold for one complete
window, every affected revoke is delivered or has a reviewed dead-letter
receipt, local denial is still authoritative, and the owner records redacted
reconciliation evidence. Alert silence alone is not recovery.

## Escalation And Terminal States

Normal alerts are handled during business hours. Repeated failure, missing
receipt, unsafe evidence, unavailable owner, or exhausted worker attempts ends
at `needs_human`; valid evidence may end at `closed`. No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
