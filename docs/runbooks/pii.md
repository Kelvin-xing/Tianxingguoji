# PII Canary Alert

## Trigger

`privacy.pii_canary` fires on one raw canary match in an application log,
trace, DLQ/support artifact, or alert path. Zero raw matches is the only passing
threshold.

## Stop State

Fail closed the affected telemetry/support path without disabling mandatory
audit controls. Do not copy, quote, download, or move the matched value while
triaging. Business operations that cannot produce mandatory safe audit evidence
must stop.

## Safe Evidence

Use alert/occurrence ID, request ID, optional organization UUID, sink class,
policy/scanner version, count, first/last detected time, redaction rule ID, and
opaque evidence receipt only. Never place the matched canary, personal data,
token, secret, content, URL, object key, log line, screenshot, or free-text
reason in any alert, ticket, chat, or repository artifact.

## Triage

Privacy owns triage; Security is backup. This is the DEC-035 material-security
exception and is escalated immediately under incident policy. Confirm scanner
version and affected sink using no more than two metadata-only checks. Preserve
the authorized HK evidence in place; do not query broader data, relax scanning,
or delete evidence. Any containment change needs its own exact approval.

## Recovery And Close

Close only after the owner proves zero raw matches across the affected path for
a complete window, verifies the redaction rule with synthetic canaries, records
scope/retention and an opaque evidence receipt, and obtains Privacy/Security
review. Suppression, deletion, or a green self-check by the generator alone is
not closure.

## Escalation And Terminal States

Unsafe access, uncertain scope, missing evidence, a repeated match, or absent
Privacy/Security authority ends at `needs_human`; independently reviewed zero
match evidence may end at `closed`. No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
