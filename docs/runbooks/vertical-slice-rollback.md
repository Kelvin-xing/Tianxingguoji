# Release 1 Vertical-Slice Rollback and Evidence Runbook

Status: local evidence template only. This document does not authorize a migration,
application deployment, RDS/PITR restore, object restore, endpoint switch, feature
flag change, or cleanup of an isolated environment.

## Local Gate

The checked-in bundle is deliberately synthetic and redacted. It verifies the
integrity of local evidence but returns `no_go` because the external staging
receipts have not been performed.

```sh
node scripts/release/verify-vertical-slice.ts
node scripts/release/verify-vertical-slice.ts --require-go
node --test tests/release/verify-vertical-slice.test.ts
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Local synthetic evidence is complete and checksum-valid. This is not a release approval. |
| `2` | Evidence is missing, altered, malformed, or contains an unexpected file. Stop and preserve the bundle. |
| `4` | `--require-go` was requested, but required staging and human evidence is absent. |

The verifier recompiles `manifest-input.json`, compares it with `manifest.json`,
requires the exact closed artifact set, and checks the SHA-256 and byte count of
every artifact. A new run must have a new immutable run ID; do not edit an existing
run to make a failed scenario look successful.

## Required Human Go/No-Go Inputs

All inputs below are staging-only, use approved synthetic or explicitly approved
data, and are separately authorized actions. They are not represented as completed
by the checked-in local manifest.

1. **Compatible prior application image.** Record the image digest and deployment
   identifier for the previous compatible release. On an isolated staging target,
   verify that the prior image can perform the agreed read-only compatibility checks
   against the staged schema. A failure is a no-go; do not attempt a destructive
   schema downgrade.
2. **Corrective migration path.** Record the migration ledger and manifest
   checksums before and after the approved staging migration. A failed or unsuitable
   migration is addressed by a new additive corrective migration, never by changing
   an applied migration or keeping a dual-write path. Re-run reconciliation after
   the corrective migration.
3. **Isolated RDS restore.** Restore the named backup or PITR point into a new,
   private `ap-east-1` target. Keep it read-only while counts, organization hashes,
   schema ledger, audit continuity, authorization/session invariants, and sampled
   business queries reconcile. Record measured RPO/RTO and the opaque target IDs.
4. **Document metadata and object-version restore.** Reconcile document metadata,
   object version IDs, checksums, sizes, scan state, legal hold, retention and active
   pointer rules. Unscanned, rejected, revoked, or linkage-mismatched versions stay
   unavailable. Record only counts, hashes, opaque IDs, and stable error codes.
5. **Human decision.** Security, Privacy, Operations, and the Phase 2 owner review
   the evidence in the approved evidence store. They record the exact payload hash,
   reviewer, decision, remediation owner, and deadline. Local source control is not
   an approval record.

## Rollback Rules

- **Application rollback:** retain the compatible prior image digest and use the
  separately approved deployment mechanism. Do not switch an endpoint until staged
  reconciliation and the named human decision are present.
- **Migration rollback:** use only a forward additive corrective migration. Never
  edit migration history, replay a different checksum under the same version, or
  issue a destructive down migration against the restored or live target.
- **Database restore:** a PITR or snapshot restore always targets a new isolated
  instance. It is not an application rollback and cannot become a live endpoint
  until reconciliation passes.
- **Document restore:** never overwrite a historical object version. Repair a bad
  active pointer with a new audited pointer revision after clean-version and linkage
  checks.
- **Cleanup:** destroying an isolated restore is a separate approved action after
  evidence preservation and review. This runbook does not grant that authority.

## Stop Conditions

Stop at `no_go` for any checksum mismatch, missing artifact, public or non-Hong
Kong target, migration ledger drift, read compatibility failure, database/hash/audit
mismatch, document linkage/version mismatch, unavailable clean-version proof, or
missing named approval. Preserve redacted evidence; do not repair state by hand.
