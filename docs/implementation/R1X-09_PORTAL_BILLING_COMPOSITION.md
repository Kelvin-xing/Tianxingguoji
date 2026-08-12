# R1X-09 Portal/Billing Bounded Composition

| Field | Value |
| --- | --- |
| Run ID | `R1X-09-PORTAL-BILLING-COMPOSITION-20260813` |
| Scope | Production composition seam for `ExternalPortalAccess` and `PlatformBilling` only |
| Authority | `DEC-064` through `DEC-066`; approved `DP-01` through `DP-12` baseline |
| Status | `bounded_composition_seam_passed`; authoritative `R1X-09` remains incomplete |

## 1. Problem And Boundary

The two new modules need an HK-only production composition interface without
implying that the absent P3-08/P3-09 legacy repositories or a complete application
composition root exist. This slice may validate explicit production configuration,
register exact module ownership, and accept only explicitly supplied production
adapter factories. It does not implement SQL repositories, platform identity,
route wiring, migrations, cloud resources, or any fallback adapter.

The implemented seam validates four distinct TLS RDS identities in `ap-east-1`,
coordinates Portal discovery before tenant resolution, composes independent
PlatformOperator authentication and aggregate Billing access, and otherwise fails
closed with typed blockers. It is not installed into route defaults.

## 2. State, Identity And Transaction Invariants

- Portal discovery uses only `portal_auth` and the fixed discovery function. The
  result is a validated organization/grant/case UUID locator, never authorization.
- Portal request-time authorization and mutation use a distinct `tianxing_app`
  tenant transaction with current organization, case, viewer, relationship, issuer,
  grant, and session facts. Discovery and tenant clients cannot be the same role.
- The composition coordinator accepts only a 64-character lowercase hex keyed
  digest, calls discovery first, returns on a miss, validates the minimal locator,
  and only then invokes the tenant runtime resolver. It never accepts or derives a
  raw Portal bearer credential.
- Platform operator authentication is independent of organization membership and
  receives no tenant or billing database identity from composition. Mutations use
  `platform_billing`; overview reads require a distinct aggregate-only
  `platform_billing_reader` role. Migration `012` now defines both as RDS IAM,
  `NOBYPASSRLS` identities and limits the reader to column-level aggregate reads.
- Every connection target must be an explicit TLS-verified RDS endpoint in
  `ap-east-1`. Missing, malformed, role-confused, URL-based, Neon, local, or
  in-memory production configuration fails closed.
- Repository adapters own BEGIN/COMMIT/ROLLBACK and must roll back mutation,
  idempotency, and audit together. Composition does not split these effects.

## 3. Upstream Blockers And Stop Condition

The current shared DB abstraction provides a tenant transaction runner for
`tianxing_app`, but no RDS IAM credential provider/pool lifecycle, no function-only
`portal_auth` runner, no platform-actor authentication adapter, no proven
`platform_billing` transaction adapter, and no proven aggregate overview adapter.
The migration now supplies the `platform_billing_reader` database role contract,
but no live PostgreSQL test yet proves IAM authentication, RLS isolation, pool
reuse, or its aggregate query. The existing Portal and Billing repository files
are contracts, not PostgreSQL implementations. Creating adapter SQL directly
around these missing seams would invent security and connection semantics.

Therefore this slice stops at narrow factory interfaces and keeps production
runtime unavailable unless all five explicit factories are supplied: function-only
Portal discovery, tenant Portal transaction resolution, PlatformOperator auth,
PlatformBilling transaction repository, and aggregate-only overview reader. Routes
remain unchanged and unavailable until a later authorized integration provides
those adapters and tests live PostgreSQL role isolation.

## 4. Acceptance Evidence

- Focused tests reject missing/malformed/non-HK/role-confused configuration.
- Focused tests prove no implicit factory or runtime fallback.
- Factory tests prove each adapter sees only its role-specific configuration and
  that discovery miss/malformed locator cannot open the tenant adapter.
- Ownership tests register both modules and reject writes to existing Access,
  Cases, CRM, and AuditOperations resources.
- TypeScript no-emit is permitted; lint/build, migrations, network, database,
  cloud, deploy, commit, push, and `git add` remain prohibited.

Focused evidence on 2026-08-13:

```text
node --test tests/integration/portal-billing-production-runtime.test.ts \
  tests/integration/portal-billing-module-ownership.test.ts

9 tests passed, 0 failed
```

This evidence proves only the bounded composition interface. Authoritative R1X-09
still requires real RDS IAM/pool lifecycle, PostgreSQL adapters for all repository
methods, independent PlatformOperator identity, an aggregate-only reader adapter,
route installation, RLS/pool-reuse tests, transaction rollback and
partial-failure tests against isolated PostgreSQL, and completion of its P3-08/09
dependencies. Until those exist, Portal and Billing production route defaults must
continue returning their typed runtime-unavailable responses.

Final-review correction evidence on 2026-08-13 confirms migration `012` now names
the same `platform_billing` and `platform_billing_reader` identities required by
composition. Organization display metadata is intentionally not obtained by
granting the reader access to `access_organizations`; the production aggregate
adapter must supply an approved PII-free platform projection before route install.
