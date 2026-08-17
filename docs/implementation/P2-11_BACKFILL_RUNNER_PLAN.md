# P2-11 One-Way Backfill Runner Implementation Record

## Problem, Stakeholders, And Scope

Release 1 needs a deterministic, reviewable description of a one-way backfill
batch before any data owner can authorize a real migration. Data owners need to
approve the exact source and mapping; migration operators need a stable resume
identity and named rejects; engineering and audit owners need evidence that
every source row was classified and that the runner cannot dual-write.

P2-11 implements only a local, synthetic, preview-only harness. It accepts an
explicit synthetic source snapshot, mapping contract, and target schema version;
it emits canonical counts, hashes, rejects, reconciliation state, and an
immutable in-memory import-ledger entry. It does not connect to a source system,
RDS, Neon, a filesystem output ledger, a queue, or any external service. It does
not apply a migration, write target rows, freeze a source, switch a read/write
path, approve a mapping, or execute P3/P4 data work.

## Identity And Ownership Rules

- A source snapshot is identified by explicit `sourceKind=synthetic`, a
  non-empty `sourceVersion`, and its canonical row-content SHA-256. Live,
  production, remote, and unknown source kinds fail closed.
- A source row is identified only by its non-empty stable
  `sourceRecordReference`; display or mapped field values never establish row
  identity. References must be unique within the snapshot.
- A mapping is identified by `mappingVersion` plus the canonical SHA-256 of its
  source entity, target entity, ordered field dispositions, and required target
  fields. Mapping version alone is not content identity.
- A batch resume key binds source version, mapping version, and target schema
  version. Content hashes are stored separately: reordering equivalent rows does
  not change them, while altered content under the same resume key is an explicit
  conflict rather than being disguised as a new batch.
- `AuditOperations` owns the import-ledger contract. The preview runner owns no
  durable state and no source or target writes. A later approved migration role
  is the only permitted batch writer; there is never a dual-write mode.

## Mapping, Reject, And Reconciliation Invariants

- Each source field has exactly one named disposition. Duplicate source-field
  rules and duplicate mapped target fields are contract errors.
- Every non-disposed input field becomes a named `SOURCE_FIELD_UNMAPPED` reject;
  every missing mapped value required by the target becomes a named
  `REQUIRED_TARGET_FIELD_MISSING` reject. Reject output is stable-key sorted.
- Every row is classified exactly once:
  `source = accepted + rejected`; preview target count equals accepted count.
- Reconciliation has zero unexplained difference only when those equations
  hold. Any reject produces `needs_human`; no ledger entry can be created from a
  rejected preview.
- Source, mapping, accepted-target, and complete report SHA-256 values are over
  canonical JSON, independent of object key order and source row order.
- The returned execution contract is always `preview_only`, with both source
  and target writes `forbidden`. No apply mode or write adapter exists in P2-11.

## Checkpoint, Resume, Approval, And Failure Semantics

The immutable ledger entry is a preview checkpoint, not a transaction, backup,
or exactly-once receipt. An identical report against the same resume key is a
safe `replay`. Changed content under the same version-derived key returns
`BACKFILL_RESUME_PAYLOAD_CONFLICT`; changed versions require a new batch. Neither
case resumes under the old receipt. Approval is accepted only from role `data_owner` and
only for the exact report SHA-256 with a non-empty approval reference. Approval
does not execute data in this ticket.

Stable error codes are non-retryable contract outcomes:

- `BACKFILL_SOURCE_NOT_SYNTHETIC`: live or unknown source boundary;
- `SOURCE_VERSION_REQUIRED`, `SCHEMA_VERSION_REQUIRED`,
  `MAPPING_VERSION_REQUIRED`: missing version identity;
- `SOURCE_RECORD_REFERENCE_REQUIRED`, `SOURCE_RECORD_REFERENCE_DUPLICATE`:
  invalid stable row key;
- `MAPPING_SOURCE_FIELD_DUPLICATE`, `MAPPING_TARGET_FIELD_DUPLICATE`, and
  mapping/entity validation codes: malformed mapping;
- `BACKFILL_REJECTS_PRESENT`: preview has named rejects;
- `BACKFILL_MAPPING_APPROVAL_REQUIRED` and
  `BACKFILL_APPROVAL_PAYLOAD_MISMATCH`: missing/wrong exact-batch approval.

Malformed CLI input exits non-zero and writes no report. A successful CLI call
writes only the JSON report to stdout. Errors contain stable codes and no field
values or PII.

## Reliability, Concurrency, And Partial-Failure Risks

Canonicalization must remain versioned: changing it later can split resume
identity even when business content is unchanged. Hashes prove equality, not
semantic correctness or human approval. An in-memory frozen object cannot make
a future database ledger append-only; the future repository must enforce that
transactionally. Concurrent future runners must claim the same resume key under
a unique constraint/lock, but P2-11 deliberately has no database concurrency.
Checkpoint persistence before target commit could otherwise claim partial
success, so a future apply runner must record its batch rows, counts, hashes,
rejects, and checkpoint in the owning batch transaction described by F13. Source
freeze/delta capture and corrective batches remain P3/P4 approval gates.

## Harness, Evidence, And Stop Conditions

Task/run identifier: `P2-11-local-synthetic-2026-08-10`. Allowed actions are
scoped source/test/doc edits and local deterministic Node test/type checks. There
are no network calls, database connections, real data reads, migration commands,
cloud actions, commits, pushes, or deployment. Each deterministic failure may be
fixed and retried at most three times; repeated failure without new evidence
ends `needs_human`. Tests are the release judge, not the generator.

Acceptance evidence:

1. Focused migration test proves row-order-independent report/count/hash output,
   named rejects, immutable ledger, exact approval, replay, changed-payload
   conflict, synthetic-only boundary, and preview-only CLI behavior.
2. Existing migration drift suite proves P2-11 does not weaken P0-04 immutable
   migration planning.
3. A bounded TypeScript check covers the changed files if the local compiler can
   run without invoking prohibited lint/build commands.

Rollback is removal of these unused local contracts and tests. A real run still
requires a separately approved source snapshot, mapping payload, Data Owner
approval, migration/cutover runbook, freeze/delta decision, and execution role.

## Verification Evidence

Recorded on 2026-08-10 against local synthetic inputs only:

- RED: `node --test tests/migration/backfill-reconciliation.test.ts` exited 1
  because `scripts/backfill/preview.ts` did not exist. This was the expected
  public-seam failure before implementation.
- First GREEN correction: Node strip-only TypeScript rejected parameter
  properties. Error classes were changed to explicit runtime fields without
  changing the test oracle.
- GREEN: `node --test tests/migration/drift.test.ts
  tests/migration/backfill-reconciliation.test.ts` passed 15/15 tests. This
  covers five P2-11 behavior tests plus all ten P0-04 migration drift tests.
- Scoped TypeScript: `pnpm exec tsc --noEmit --target ES2022 --module NodeNext
  --moduleResolution NodeNext --allowImportingTsExtensions --types node
  --skipLibCheck scripts/backfill/preview.ts
  modules/operations/domain/import-ledger.ts
  tests/migration/backfill-reconciliation.test.ts` emitted no diagnostics but did
  not exit within the 90-second bounded verification budget. It was terminated
  with Ctrl-C (exit 130) and is not claimed as passed.
- `git diff --check` reported no whitespace errors. The checked synthetic JSON
  fixture and this Markdown record were manually inspected; no real identifiers,
  secrets, URLs, or data are present.

Per repository rules, `pnpm lint` and `pnpm build` were not run. The scoped
TypeScript check remains an explicit verification gap. No browser,
database, migration, concurrency lock, source freeze/delta, restore, or live-data
test was run. Those are explicit residual gates for later approved execution,
not evidence supplied by P2-11.
