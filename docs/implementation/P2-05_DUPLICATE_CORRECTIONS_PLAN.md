# P2-05 Duplicate Corrections Plan

## Scope

`P2-05` supplies an advisory duplicate-candidate command, a Founder-only
merge command, and a Founder-only corrective undo command for `Student`,
`Guardian`, and `School`. It does not add a migration, execute an RDS write,
perform a merge on real data, delete any record, alter Guardian relationship
semantics, or mutate the immutable crawler snapshot.

## Candidate Rule And State

A candidate is a review item, never an identity decision. The authorized
read layer may submit a candidate only when two distinct UUIDs of the same
entity type have at least one exact normalized signal:

| Entity | Permitted signals |
| --- | --- |
| `student` | `display_name`, `date_of_birth`, `email`, `phone` |
| `guardian` | `display_name`, `email`, `phone` |
| `school` | `display_name`, `official_website`, `source_key` |

The service stores signal names only; it never receives or audits matching
values. A candidate starts as `review_required`, returns the two locked record
versions required for a later approval, does not create aliases, and cannot
auto-merge. Normalization and resource visibility belong to the RDS repository
transaction, so a client-provided signal is not trusted as an authorization
proof.

## Merge And Corrective Undo

Only an authenticated `founder` can merge or undo. A merge requires a
candidate ID, both candidate record IDs, the expected candidate version, both
expected record versions, a structured reason code, and an idempotency key.
The repository must, in a *single RDS transaction*:

1. authorize the actor and candidate/resource visibility;
2. lock the candidate and both current records, then compare all expected
   versions;
3. verify the candidate pair/entity, reject an existing active source alias,
   and preserve the source record;
4. append the active alias mapping and a field-provenance revision; and
5. append the audit/outbox and idempotency result with the merge revision.

No authoritative record is hard-deleted or silently overwritten. Field
provenance records identify which record supplied each selected field. School
base snapshot data remains immutable: a School merge changes only the
versioned alias/resolution mapping, not crawler bytes.

Undo requires the expected active merge version and appends a new corrective
revision that maps the source back to itself and restores its resolved view.
It does not update or delete the original merge, alias, provenance, audit, or
outbox rows. A second undo, stale version, altered idempotency payload, and
cross-entity pair are rejected.

## Error Contract And Enforcement

The `DuplicateMergeService` is the command-validation and Founder-role
enforcement owner. The future HK RDS adapter is the authoritative enforcement
owner for transactional authorization reads, locks, optimistic concurrency,
alias uniqueness, append-only provenance, audit/outbox, and idempotency.
Without that adapter, `getDuplicateMergeRuntime()` throws and the routes map
the request to the standard `503 SERVICE_UNAVAILABLE` envelope.

Errors map to the existing BFF contract: unauthenticated is `401`, wrong role
is `403`, invisible/missing resources are `404`, stale candidate/record/merge
versions are `409 STALE_VERSION`, state/idempotency conflicts are `409
CONFLICT`, invalid command shapes are `422 VALIDATION_FAILED`, and an absent
runtime is `503 SERVICE_UNAVAILABLE`. No raw match values, field values, or
human rationale are placed in audit/outbox payloads.

## TDD Evidence

The focused synthetic workflow test covers candidate-only detection,
Founder-only merge, idempotent replay, stale/failed transaction behavior,
append-only alias/provenance history, and corrective undo. The existing School
resolver suite is run as a regression boundary for its separate immutable-base
and pinned-resolution contract; P2-05 does not change that reducer.

Planned deterministic command (no migration, database, lint, or build):

```text
node --test tests/integration/duplicate-merge-workflow.test.ts tests/unit/schools/resolver.test.ts
```
