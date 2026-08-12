# P2-01 Guardian Relationships Plan

## Scope

This ticket adds an Advisor-only, versioned Student-Guardian relationship command surface:

- attach an existing Guardian to one Student;
- retain one shared Guardian identity across siblings;
- atomically hand the primary-contact role from a current relationship to an existing current secondary relationship;
- expose the commands through versioned ERP routes and a minimal guarded UI; and
- prove the behavior with synthetic, deterministic workflow tests.

It does not create or auto-merge Guardian identities, migrate a database, purge a record, add a legal-ID field, export contact data, or decide the P2-05 corrective merge workflow.

## Sources And Rules

| Source | Rule implemented |
| --- | --- |
| `P2-01`, `AC-02`, `AC-04` | A contact may be shared by siblings, each active Student has one current primary, and relationship changes are authorized and auditable. |
| `DEC-005` | Guardian is an independent UUID identity; Student-Guardian is many-to-many; current primary is singular; no contact-field uniqueness or automatic merge is allowed. |
| `DEC-042` | Potential duplicate detection must never mutate or auto-merge a Guardian. |
| `DEC-045` | This ticket never deletes relationship history or Guardian/Student rows. |
| `DEC-032`, `DEC-044` | One transaction performs authorization-sensitive reads, relationship writes, audit/outbox writes, and optimistic-version validation; stale requests are `409`. |

## State Model And Invariants

`crm_student_guardian_relationships` is append-only in its decision fields. A current relationship has `ends_at = NULL`; a closed row is immutable history. The legal transition for a primary handoff is:

```text
current primary + current secondary
  -> close both existing rows with one reason
  -> insert a new current primary successor row
```

The service rejects a handoff to the same Guardian, an absent/inactive party, missing current successor relationship, non-Advisor actor, stale expected primary record version, and invalid request data. The chosen, narrow Release 1 authorization assumption is that an authenticated `advisor` role may perform these CRM relationship commands; no broader role is implicitly granted.

The database remains the final enforcement owner:

- `crm_relationships_one_current_pair_idx` prevents two current rows for one Student/Guardian pair;
- `crm_relationships_one_current_primary_idx` prevents two simultaneous current primaries for one Student;
- `crm_students_require_primary_contact` is a deferred constraint that requires exactly one current active primary at transaction commit; and
- relationship immutability/delete triggers preserve history.

The service and repository contract provide earlier stable errors, but cannot weaken those SQL constraints.

## Transactions And Concurrency

The production repository contract must execute authorization checks, lock the Student and current relationship rows, compare `expected_primary_record_version`, close history, insert the successor, and persist audit/outbox records in one tenant RDS transaction. Concurrent handoffs serialize on the Student/current relationship locks; a losing client receives `STALE_VERSION` rather than a silent overwrite. The current application composition has no approved RDS adapter, so the runtime fails closed with `SERVICE_UNAVAILABLE` rather than using an in-memory, JSON, Neon, or local fallback.

## API Error Contract

Routes use the existing `v1` envelope and request ID. Invalid payloads and impossible relationship transitions map to `VALIDATION_FAILED` (`422`); an unauthenticated session maps to `UNAUTHENTICATED` (`401`); a non-Advisor maps to `FORBIDDEN` (`403`); a missing opaque Student or Guardian ID maps to `NOT_FOUND` (`404`); a stale version maps to `STALE_VERSION` (`409`); idempotency reuse/current-pair/primary conflicts map to `CONFLICT` (`409`); and missing runtime wiring maps to `SERVICE_UNAVAILABLE` (`503`). Responses contain no Guardian profile/contact values.

## Risks And Boundaries

- The existing P0-06 deferred constraint makes a primary attach and a handoff order-sensitive. The repository boundary therefore owns the all-or-nothing transaction.
- UI requests use opaque UUIDs only; contact-profile capture remains outside this ticket.
- The P2-05 merge path is intentionally not represented by any P2-01 route or command.
- Real migrations, RDS writes, Neon writes, and deployment are outside the authorized scope.

## Deterministic Evidence

`node --test tests/integration/guardian-relationship-workflow.test.ts`

The workflow test uses fixed UUIDs and a fixed clock to prove shared sibling contact, non-Advisor denial, current-pair conflict denial, an atomic primary handoff that retains both closed relationship rows and creates exactly one new current primary, stale-version rejection without history mutation, and forced repository rollback without partial history. It never connects to a database or uses PII.

Run on 2026-08-07: `node --test tests/integration/guardian-relationship-workflow.test.ts` passed with 6 tests and 0 failures. `pnpm lint` and `pnpm build` were not run because the repository instructions prohibit them without explicit approval. No migration or database command was run.
