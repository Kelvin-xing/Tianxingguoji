# P2-09 Alert Catalogue And Business-Hours Runbooks

| Control | Value |
| --- | --- |
| Ticket | `P2-09` Alert catalogue and business-hours runbooks are actionable |
| Date | 2026-08-10 (Asia/Hong_Kong) |
| Run identifier | `p2-09-alert-catalogue-20260810` |
| Decision inputs | `P2-07`, `P2-08`, resolved `OD-11`, `DEC-023`, `DEC-035`, `DEC-039`, `DEC-057` |
| External state | No monitoring service, scheduler, network/cloud/DB call, remediation, replay, purge, restore, warning acceptance, commit, push, deployment, deletion, or release action is authorized |

## Problem, Stakeholders, And Boundary

Operations needs a deterministic answer to what each Release 1 alert means,
who owns it, what evidence is safe to inspect, when work must stop, and how the
incident reaches a terminal state. The Founder is the approved business-hours
escalation owner. Identity, Document, Notification, Privacy/Security, and
regional-runtime owners need bounded runbooks that preserve their module
authority. Families need alerting that cannot become another PII disclosure
path.

In scope: an immutable versioned local catalogue; typed detector, threshold,
window, severity, escalation, owner/backup, deduplication/cooldown, stop-state,
and runbook contracts; PII-safe event construction; and five operator
runbooks. The minimum inventory covers authentication failures, Cognito revoke
backlog, scan latency/DLQ, stuck outbox, a PII canary, HK region health,
dashboard projection mismatch, and the three approved monthly pilot budgets.

Out of scope: provisioning a metric/log sink or budget action, installing a
schedule, real notification, automatic remediation, replaying or purging work,
restoring or switching an endpoint, accepting crawler warnings, changing
cloud configuration, declaring an incident resolved from one metric, and any
24/7 on-call commitment. An alert is evidence, not authorization.

## Identity, State, And Ownership

An alert definition is identified by stable `alertId` plus
`catalogueVersion = alert_catalogue_v1`. A firing occurrence has a separate
opaque occurrence ID. Definitions are immutable in a version: any detector,
threshold, severity, owner, or runbook change requires a new catalogue version
or an explicitly reviewed replacement; disabling a noisy rule without a
replacement is not a pass.

Severity is `warning`, `high`, or `critical`. Incident state is
`firing -> acknowledged -> mitigated -> closed`; any active state may enter
`needs_human`, while `closed` is terminal. Closing requires the runbook's
detector recovery, reconciliation evidence, and owner receipt; alert silence
alone is insufficient. The catalogue is owned by Operations, while each entry
names its operational owner and backup owner. Founder owns business-hours
escalation. A suspected material PII/security event follows immediate incident
policy; this exception does not create a general 24/7 on-call promise. An HK
region outage remains fail-closed and queues a request-ID-only incident for
Founder handling in the next staffed business period if detected out of hours.

Each definition declares its detector input, comparator, threshold and window.
The non-cost numeric values are conservative, versioned pilot detector
defaults for local contract testing rather than measured SLIs or SLAs. OD-11
is authoritative for monthly RDS `$150`, S3 `$25`, and runtime/logging `$300`
limits and their `50/80/100%` alert levels. A 100% budget event requires the
named `pause_nonessential_work` stop state; it never disables security/audit
controls or deletes data.

## Deduplication, Payload, And Failure Contract

Each alert declares a deduplication dimension and cooldown. Repeated samples
inside the cooldown update one occurrence's count/evidence in the future
monitoring adapter; they do not create unbounded messages. A cooldown never
suppresses a transition to a higher severity. Real adapter storage and
concurrency semantics require a later approved implementation.

The only event fields are catalogue-derived alert/detector/threshold/window
facts plus opaque occurrence ID, request ID, optional organization UUID,
timestamp, observed numeric value, and incident state. There is no arbitrary
metadata or free-text reason field. Unknown IDs, versions, keys, states,
non-finite values, malformed identifiers, and observed values below the
declared firing threshold fail closed. Raw PII, tokens, invite secrets,
document/message content, URLs, bucket/object keys, provider payloads, and
free-text reasons are structurally rejected. Application logs remain 30 days
and audit evidence one year in HK under DEC-039; alert payloads do not extend
retention.

Alert creation has no side effect. Any future adapter must persist/send only
the typed safe payload and must not treat `stopState` as permission to mutate
business, queue, document, database, or cloud state. Unknown configuration
stops as `needs_human`; it must not fall back to a permissive default.

## Runbook And Loop Contract

Every runbook specifies trigger, impact/stop state, safe evidence, owner and
backup, bounded triage, recovery proof, escalation, and terminal state. The
common loop permits at most two diagnostic checks or one approved service
retry with the same idempotency/lease contract. Repeated deterministic failure,
missing authority, unsafe evidence, or unavailable HK dependencies ends at
`needs_human`; operators do not improvise a replay, purge, restore, failover,
warning acceptance, or cloud change.

The region runbook distinguishes component degradation from an HK-region
outage. Upload/download/export and affected writes remain fail-closed; no
cross-region replica or endpoint switch is permitted. The PII runbook permits
immediate security/privacy escalation but forbids copying the matched value
into tickets, chat, logs, or alert evidence.

## Acceptance Evidence And Budget

The public seams are catalogue lookup/validation and safe event construction.
Focused tests must prove every entry has detector, threshold/window, severity,
owner/backup, escalation, dedup/cooldown, runbook and stop state; the required
inventory and OD-11 thresholds exist; unknown configuration fails closed; and
unsafe/extra payload fields are rejected. Documentation tests must prove each
catalogue runbook exists and contains the operator contract headings.

Local focused runs have a 60-second target and at most two corrective attempts.
The intended terminal states are `passed`, `needs_human`, or
`blocked_external`. `pnpm lint` and `pnpm build` remain prohibited without
separate authorization. Operations and Privacy must review the catalogue and
runbooks before any monitoring rule is provisioned; exact provider budget
actions require a separately approved cloud payload.

## Pre-Implementation Evidence Plan

1. RED: the focused public-contract test fails because the catalogue module
   and runbooks do not yet exist.
2. GREEN: minimal immutable definitions and event validation satisfy the
   inventory, OD-11, fail-closed, and payload tests.
3. Regression: rerun the focused alert suite with existing audit/outbox,
   identity revoke, document scan, and dashboard projection tests; inspect the
   scoped diff and run `git diff --check`.
4. Record exact results here. Do not claim lint, build, cloud, DB, alert
   delivery, retention enforcement, or incident-response evidence.

## Local Verification Record

- RED: `node --test tests/unit/operations/alert-catalogue.test.ts` failed with
  `ERR_MODULE_NOT_FOUND` for the not-yet-created catalogue module.
- GREEN: the same focused suite passed `7/7`, covering complete immutable
  definitions, required detector inventory, OD-11 cost levels, unknown
  identity/version denial, typed PII-safe occurrence payloads, extra-field and
  below-threshold denial, legal state transitions, and actionable runbook
  structure.
- Focused plus contract regression:
  `node --test tests/unit/operations/alert-catalogue.test.ts tests/integration/outbox-audit.test.ts tests/integration/identity-revoke-workflow.test.ts tests/integration/document-scan-workflow.test.ts tests/integration/case-dashboard-projection.test.ts`
  passed `32`, failed `0`, with one expected PostgreSQL integration skip because
  `TEST_DATABASE_URL` is unset (`33` tests total).
- Scoped `git diff --check` returned exit `0`. The P2-09 files are new and
  untracked, so final source review additionally checked their complete content;
  no unrelated file was edited.
- A bounded `tsc --noEmit --pretty false --incremental false` emitted no
  diagnostics, but the tool did not return a reliable exit status. No typecheck
  pass is claimed and the check was not retried under the ticket budget.
- `pnpm lint` and `pnpm build` were not run under repository rules. No database,
  monitoring, scheduler, network/cloud, alert delivery, browser, retention,
  incident, or real PII evidence was accessed.

## Remaining Operational Gates

Operations and Privacy must review and version the non-cost pilot detector
defaults, owner roster, business-hours schedule, cooldown/dedup persistence,
and exact provider mapping before provisioning. A later approved adapter must
prove higher-severity non-suppression, occurrence concurrency, 30-day
application-log and one-year audit retention, HK-only sinks/archive/support
access, PII scanning, and runbook exercises. OD-11 provider budget actions,
alert delivery destinations, region-health probes, any worker replay, and any
resume/restore/cloud mutation each require a separately approved exact payload.
