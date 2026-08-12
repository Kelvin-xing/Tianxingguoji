# HK Region Health And Pilot Budget Alerts

## Trigger

`region.hk_unhealthy` fires after two consecutive failed HK health checks in
120 seconds. Monthly RDS `$150`, S3 `$25`, and runtime/logging `$300` budgets
fire at the approved 50/80/100 percent levels.

## Stop State

During an HK-region incident, affected sensitive writes and document upload,
download, and export remain fail closed with no cross-region fallback. At 100%
of a monthly limit, pause new nonessential work after the named human decision;
never delete data or disable mandatory security/audit controls. Alert evaluation
does not itself mutate a cloud resource or service.

## Safe Evidence

Use alert/occurrence ID, request ID, optional organization UUID, component
class, health-check count, region code `ap-east-1`, budget category, percentage,
approved limit, timestamp, and opaque receipt. Do not record endpoint URLs,
credentials, tokens, object keys, query/content samples, personal data, account
payloads, or free-text reasons.

## Triage

Operations owns triage and Founder is backup/business-hours escalation owner.
Use at most two read-only checks to distinguish one component failure from an
HK-region incident and to validate budget source/version. There is no 24/7
on-call promise: an out-of-hours region alert remains fail closed and queues
request IDs only for the next staffed period. Never switch region/endpoint,
restore, resize, purge, or change a provider budget from this runbook.

## Recovery And Close

Close region health only after HK service is healthy for a full window and
authorized reconciliation proves counts/hashes/linkage/audit continuity before
resume. Close a budget occurrence only with a verified cost-source reading and
Founder disposition; 100% remains paused until that decision. One successful
provider check or billing silence is insufficient.

## Escalation And Terminal States

Detected HK outages enter the region-incident path; Founder handles ordinary
budget and degraded-component events during business hours. Uncertain residency,
failed reconciliation, unavailable owner, repeated detector failure, or 100%
budget without disposition ends at `needs_human`; reviewed evidence may end at
`closed`. No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance.
