# P1-02 HK RDS Implementation Record

| Control | Value |
| --- | --- |
| Task ID | `prd-phase-implementation-plan-2026-07-31:P1-02` |
| Date | 2026-08-06 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_terraform_and_postgresql_evidence` |
| Source plan | `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md`, Phase 1 ticket `P1-02` |
| Decisions | `DEC-019`, `DEC-022`, `DEC-031`, `DEC-037` |
| Runtime action | None. No Terraform initialization, plan, apply, RDS connection, schema migration, database write, commit, push, or deployment occurred. |

## Outcome And Scope

P1-02 adds the local contract for a private AWS Hong Kong RDS PostgreSQL instance and its application access boundary. It builds on P1-01's private ECS runtime, but it does not claim that either ticket has been deployed.

The RDS declaration fixes the approved `db.t4g.small`, 20 GiB gp3, Multi-AZ, encrypted, non-public PostgreSQL shape; 7-day automated backups; IAM database authentication; a TLS-enforcing PostgreSQL 17 parameter group; RDS-managed migration credentials; and deletion protection/final snapshot requirements.

The migration creates `tianxing_app` with no superuser, DDL, role-administration, replication, or RLS-bypass capability. It receives IAM authentication, schema usage, and CRUD only on tenant-keyed tables present at migration time. Every such table gets a policy comparing `organization_id` to `app.organization_id`, set transaction-locally by the server-side database seam. Future tables receive no automatic app grant, so their owning migration must declare both privileges and RLS deliberately.

## Ownership And Contract

- `infra/terraform/modules/rds/**` owns the RDS subnet group, database security group, parameter group, instance, and IAM policy permitting the ECS application role to connect as exactly `tianxing_app`.
- `modules/shared/infrastructure/db.ts` owns the server-side connection and tenant transaction contract. It accepts an `ap-east-1.rds.amazonaws.com` host, port 5432, database `tianxing`, TLS validation, and the fixed application role. It does not accept a password or a client-provided database URL.
- `202608030030_008_expand_application_database_role.sql` is migration-role work only. The runtime application role cannot execute it or create tables.

The `TenantTransactionRunner` performs `BEGIN`, parameterized `set_config` for organization and actor UUIDs, the owning operation, then `COMMIT`. A failure rolls back and releases the client. A missing organization setting causes RLS policies to match no rows; it never selects a default organization.

## Evidence And Gate

Local evidence comes from `tests/integration/staging-db.test.ts`, the migration drift harness, module-boundary tests, and P1-01 residency tests. These validate source contracts and fake transaction behavior only. They do not prove RDS engine-version availability, Terraform provider semantics, security-group deployment, IAM authentication, managed-secret access, TLS handshake, role grants, RLS execution, backup/PITR, or residency in an AWS account.

The next action requires one human-approved staging payload: account and remote-state identifiers; an available PostgreSQL 17 minor version; private subnets and ECS task role; KMS treatment; exact final-snapshot identifier; P1-01 image/CIDR/certificate inputs; plan/cost review; and a synthetic-data migration/RLS test plan. The procedure is [staging-rds.md](../runbooks/staging-rds.md).

Until that payload has produced a reviewed Terraform plan and isolated PostgreSQL evidence, this ticket remains `needs_human_for_cloud_and_database_validation`. `pnpm lint` and `pnpm build` remain outside this ticket's authorization.
