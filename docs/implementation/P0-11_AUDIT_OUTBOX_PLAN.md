# P0-11 Audit, Outbox, Idempotency And Telemetry Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_database_evidence` |
| Ticket | `P0-11` |
| Candidate migration | `db/migrations/202608022530_007_expand_audit_outbox.sql` |
| Migration SHA-256 | `893f3853ec04ed27b15a79b1bfe8b62162bce2e33afd7549627c865913d705e8` |
| Runtime side effects | None |

## Problem And Boundary

P0-11 provides the shared write/effect primitives required by Release 1
without adding a business service or external notification provider. A
mutation can carry one matching append-only audit event and one redacted
outbox message. A repeated command or worker effect is represented by the
existing idempotency/effect receipt instead of a second side effect.

In scope: deterministic request hashing, scoped idempotency records,
append-only audit events, transaction-linked outbox messages, lease/retry
state, minimal in-app notifications, delivery receipts, safe JSON allowlists,
and telemetry fields that cannot carry raw PII-shaped values.

Out of scope: audit archive or log sink provisioning, worker execution,
external Email/SMS/WhatsApp, notification delivery outside the application,
real PII, RDS/Neon writes, cloud resources, routes/UI, purge/retention jobs,
commit, push, and deployment. The one-year audit and 30-day application-log
retention policies are recorded decisions; this ticket does not provision a
retention system.

## Invariants

- Idempotency scope is `(organization, actor, operation, key)` and the request
  hash is immutable. The same hash may replay a completed/failed result;
  reusing a key with another hash returns a conflict.
- A mutation bundle requires the same organization, aggregate/resource,
  event type/version, request ID, and audit event reference in both audit and
  outbox records.
- Audit events are append-only. They store actor/resource IDs, stable action
  names, optional state hashes, and allowlisted metadata; raw token, secret,
  document, content, and PII-shaped fields are rejected.
- Outbox messages are tenant-scoped and unique by idempotency key. They begin
  `pending`, lease through `processing`, and may finish only as `delivered` or
  `dead_letter`; retry release to `pending` is explicit, versioned, and capped
  at three attempts.
- Release 1 notification delivery is `in_app` only. Its content code is the
  fixed `PENDING_ITEM` notice and contains no Student, Guardian, Case, School,
  file, or free-text detail.
- A delivery receipt is unique by `(organization, effect type, effect key)`;
  its effect identity and linkage are immutable and its attempt count cannot
  decrease or exceed three.
- All mutable rows use exact `record_version` increments and non-decreasing
  timestamps. Tenant-owned references use composite keys where downstream
  ownership is relevant.

## Public Contract Payload

`modules/shared/domain/idempotency.ts` exports canonical JSON hashing, scoped key
validation, record creation/completion/failure, and replay/conflict decisions.

`modules/audit/domain/contract.ts` exports redacted `AuditEvent` and `OutboxMessage`
builders, the context-matching atomic mutation bundle, redacted snapshot
hashing, and an allowlisted telemetry shape. The module does not send events
or inspect a database.

`modules/notifications/domain/contract.ts` exports the fixed in-app pending-item
notice, delivery receipt construction, and effect replay/conflict evaluation.
No external channel is representable by the Release 1 contract.

## Migration Payload

`202608022530_007_expand_audit_outbox.sql` creates:

- `shared_idempotency_records` for scoped request hashes and terminal result
  references;
- `audit_events` for immutable actor/resource evidence with safe metadata;
- `audit_outbox` for transaction-linked, leaseable effect messages;
- `notifications_notifications` for minimal in-app pending-item projections;
  and
- `notifications_delivery_receipts` for one receipt per effect key.

The migration links outbox rows to the matching audit event and notifications
to their outbox. SQL triggers enforce append-only audit/history, allowlisted
JSON keys, no PII-shaped JSON values, exact version transitions, tenant
consistency, outbox state transitions, fixed notification content, and
delivery-effect identity.

## TDD And Verification Evidence

- RED: `tests/integration/outbox-audit.test.ts` initially failed because the
  three public contract modules and P0-11 migration did not exist.
- GREEN: the focused suite passes `5/5` runnable tests; the PostgreSQL test is
  skipped because `TEST_DATABASE_URL` is unset.
- Module-boundary regression plus the focused suite passes `11/11` with one
  expected PostgreSQL skip.
- The migration planner publishes the ordered candidate and SHA-256 receipt;
  the full migration plan remains `pass`.
- `git diff --check` was attempted but the local Git/filesystem command did
  not return within the bounded wait and was cancelled; no whitespace pass is
  claimed for that command.
- Scoped TypeScript was attempted with the new contracts and test files but
  produced no output and was cancelled after a bounded wait; no typecheck pass
  is claimed. Repository `pnpm lint` and `pnpm build` remain unrun under
  `erp-frontend/AGENTS.md`.

## Residual Risk And Gate

The migration has not been executed against PostgreSQL. `psql`, `pg_isready`,
and a local `postgres` binary are unavailable; the existing disposable
`codex-p005` Colima profile is `Broken`. No retry, database write, cloud
connection, or synthetic SQL runtime pass is claimed. Before P0-11 can be
runtime-passed, a repaired disposable PostgreSQL 17.10 environment must apply
migrations 001-007 and prove atomic audit/outbox linkage, duplicate effect
uniqueness, notification receipt linkage, safe JSON rejection, immutable
history, version transitions, and tenant mismatch failures.

The contract only guarantees the primitive boundary. Each future owning-module
mutation must still insert business fact, audit, and outbox in one database
transaction and each worker must re-check access before creating a notification.

## Rollback And Approval Boundary

Before adoption, rollback is deletion of the unreferenced P0-11 candidate
files and removal of the public entrypoint reference. After any migration use,
history is immutable; corrections require a reviewed additive migration.

This ticket authorizes only local synthetic implementation and focused
verification. It does not authorize database execution outside an explicitly
approved disposable local target, audit sink/queue creation, external
notification providers, real data, commit, push, merge, or deployment.
