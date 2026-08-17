# P3-09 Supporting Production Repositories

Status: `partial_local`

## Intake and boundary

- Problem: the supporting modules had domain repository ports but no shared production transaction/effect enforcement surface.
- Stakeholders: Schools, Tasks, Documents, Audit and Notifications owners; Security and Operations reviewers.
- In scope: local TypeScript production repository primitives and deterministic isolated failure tests.
- Out of scope: route/runtime wiring, workers, migration execution, RDS/S3/message access, cloud changes and release activation.

## Invariants and ownership

1. Static supporting repository queries use only their own prefixed tables plus the shared idempotency table. The regex scanner is defense-in-depth only; typed repository APIs plus PostgreSQL grants/RLS own the security boundary. The audit effect writer is separately owned by Audit.
2. Business mutation, mandatory audit and outbox append share the caller's `TenantTransactionRunner` transaction. Any audit/outbox failure rejects the operation so the runner rolls back.
3. A document object reference is returned only when the document is active and the version is available and not revoked at request time.
4. Notification effect identity is `(organization_id, effect_type, effect_idempotency_key)`. Exact prior identity replays; a different outbox or notification binding conflicts.
5. An absent production transaction runner throws `SUPPORTING_ADAPTER_UNAVAILABLE` with status `503`; there is no mock or memory fallback.
6. Projection rebuilds remain deterministic pure-domain transformations (`rebuildCaseDashboardProjection`); persistence must use the same owned transaction primitive. Runtime wiring remains off in P3-09.

Enforcement owners are typed module repository APIs plus PostgreSQL grants/RLS for table ownership, `modules/audit/infrastructure/production-repository.ts` for atomic effects, Documents for availability, and Notifications for effect replay.

## Risks and evidence

- SQL ownership scanning is a defense-in-depth adapter rule, not a SQL parser or substitute for PostgreSQL grants/RLS. Static SQL in these adapters and database privileges remain required.
- Isolated tests use a recording transaction runner and prove pre-query ownership denial, rollback propagation, availability predicates, effect collision denial and fail-closed absence.
- No real PostgreSQL concurrency, lock behavior, object storage, worker, or network behavior is claimed by this ticket.
- Schools and Tasks currently expose only the bounded owned-transaction primitive; their concrete persistence operations, persisted projection adapter, production wiring and isolated PostgreSQL evidence remain pending. This record does not claim full P3-09 acceptance.

Verification command:

```sh
node --test tests/integration/p3-09-supporting-production-repositories.test.ts
```

`pnpm lint` and `pnpm build` were not run because repository instructions prohibit them without explicit user authorization.
