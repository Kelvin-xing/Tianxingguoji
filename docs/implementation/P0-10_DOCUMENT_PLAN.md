# P0-10 Document Domain And Object Store Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_database_evidence` |
| Ticket | `P0-10` |
| Candidate migration | `db/migrations/202608022430_006_expand_documents.sql` |
| Migration SHA-256 | `5bf8cf047bc9ac10fcad6813a0bfb42431c469c03570e86e237897beb5d09758` |
| Runtime side effects | None |

## Problem And Boundary

P0-10 establishes the Document module contract before any real upload, scan, or
retention workflow exists. It prevents an unscanned or revoked object from
becoming active or downloadable, preserves version history, and gives later
S3/SQS/scanner work a region-bound object interface.

In scope: document metadata and owner relation, immutable version identity,
quarantine/scanning/available/rejected/scan-failed lifecycle states, unique scan
work identity, active-version guards, opaque Hong Kong object references,
30-day soft-delete recovery, legal-hold and reference checks, and a signer
adapter that only issues exact-object intents.

Out of scope: AWS/S3 resource creation, presigned URL provider credentials,
scanner workers, scan retry/DLQ processing, routes/UI, audit/outbox delivery,
purge execution, export, and a post-close retention schedule. `OD-02` and
`OD-03` remain gates for total retention and restore/RPO/RTO decisions; the
approved 30-day soft-delete window is the only lifecycle duration encoded here.

## Invariants

- A Document and every DocumentVersion are tenant-owned and use opaque UUID
  identities; owner relations use composite foreign keys.
- A version has a new opaque object key and is never overwritten. The key
  contains only UUID segments and the storage region is `ap-east-1`.
- Only an `available`, non-revoked version belonging to an `active` Document
  can be active or receive a download intent.
- `pending_upload` can only become `quarantined`; `quarantined` must pass
  through `scanning`; only an explicit clean scan can produce `available`.
- A soft-deleted document can be restored for 30 days, but restore can only
  point to a clean, available, non-revoked version.
- Purge fails closed for missing Founder approval, live references, active
  legal hold, an active 30-day window, or an unresolved total-retention
  policy. Legal hold has no automatic expiry.
- Scan work is unique by document version and scan policy version; duplicate
  delivery is represented by the existing work identity rather than a second
  result.

## Interfaces And Evidence

`modules/documents/domain/contract.ts` owns state, object-reference, transition,
download/activation, restore, and purge decisions. `modules/documents/infrastructure/object-store.ts`
owns the region/bucket/key boundary and delegates signing to an injected
provider adapter; it has no AWS or network side effect in Phase 0.

Acceptance evidence is the focused lifecycle suite, migration planner output,
SQL constraint/trigger assertions, and (when `TEST_DATABASE_URL` is available)
an isolated PostgreSQL transaction applying migrations 001-006. No real PII,
credentials, object bytes, cloud resource, or production database is used.

## Risks And Terminal Conditions

The principal risks are accidentally inventing retention semantics, accepting a
provider-signed URL for a different object, allowing a stale active pointer,
and treating `pending_delete` as permission to purge. A deterministic failure
is corrected in the owning contract or migration and rechecked once; missing
PostgreSQL runtime evidence remains `needs_human` rather than being inferred
from static tests. No commit, push, deploy, cloud change, or data deletion is
part of this ticket.

## TDD And Verification Evidence

- RED: the focused suite initially failed because the Document contract and
  object adapter did not exist.
- GREEN: the focused suite passes `7/7` runnable tests; the PostgreSQL smoke
  test is skipped because `TEST_DATABASE_URL` is unset.
- The migration planner regression passes `10/10`.
- The independent local suite passes all 11 test files; PostgreSQL integration
  checks remain explicitly skipped because `TEST_DATABASE_URL` is unset.
- Active-pointer, purge, opaque-key, tombstone, soft-delete, and revocation
  guard assertions were added before their corresponding migration or adapter
  changes and now pass.
- No PostgreSQL runtime, `psql`, cloud resource, real object, real PII, or
  external provider call was used. The repository-wide TypeScript command was
  attempted but the local pnpm cache was outside the writable workspace and
  direct `tsc` produced no result before cancellation; no typecheck pass is
  claimed.
