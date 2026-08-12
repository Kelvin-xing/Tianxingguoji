# R1X-02/03 Portal Persistence Contract

| Field | Value |
| --- | --- |
| Run ID | `R1X-02_03-PORTAL-PERSISTENCE-20260813` |
| Scope | External Portal repository/schema seam only |
| Authority | `DEC-064`, `DEC-065`, approved `DP-01` through `DP-05`, fail-closed `DP-10` |
| Status | Local contract implemented; production adapter and enablement unavailable |

## 1. Outcome And Boundary

This slice establishes the additive database shape, repository transaction contract,
deterministic fake, and fail-closed runtime required by the later Portal services.
It does not implement secret generation or hashing, a PostgreSQL adapter, routes,
workspace reads, UI, migration execution, runtime wiring, retention cleanup, or a
real Portal grant.

Stakeholders receive a persistence boundary that cannot represent cross-tenant or
cross-case Portal ownership, plaintext credentials, unbounded grants, a fourth
active session, an in-place renewal, or an active replacement grant alongside its
predecessor. Operations retains the production gate because `getPortalRuntime()`
always throws typed `PortalRuntimeUnavailable` until an HK RDS adapter is supplied.

## 2. Model And Invariants

```text
PortalViewer (organization, case, guardian relationship or applicant student)
  -> PortalAccessGrant (one immutable secret lifecycle and capability version)
       -> PortalSession (one of three active slots)
       -> PortalSecurityEvent (append-only audit/outbox-linked evidence)
```

- Viewer, grant, and session locality is enforced with composite unique keys and
  foreign keys containing `organization_id` and `service_case_id`. A viewer trigger
  additionally proves that the guardian relationship or applicant is for the case's
  student.
- Only 32-byte keyed secret/session digests and 64-character fingerprints are
  representable. Raw credentials are absent from the schema and repository input.
  Retained non-null digests and fingerprints are globally unique; multiple hashes
  may become `NULL` after approved cleanup without deleting metadata.
- Grant expiry is non-null, later than issue time, and no more than seven days.
  Grant identity, case, viewer, capability, issue time, and expiry are immutable.
- One partial unique index permits one active row per `lifecycle_id`. Rotation is a
  new row after old-row revoke; no expiry extension or hash replacement exists.
- Session slots are `1..3` and unique while active. Session idle expiry is at most
  15 minutes; absolute expiry is at most eight hours and never after grant expiry.
- Legal persisted transitions are `active -> revoked|expired`. Revoke, rotate, or
  expiry of a grant invalidates all active sessions in the same database transaction.
- Every session insert locks its exact `(grant_id, organization_id, service_case_id)`
  grant row with `FOR UPDATE` before checking active state and expiry. Grant revoke
  and rotation update that same row, so PostgreSQL serializes session allocation
  against revocation instead of permitting a stale-snapshot session insert.
- Portal security events reject update/delete and link to tenant audit and outbox
  records by composite tenant foreign keys. Idempotency history rejects deletion.
- Every Portal table enables and forces RLS with the existing `tianxing_app`
  `app.organization_id` policy. The schema does not alter the one-active-tenant gate.
- `tianxing_app` receives only `SELECT`, `INSERT`, and `UPDATE` on Portal tables.
  `DELETE` is explicitly revoked because `retention_pending` defines no purge path.

## 3. Repository Transaction Protocol

`issueGrant`, `revokeGrant`, and `rotateGrant` accept a canonical request hash,
scoped idempotency key, optimistic expected version where applicable, and one
`MutationEffectBundle`. A production implementation must perform fresh actor,
case, viewer, relationship, organization, and issuer authorization reads plus the
grant mutation, idempotency receipt, audit event, outbox row, and Portal security
event inside one tenant transaction. Any write failure rolls back every write.

`createSession` must lock the grant lifecycle, recheck grant/case/viewer facts,
count only current active unexpired sessions, allocate a free slot, and insert the
session digest in that same transaction. The active-slot unique index is the final
concurrency backstop. Revoke and rotate must lock/check `record_version` before
changing the grant and invalidating sessions.

The deterministic fake serializes operations through one transaction queue. It
proves the interface semantics but is not a production persistence fallback.

## 4. DEC-065 Discovery Boundary

`portal_auth` is `NOBYPASSRLS`, has no Portal table privileges, and may execute only
`portal_discover_grant_by_keyed_hash(bytea)`. The `SECURITY DEFINER` SQL function
has fixed `search_path = pg_catalog, public`, no dynamic SQL, uses keyed-hash
equality, and returns only `organization_id`, `grant_id`, and `service_case_id`.

Discovery does not authorize access. After discovery, the future adapter must close
that capability and open a separate `tianxing_app` transaction with
`app.organization_id` set locally, then perform all request-time policy checks.

## 5. Error And Failure Contract

The repository exposes typed conflict, context, active-state, secret uniqueness,
session-limit, and idempotency-reuse errors. The service layer remains responsible
for mapping these internal errors to the existing constant-shape public contract.
No adapter configuration yields `PORTAL_RUNTIME_UNAVAILABLE`; there is no local,
Neon, or in-memory production fallback.

Partial audit/outbox/security-evidence writes are transaction failures. Concurrent
fourth redemption loses either during serialized slot allocation or at the active
slot unique index. A stale revoke/rotate loses the optimistic version check. A
process crash after transaction commit is replayed from the idempotency receipt;
a changed request using the same key is rejected.

## 6. Deterministic Evidence

Command run from `erp-frontend/`:

```text
node --test tests/integration/portal-schema-contract.test.ts tests/integration/portal-repository-contract.test.ts
```

Result on 2026-08-13: `9` tests passed, `0` failed, `0` skipped. A final combined
run with the unchanged Portal policy suite passed `16`, failed `0`, skipped `0`.
Covered evidence:
tenant/case composite locality, hash-only uniqueness, time bounds, lifecycle/session
indexes, append-only evidence, RLS/FORCE RLS, function-only discovery, idempotent
replay, changed-payload rejection, concurrent three-slot allocation/fourth denial,
stale-version rejection, explicit grant-row locking before session insertion, no
undefined Portal deletes, atomic revoke/rotate invalidation, and fail-closed runtime.

No migration or database command was executed. Consequently this record does not
claim live PostgreSQL parsing/application, trigger behavior, role ownership,
privilege isolation, RLS pool reuse, rollback/repair, performance, or production
readiness. In particular, a real PostgreSQL two-transaction test must prove that a
session insert waiting behind revoke/rotate observes the committed inactive grant
and fails, while the opposite ordering leaves no active session after revoke commits.
`pnpm lint` and `pnpm build` were prohibited and not run. No cloud,
network, data, commit, push, or deployment action occurred.

## 7. Final-Review Correction Evidence

On 2026-08-13 the schema contract was tightened after concurrency and retention
review. The session trigger's composite grant-row `FOR UPDATE` lock is now an
explicit static assertion, and `tianxing_app` no longer has Portal table `DELETE`.
The focused Portal/Billing schema run passed `8` tests with `0` failures. This is
source evidence only; the two-connection PostgreSQL race remains a release gate.
