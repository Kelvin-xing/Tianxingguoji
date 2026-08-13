# Release 1 Restore Runbook

Status: P3-18 procedure template. No restore, migration, target cleanup, endpoint switch or production data operation is authorized by this document.

## P3-18 Execution Boundary

This source file is not a restore receipt. Execution requires an exact approval naming the backup/PITR source, isolated Hong Kong DB and document targets, operator, commands/tools, time window, evidence destination and cleanup payload. Absence or mismatch of any field is `blocked` and must not be retried by guessing.

The empty-baseline drill has two independently measured clocks: database RPO <= 5 minutes and RTO <= 4 hours; document RPO <= 24 hours and RTO <= 8 hours. A combined status is `passed` only when both targets and every integrity probe pass. AWS job success alone is insufficient.

## Objectives

The initial database targets are RPO 5 minutes and RTO 4 hours (`DEC-022`). Production automated backup retention is 7 days (`DEC-037`). A monthly Hong Kong staging drill and a quarterly database-plus-document drill are required (`DEC-038`). These are measured targets, not claims that the current worktree satisfies them.

Restore success requires all of the following:

- source backup, PITR position or snapshot identity is recorded;
- target is a new isolated Hong Kong instance, never the live endpoint;
- schema and migration checksums match the approved source version;
- record counts, hashes and tenant/organization distribution reconcile;
- document metadata, object version and linkage checks reconcile;
- audit continuity is present and append-only invariants still hold;
- representative business queries return the expected state;
- actual RPO/RTO, failures, owners and remediation deadlines are recorded;
- human approval is recorded before any endpoint or feature-flag change.

## Preconditions

1. Name the run with an immutable `runId` and record the application, schema, policy and evidence versions.
2. Confirm the exact backup/PITR source, target region and target account. Both must be `ap-east-1` for sensitive data.
3. Confirm the target is isolated, private and has no production credentials or public ingress.
4. Confirm the restore payload and access scope are approved for the drill. Use synthetic data for the Phase 0 harness.
5. Capture the pre-drill time, source timestamp and current application deployment ID.

## Procedure

Before step 1, create an out-of-repository redacted receipt with `run_id`, approved payload checksum, source recovery timestamps, target identifiers, start timestamps, owners and cancellation condition. Never store credentials, connection strings, object keys that expose PII, or raw command output in Git.

### 1. Restore the database

1. Create a new private target from the named backup or PITR position.
2. Record start time and the source recovery point timestamp.
3. Apply only the approved migration version. Do not use runtime `CREATE TABLE IF NOT EXISTS` for core schema.
4. Keep the target in read-only verification mode until the checks below pass.

### 2. Reconcile database facts

Run deterministic checks and save redacted results:

- table and row counts for User, Organization, Student, Guardian, ServiceCase, Assessment, SchoolTarget, Task, Document, audit and outbox records;
- per-organization counts and hashes;
- migration ledger order and SHA-256 values;
- active session/version and authorization invariants;
- optimistic-concurrency version monotonicity;
- outbox idempotency keys and audit foreign-key linkage.

Any mismatch is a `blocked` result. Do not repair the target by hand; create a new corrective migration or reconciliation receipt owned by the relevant module.

### 3. Reconcile document metadata and bytes

For every sampled or complete document set required by the drill:

- confirm object region, bucket policy, key shape and object version;
- compare metadata checksum, size and version ID with the database;
- confirm only clean, non-revoked versions can be active or downloadable;
- confirm pending delete, legal hold and retention facts survived;
- verify that missing, duplicate, rejected and scanner-failed events remain visible for reconciliation.

The runbook never prints document bytes or personal data into logs or evidence. Store only counts, hashes, opaque IDs and stable error codes.

### 4. Validate application behavior

With synthetic or approved staging actors, run representative read-only checks:

- sign in and session version revocation;
- authorized and denied case reads;
- stale update returns structured `409`;
- document download is denied for quarantined, rejected and revoked versions;
- duplicate outbox/event replay returns one receipt;
- audit records remain append-only and redacted;
- dashboards and next-task queries return the expected organization counts.

Do not enable real user flags or send invitations during a restore drill.

### 5. Decide and close

1. Calculate actual RPO as the source recovery point age at restore completion.
2. Calculate actual RTO from restore start until all required checks pass.
3. Attach the evidence manifest, failure register, owner and due date for every remediation.
4. Mark the run `passed`, `needs_human` or `blocked`.
5. If the run is not `passed`, keep the live endpoint unchanged and escalate to Operations, Security/Privacy and the Founder.
6. Only a separately approved cutover may switch an endpoint or feature flag. Record the exact payload and rollback target.

### Required empty-baseline receipt fields

- DB and document source/target opaque identifiers, all verified in `ap-east-1`;
- separate start, recovery-point and verification-complete timestamps for DB and documents;
- ordered migration/schema checksums and zero business-row counts;
- per-organization count/hash summary, expected to contain no business rows for P3-18;
- document metadata/object-version linkage counts and hashes without bytes or PII;
- append-only audit continuity probe and representative denied/authorized query results;
- calculated DB/document RPO and RTO, pass/fail per target, incident/remediation owner;
- evidence manifest checksum plus Operations and Founder decisions.

Cleanup of the isolated targets is a distinct destructive action. Preserve evidence first, then execute only an exact approved cleanup payload. Never point the production application at a drill target.

## Failure and Rollback Rules

- Database restore failure: retain the failure receipt, abandon the isolated target through the approved cleanup process, and retry only after a new source or corrected procedure is identified.
- Schema or checksum mismatch: stop before application access; preserve the mismatch evidence and do not edit an applied migration.
- Document linkage mismatch: keep document access fail closed; do not delete or overwrite the source object.
- Audit continuity mismatch: stop the drill and treat the target as unusable until the owner supplies a corrective plan.
- RPO/RTO miss: the run is not passed; record the measured value and remediation owner.
- Any suspected cross-region or PII exposure: stop immediately, preserve redacted evidence, and invoke the incident policy.

## Phase 0 Synthetic Mapping

The P0-12 harness maps restore failures to deterministic fixtures:

- `restore.hash_mismatch` represents a target schema/content hash mismatch and must remain `blocked`.
- `database.migration_checksum_mismatch` represents an ordered migration ledger mismatch and must remain `needs_human`.
- `object.event_replay` represents an idempotent replay; one accepted receipt and one duplicate receipt are expected.

These scenarios validate the evidence contract only. They do not replace a Hong Kong staging restore drill.
