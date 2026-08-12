# Outbox And Projection Alerts

## Trigger

`outbox.stuck` fires when the oldest pending message reaches 300 seconds.
`dashboard.projection_mismatch` fires on one canonical rebuild/live hash
mismatch. Both thresholds are versioned pilot defaults rather than SLAs.

## Stop State

Stuck effects remain durable and are not recreated. Projection mismatch marks
the dashboard stale; current request-time authorization still shapes every
read. Neither condition transfers write authority to Operations, and stale
projection data must never grant access.

## Safe Evidence

Use alert/occurrence ID, request ID, organization UUID, opaque aggregate/outbox
or projection snapshot ID, safe event type, state, attempt count, lease version,
age, and hash equality boolean. Do not record notification body, Case/Student
label, raw before/after state, URL, object key, token, or free-text reason.

## Triage

Notification Operations owns outbox triage; Operations is backup. Operations
owns projection triage; CaseWorkflow is backup. In at most two read-only
checks, confirm committed audit/outbox linkage or compare canonical rebuild
hashes and projection state. Never create a second effect or activate a rebuilt
projection from this runbook. A delivery retry must retain its idempotency and
lease contract and maximum three attempts.

## Recovery And Close

Close outbox alerts only after each effect has one delivered/suppressed or
reviewed dead-letter receipt and the detector recovers for a full window. Close
projection alerts only after a deterministic rebuild matches the authoritative
source and a separately authorized activation is evidenced. Silence, row
deletion, or changing the expected hash is not recovery.

## Escalation And Terminal States

Founder receives business-hours escalation. Duplicate effects, hash mismatch
after two checks, missing authority, or exhausted attempts ends at
`needs_human`; reconciled evidence may end at `closed`. No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
