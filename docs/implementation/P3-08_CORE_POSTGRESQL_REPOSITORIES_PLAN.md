# P3-08 Core PostgreSQL Repositories

| Control | Value |
| --- | --- |
| Ticket | `P3-08` |
| Status | `partial_local` |
| Date | 2026-08-13 (Asia/Hong_Kong) |
| Authority | `DEC-007`–`DEC-011`, `DEC-020`, `DEC-029`, `DEC-031`, `DEC-032`, `DEC-044`, `DEC-046`, `DEC-067` |
| Repository | `erp-frontend` |
| Release effect | None; production wiring remains off |

## Problem, Scope And Stakeholders

Production needs PostgreSQL transaction owners that preserve identity, request-time authorization and cross-domain case integrity. This bounded implementation introduces the injectable transaction contract, a fail-closed typed adapter gate, and the cross-CRM/Case creation repository. Identity/Security/Data require revoked roles not to authorize a later write; Product needs replay-safe case creation; Operations needs an explicit unavailable result rather than a mock fallback.

In scope: local production repository source, isolated deterministic tests and this evidence record. Out of scope: adapter/network composition, credentials, migration execution, database writes, production wiring, cloud actions, reconstruction approval creation, deployment and release changes.

## Invariants And Enforcement

| Invariant | Enforcement owner |
| --- | --- |
| Absent runtime adapter never falls back to memory/Neon | `requirePostgreSqlAdapter`; typed non-retryable `503` |
| Advisor membership and role are active at request time | Repository transaction reads current membership/role with row locks |
| Manifest is approved when the case is created | Same transaction reads manifest with a share lock |
| Student, ServiceCase, Assessment, audit, outbox and receipt are all-or-nothing | One `PostgreSqlAdapter.transaction` callback, plus existing FKs |
| Case/student/manifest/advisor identity cannot cross tenant | Existing composite FKs and repository tenant predicates |
| Idempotency key cannot alias a different request | Tenant/actor/operation/key receipt plus request hash |
| Concurrent writes do not silently overwrite | Row locks, existing uniqueness and record-version constraints |
| Global identity, organization and manifest rows are not exposed to the application role | Additive `016` migration grants only three boolean predicate functions |
| Case create triggers can validate global authority without table grants | `SECURITY DEFINER`, fixed `pg_catalog, public` search path and PUBLIC execute revoke |

The repository orders inserts by FK dependency: CRM Student, ServiceCase, Assessment, audit, outbox, completed idempotency receipt. The adapter owns `BEGIN`/`COMMIT`/`ROLLBACK`; repository code cannot partially commit.

## Interface, Error And Risk Contract

`PostgreSqlAdapter.transaction` is the only production transaction seam. Its callback receives a query-only transaction handle. Missing configuration throws `ProductionRepositoryError` with `PRODUCTION_POSTGRES_ADAPTER_UNAVAILABLE`, HTTP `503`, and `retryable=false` so callers reconcile configuration rather than retrying a mutation blindly.

An isolated PostgreSQL 17 container accepted migrations `001` through `015` plus the original Portal/Billing sequence. The first live RLS slice passed after applying the three narrow predicates: unscoped application reads returned zero tenant rows, direct `identity_users` reads were denied, scoped reads returned only the current tenant, and all predicates returned the approved facts. The live repository slice then exposed that the existing service-case trigger executes global authority reads as the application role; additive migration `016` now hardens the two create-path trigger functions. A final clean-database replay and repository GREEN remain pending because subsequent localhost/Docker execution approvals were denied.

Risks: the updated `016` migration has not yet been replayed from an empty database as one immutable sequence; a real adapter must map PostgreSQL constraint names to existing stable domain codes; identity/access/reconstruction production repositories remain unfinished; transaction isolation and deadlock behavior still require isolated PostgreSQL evidence. No production wiring is enabled while these gaps remain.

## Verification And Stopping Conditions

Allowed checks are focused Node tests plus an explicitly named localhost-only isolated PostgreSQL harness. Maximum repair attempts: two deterministic fixes per counterexample; no external network retry. Pass requires typed missing-adapter evidence, locked request-time authorization, FK-ordered single-transaction writes, migration-trigger/RLS evidence and injected-failure rollback observation. An approval denial ends the live loop without claiming GREEN.

Not authorized or run: production migration/database write, Neon, Terraform, cloud, `pnpm lint`, `pnpm build`, commit, push, deploy or release action. Local writes were confined to the disposable PostgreSQL 17 container `tianxing-p3-isolated-pg17`.

Terminal state: `partial_local`; cross-CRM/Case source exists, but full P3-08 identity/access/reconstruction PostgreSQL coverage and live isolated PostgreSQL evidence remain pending.
