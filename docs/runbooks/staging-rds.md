# Staging RDS Runbook

## Boundary

This runbook governs approved-only cloud validation of P1-02. It does not authorize Terraform, AWS, RDS, Secrets Manager, IAM, or PostgreSQL commands on its own. No real customer data, production migration, or unreviewed database URL is permitted.

## Required Approval Payload

Before any cloud command, obtain one exact payload containing the AWS account, `ap-east-1` region, encrypted private remote-state location, locking mechanism, Terraform/provider lock file, and full plan output. Include private subnet IDs from P1-01, the ECS application task role, an available PostgreSQL 17 minor version, a non-public RDS endpoint, the approved 20 GiB gp3/Multi-AZ cost estimate, 7-day backup setting, KMS choice, maintenance window, final snapshot identifier, named operations owner, and time-boxed destroy/restore authority.

The payload must also contain synthetic organization and actor fixtures, the exact migration role and managed-secret path, a migration checksum/rollback plan, and a test matrix proving TLS rejection, public/foreign-security-group denial, app-role DDL denial, missing tenant-setting denial, cross-organization RLS denial, correct-organization CRUD success, migration-ledger continuity, and restore/reconciliation evidence. An altered engine version, CIDR, snapshot identifier, database role, plan, or cost estimate invalidates approval.

## Local Checks

The following checks do not connect to a database:

```sh
node --test --test-reporter=spec tests/integration/staging-db.test.ts
node --test --test-reporter=spec tests/migration/drift.test.ts
node --test --test-reporter=spec tests/infra/staging-runtime.test.ts tests/infra/residency-policy.test.ts
```

Terraform validation needs a local Terraform binary and the approved provider lock file. `init -backend=false` can still download a provider, so it needs the separate network approval recorded by the P1-01 runbook. It is not cloud placement evidence and never substitutes for a reviewed plan.

## Approved-Only Evidence

After an approved apply, use the migration role only for the ordered checksummed migration process. Use the ECS task role with an RDS IAM token only for application-role tests. Do not place a secret, token, connection string, raw query, customer value, or Terraform state in Git or a chat trace.

Record opaque resource IDs, region, DB subnet/security-group inventory, parameter group, engine version, encryption/backup metadata, migration-ledger hashes, app-role privilege output, RLS result summary, restore target, reconciliation hash, reviewer identities, and timestamps in the approved evidence store.

Stop as `blocked` for public exposure, wrong region, missing TLS, an app-role DDL success, any RLS bypass/cross-organization row, migration-ledger drift, backup/restore mismatch, or a cost/approval mismatch. A transient AWS error may be retried at most three times with bounded backoff. A deterministic policy or schema error is corrected once and then retested in the complete matrix.

## Rollback

Before migration use, discard only the isolated unreferenced staging plan after approval. After a migration has run, use additive corrective migrations; never rewrite the migration ledger. A PITR restore creates a new instance, requires reconciliation before any endpoint switch, and is distinct from app rollback. Destroying an isolated staging RDS instance requires the approved final snapshot identifier and exact destroy plan. It never authorizes changing shared networking, remote state, production data, or backups.
