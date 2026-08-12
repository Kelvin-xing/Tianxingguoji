# P1-15 In-App Outbox Delivery Evidence

| Control | Value |
| --- | --- |
| Ticket | `P1-15` Transactional outbox produces one minimal in-app notification |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-023`, `DEC-032`, `DEC-033` |
| External state | No RDS/Neon write, migration execution, queue configuration, Cognito call, email/SMS/provider call, deployment, commit, or push was performed |

## Scope And State

P1-15 adds one HK worker seam for P1-13 Task and P1-14 ServiceCase transition
outbox effects only. It supports the following producer event types:

- `tasks.task_transitioned`
- `cases.service_case_stage_transitioned`

The worker exposes no external provider integration and creates no email,
SMS, WhatsApp, webhook, broad template, or Case workspace UI. The only
notification content is the P0-11 fixed in-app pending-item code and text:
`PENDING_ITEM` and `A pending item needs attention.`

```text
P1-13/P1-14 producer: business fact + audit + pending outbox    (one transaction)
                                          |
                                          v
P1-15 worker: pending -> processing lease -> delivered
                    |             |            + unread notification + delivered receipt
                    |             + access lost + suppressed notification + compensated receipt
                    + transient failure -> pending retry
                    + third failure -> dead_letter + suppressed notification + failed receipt
```

Notification delivery is intentionally outside the producer transaction. A
delivery retry, suppression, or DLQ outcome never reverses the Task or
ServiceCase fact, its producer audit event, or its original outbox effect.

## Invariants And Owners

| Invariant | Enforcement owner |
| --- | --- |
| Producer commits only fact, audit, and pending outbox atomically | Existing P1-13 `TaskWorkflowRepository` and P1-14 `CaseTransitionRepository`; P1-15 does not change either module |
| Worker claims one eligible effect with a bounded lease | `InAppNotificationRepository.claimNextInAppDelivery`; real RDS adapter must lock one pending P1-13/P1-14 outbox row |
| One effect creates at most one notification and receipt | Unique organization-scoped `(in_app.pending_item, outbox idempotency key)` effect key in P0-11 notification and receipt tables |
| Recipient receives only a generic pending-item signal | P0-11 `buildPendingItemNotification` fixes channel, code, and text; worker work items contain opaque IDs only |
| Lost access prevents visible delivery | Completion transaction rechecks current recipient access immediately before insert; it writes `suppressed` plus a `compensated` receipt instead of an unread notice |
| Duplicate/replay returns the existing receipt | Claim and completion ports return the existing receipt rather than inserting a second notification |
| Delivery failure never changes the producer fact | Failure port transitions only worker/outbox delivery state; attempts one and two requeue, attempt three creates a suppressed `failed` receipt and moves the effect to `dead_letter` |
| No local production fallback exists | `modules/notifications/runtime.ts` throws until the approved HK RDS worker composition is configured |

The Notification module owns `Notification` and `DeliveryReceipt`; AuditOperations
continues to own `Outbox`. The worker reads an opaque delivery work item from
the notification repository and does not import Task or Case internals or write
their business tables.

## Delivery Contract

`InAppNotificationService` validates only worker-safe facts: opaque UUIDs,
the two approved producer event types, a bounded attempt count, lease version,
and a safe original outbox idempotency key. It creates the candidate unread and
suppressed records using the same unique effect identity. The repository chooses
exactly one only after its in-transaction access recheck.

The `in_app.pending_item` effect key pairs with the immutable producer outbox
idempotency key. A duplicate claim returns that receipt. A terminal delivery
failure deliberately writes a `suppressed` notification so the P0-11 receipt
foreign key remains valid while no notice is visible to the revoked or
undeliverable recipient.

No HTTP endpoint was needed for this worker-only ticket; consequently no new
P0-03 API surface was introduced. Existing producer APIs retain their P0-03
versioned envelope and their existing error mappings.

## Deterministic Evidence

`node --test --test-reporter=tap tests/integration/in-app-notification-delivery.test.ts tests/integration/task-workflow.test.ts tests/integration/case-transition-workflow.test.ts`
passed `16/16` cases:

1. A P1-13 task-transition effect creates one unread minimal notification and
   one delivered receipt without sensitive content.
2. Access revoked after the P1-14 effect is claimed is rechecked before insert
   and results in one suppressed notification plus compensated receipt.
3. Replaying the same outbox ID returns the original receipt and creates no
   second notification.
4. Three injected delivery failures requeue twice, then dead-letter exactly
   once with a suppressed failed receipt while the producer fact remains.
5. The unconfigured runtime fails closed.
6. The P1-13 and P1-14 workflow suites remain green in the same command,
   proving P1-15 did not alter producer business-fact behavior.

No browser, real RDS, queue, external provider, Cognito, TOTP, or deployment
behavior is claimed by this synthetic evidence.

## External Gate And Limitation

Before enabling this worker, data, security, and operations owners must approve
one HK RDS adapter that uses a transaction-safe lease claim (for example,
locked pending rows with a lease/version predicate), resolves a candidate
recipient from the authorized Task or Case relation without placing personal or
case data in the outbox payload, and rechecks current organization/case access
in the same completion transaction that inserts the notification/receipt and
terminal outbox status.

The adapter must preserve P0-11 constraints and demonstrate unique-effect race
handling, lease expiry/recovery, bounded retries and DLQ/redrive, failed-claim
reconciliation, append-only audit/outbox behavior, redacted logs/metrics,
HK-only queue/log/backup placement, and same-/cross-organization access denial.
No local code authorizes a migration run, real queue message, RDS write,
provider credential, external notification, or production worker enablement.
