# R1X-06/07 PlatformBilling Persistence Contract

| Control | Value |
| --- | --- |
| Run ID | `R1X-06-07-PLATFORM-BILLING-PERSISTENCE-20260813` |
| Status | `local_source_only`; migrations and production runtime remain disabled |
| Business authority | `txgj-doc/business-requirements/80-portal-billing.zh-CN.md` (`BR-061`, `BR-062`) and `70-notifications-audit.zh-CN.md` (`BR-071`) |
| Repository | `erp-frontend/` |

## Problem, Stakeholders, And Scope

Finance needs reconstructable monthly advancing-case counts and append-only
contract source facts. Security, Privacy, tenant users, and platform operators
need a hard information boundary: PlatformBilling may hold organization-level
metadata, but never case detail or PII.

This slice defines repository transactions, a fail-closed runtime seam, an
in-memory contract fake, and additive `012`/`013` migration source. It does not
execute migrations, configure RDS, calculate money, create or send notices,
record manual receipts, alter tenant authorization, enable a second tenant, or
provide routes/UI.

## Model, States, And Invariants

- A platform actor is independent of tenant membership and is either active or
  disabled. Finance creates contract drafts; a distinct active billing approver
  activates them.
- Contract versions are append-only. `draft -> active` is permitted; activating
  a replacement atomically supersedes the prior active version. Effective
  periods cannot overlap, values are non-negative integer minor units, and the
  currency allowlist remains owned by the core contract.
- Cases owns immutable lifecycle projection events containing exactly event ID,
  organization ID, case ID, approved stage, effective instant, and case version.
  Extra fields fail as potential PII. PlatformBilling may read this projection
  but has no grants on tenant case/detail tables.
- A monthly snapshot is count-only, pins the Hong Kong cutoff, count policy, and
  source projection checkpoint, and is immutable. Corrections create a higher
  revision; they do not rewrite a closed snapshot.
- Subscription projection supports only `active` and informational `past_due`.
  It has no authorization effect. Suspension, termination, money calculation,
  notice workflow, receipt, export, purge, and second-tenant activation remain
  unavailable.
- Every mutation requires an idempotency key/request hash. Mutable aggregate
  commands require an expected record version. The mutation, idempotency
  receipt, and separate platform audit event commit or roll back together.
- Production database identities are separate: `platform_billing` is the
  `NOBYPASSRLS` mutation role, while `platform_billing_reader` is a distinct
  `NOBYPASSRLS` aggregate-only role. Both use the RDS IAM/CONNECT contract.
  The reader receives column-level `SELECT` only on contract reference/status,
  count snapshots, and subscription aggregates; it receives no actor, platform
  audit, idempotency, Cases projection, CRM, tenant detail, or write privilege.

Enforcement is intentionally layered: TypeScript contracts reject malformed or
PII-bearing inputs; repository transactions own current actor/role/version and
overlap checks; PostgreSQL owns uniqueness, append-only history, checks, role
grants, and forced RLS. The existing `access_organizations_one_active_idx` is
untouched; migration `014` is not implemented.

## Errors, Concurrency, And Partial Failure

Persistence errors are stable: `BILLING_IDEMPOTENCY_CONFLICT`,
`BILLING_VERSION_CONFLICT`, `BILLING_CONTRACT_NOT_FOUND`,
`BILLING_SNAPSHOT_EXISTS`, and `BILLING_RUNTIME_UNAVAILABLE`. Core policy and
validation errors retain their existing `BILLING_*` codes.

Contract activation locks the organization contract set before overlap and
version checks. Snapshot close locks its organization/month identity and uses a
source checkpoint. An identical replay returns the prior result; a reused key
with a different request hash fails. Unknown commit outcomes must be reconciled
through the durable receipt before retry. Audit failure rolls back business
state. The production runtime has no memory, JSON, Neon, or cross-plane fallback.

## Acceptance Evidence And Limits

Focused tests must prove strict no-PII projection parsing, replay and conflicting
replay behavior, stale-version rejection, self-approval denial, count-only HK
snapshot reconstruction, immutable revision behavior, audit rollback, schema
constraints, separate audit, least privilege/FORCE RLS, and absence of migration
`014` changes. Only deterministic `node --test` and scoped diff checks are
authorized. No lint/build, migration execution, database/network/cloud action,
Git staging, commit, push, or deployment is authorized.

Executed evidence:

```text
node --test tests/unit/platform-billing/contract-policy.test.ts \
  tests/integration/platform-billing-persistence.test.ts \
  tests/integration/platform-billing-schema-contract.test.ts
```

The final focused run passed 14 tests with zero failures. Scoped diff checks
also passed. These source-level checks do not prove PostgreSQL execution,
database role behavior, pool reuse, or production composition; those remain
R1X-09/non-production integration gates. The focused schema contract additionally
proves the two role declarations, RDS IAM/CONNECT grants, reader-only RLS policies,
column allowlists, and absence of detail/write grants. A real PostgreSQL run must
still prove migration execution, IAM login, role isolation, forced-RLS behavior,
pool reuse, rollback, and the aggregate query plan.

Final-review correction evidence on 2026-08-13: the combined Portal/Billing schema
contract passed `8` tests with `0` failures after adding the writer/reader IAM,
CONNECT, RLS-policy, column-grant, no-detail, and no-write assertions.
