# Product Telemetry Degraded State

## Trigger

`telemetry.sink_degraded` fires when a policy-valid product telemetry event
cannot be written to the approved Hong Kong sink. The producer drops that
event and records one Operations degraded-state receipt. It does not replay the
business command that produced the event.

## Stop State

Product telemetry remains non-authoritative: ordinary business mutations may
continue when their own authorization and mandatory audit transaction succeeds.
If mandatory audit cannot persist in that mutation transaction, the mutation
must fail closed with `AUDIT_UNAVAILABLE`. A telemetry outage never disables,
replaces, or weakens mandatory audit.

## Safe Evidence

Use only the alert/occurrence ID, request ID, optional organization UUID, fixed
component `product_telemetry_sink`, state/version, stable failure code,
timestamps, policy/schema versions, and delivered/dropped counts. Do not record
the event payload, actor/session/case identifiers beyond the approved opaque
receipt, raw adapter errors, query strings, request bodies, content, tokens,
URLs, or free-text reasons.

## Triage

Operations owns triage and Privacy is backup. Perform at most two metadata-only
checks: confirm the approved sink identity/region and run the typed sink probe.
Do not retry or reconstruct dropped business mutations. A later telemetry event
may be delivered once the sink recovers, but it must not backfill the outage.

## Recovery And Close

Keep the state degraded until a successful typed probe and an atomic Operations
state transition to healthy are recorded. Reconcile only telemetry delivery and
alert receipts; never infer missing business facts from telemetry. The alert may
close after the recovery receipt and the full detector window are reviewed.

## Escalation And Terminal States

Missing degraded-state evidence, an unsafe payload, uncertain sink residency,
failed probe, repeated state-write failure, or mandatory-audit interruption
ends at `needs_human`. A reviewed probe, healthy state transition, and complete
window may end at `closed`.

No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
