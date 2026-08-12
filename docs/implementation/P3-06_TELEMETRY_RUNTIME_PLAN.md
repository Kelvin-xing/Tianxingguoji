# P3-06 Telemetry Runtime And Degraded Operations State

| Control | Value |
| --- | --- |
| Ticket | `P3-06` |
| Status | `implemented_local` |
| Date | 2026-08-12 (Asia/Hong_Kong) |
| Authority | `DEC-023`, `DEC-032`, `DEC-035`, `DEC-039`, `DEC-062` |
| Repository | `erp-frontend` |
| Release effect | None; no sink, database, cloud, or production composition is wired |

## Problem And Boundary

The P3-05 producer policy validates the closed telemetry event shape but does
not define what happens when the sink is unavailable. This ticket adds the
local runtime contract: a policy-valid event is attempted once, a sink failure
is returned as a dropped telemetry result, Operations enters an explicit
degraded state, and no business command is replayed. Mandatory audit remains a
separate transaction-bound path and raises `AUDIT_UNAVAILABLE` before the
owning repository may commit a mutation.

In scope: the sink adapter interface, atomic Operations state transition
interface, alert occurrence for `telemetry.sink_degraded`, typed recovery probe,
mandatory-audit transaction port, local deterministic fakes, failure tests, and
the telemetry runbook. P3-08/09 production adapters, durable state migration,
HK sink provisioning, alert delivery, buffering/worker retry, and cloud
retention are out of scope.

## Contracts And Invariants

- `ProductTelemetryService.emit` calls `buildProductTelemetryEvent` first; a
  policy rejection reaches the caller and no sink call occurs.
- A sink write is attempted once. A sink exception is not propagated as a
  business error; the result is `dropped` with the stable
  `TELEMETRY_SINK_UNAVAILABLE` code.
- `markDegraded` is an owning Operations adapter transition. It must dedupe
  concurrent outage notifications; the service does not retry the event or
  the business command. If the state adapter itself fails, the result stays
  fail-open but marks the degraded receipt as `unrecorded`.
- Recovery requires a successful typed sink probe followed by an atomic state
  transition to healthy. Recovery does not replay dropped events.
- Mandatory audit receives only a transaction-bound port supplied by the
  business repository. The service never starts, commits, rolls back, retries,
  or substitutes telemetry for that transaction.
- Adapter exceptions are intentionally not returned, serialized, or placed in
  alert evidence. Tests assert that synthetic adapter messages do not escape.

## Ownership And Failure Graph

```text
validated event -> sink.write
                    | success -> delivered
                    | failure -> dropped + markDegraded + alert occurrence

business mutation TX -> appendMandatoryAudit
                         | success -> repository may commit
                         | failure -> AUDIT_UNAVAILABLE -> repository rolls back

typed probe -> markHealthy -> degraded state may close after review
```

The runtime owns telemetry delivery status and Operations state. The
CaseWorkflow/other business repository owns business facts, transaction
commit/rollback, and mandatory audit atomicity. No edge in this graph grants
telemetry access to business payloads.

## Verification

```text
node --test --experimental-strip-types \
  tests/failure-injection/telemetry-runtime.test.ts \
  tests/unit/operations/telemetry-policy.test.ts \
  tests/privacy/telemetry-pii.test.ts \
  tests/unit/operations/alert-catalogue.test.ts
```

The focused failure suite covers policy-before-sink ordering, fail-open sink
outage, degraded alert deduplication, no replay, recovery probe failure and
success, Operations-state write failure, mandatory-audit rollback signaling,
and the absence of a telemetry substitute for audit. No database, migration,
cloud, sink, alert delivery, lint, build, commit, push, or deployment action is
authorized or claimed.

## Local Verification Record

- RED was represented by the missing runtime/alert seams; the new focused
  failure suite was then implemented against those seams.
- Final focused regression:
  `node --test --experimental-strip-types
  tests/failure-injection/telemetry-runtime.test.ts
  tests/unit/operations/telemetry-policy.test.ts
  tests/privacy/telemetry-pii.test.ts
  tests/unit/operations/alert-catalogue.test.ts
  tests/integration/outbox-audit.test.ts
  tests/architecture/module-boundaries.test.ts`
  completed with `35` tests, `34` passed, `0` failed, and one expected
  PostgreSQL skip because `TEST_DATABASE_URL` is unset. The final regression
  took about 9 seconds; no database evidence is claimed.
- The focused suite includes the final source-review hardening for inconsistent
  Operations receipts and alert-construction failure. Those cases remain
  fail-open but explicitly return `degradedState=unrecorded` and do not expose
  adapter errors.
- Repository-wide and explicit-file `tsc --noEmit` checks did not finish within
  bounded attempts. The explicit-file attempt was terminated after 45 seconds
  by the command timeout; no TypeScript pass is claimed.
- `git status`/`git diff` checks were obstructed by a pre-existing empty
  `.git/index.lock` (mtime 2026-08-12 02:55, no owner was observable). The lock
  was not removed because it is outside this ticket's authorized source edit
  scope. `git diff --check` therefore has no reliable result in this run.
- `pnpm lint` and `pnpm build` were not run under `erp-frontend/AGENTS.md`.

## Remaining Gates

P3-08/09 must provide the approved HK sink and Operations-state transaction
adapters with durable idempotency/concurrency semantics. P3-15 must prove the
production retention, alert, residency and PII-canary receipts. P3-16 must
exercise sink/audit partial failure against the production composition. No
runtime wiring, migration, cloud resource, alert delivery, or production
feature activation is implied by this local record.
