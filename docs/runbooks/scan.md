# Document Scan And DLQ Alerts

## Trigger

`scan.stuck` fires when the oldest scan age reaches 180 seconds.
`scan.dead_letter` fires on the first scan DLQ item. The 180-second threshold is
a pilot default around the approved 120-second scan target, not an SLA.

## Stop State

The document remains quarantined and unavailable. A failed, unknown, late, or
dead-lettered result may not activate a version, issue a download/export, or
be treated as clean. Upload/download/export remain fail closed in an HK outage.

## Safe Evidence

Use alert/occurrence ID, request ID, organization UUID, opaque document-version
ID, work ID, state, age, attempt count, safe scanner code, checksum comparison
result, and receipt ID. Never place object or bucket keys, URLs, document name,
content, scanner payload/signature text, student data, or free-text reason in
the alert, ticket, chat, or log.

## Triage

Document Operations owns triage; Operations or Security is backup. Confirm the
event/work identity, current quarantine state, lease version, attempt count,
and HK scanner/queue health using at most two read-only checks. Do not manually
edit a verdict. A retry may use only the approved scan worker and its maximum
three attempts; a DLQ item requires human review before any replay payload.

## Recovery And Close

Close only when detector age/count recovers for a full window, each affected
version is still quarantined or has one valid clean/rejected terminal result,
duplicate/reordered evidence reconciles, and the owner records a redacted
receipt. Deleting a DLQ item or suppressing the detector is not recovery.

## Escalation And Terminal States

Escalate to Founder in business hours when availability affects pilot work.
Attempt exhaustion, inconsistent verdicts, unsafe evidence, or unavailable HK
dependencies ends at `needs_human`; reconciled proof may end at `closed`. No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
