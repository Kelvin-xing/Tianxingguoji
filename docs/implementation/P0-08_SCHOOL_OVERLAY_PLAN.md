# P0-08 School Overlay And Resolver Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_database_evidence`: resolver and migration payload are implemented; PostgreSQL runtime evidence remains unavailable because the bounded Colima attempt became `Broken` |
| Candidate migration | `db/migrations/202608022030_004_expand_school_overlay.sql` |
| Migration SHA-256 | `8fe2ba80bddcb3fd264f4f79af4ff34ffc091fe53606676550402d49a482008b` |
| Runtime side effects | None |

## Problem And Boundary

P0-08 establishes the SchoolIntelligence foundation that combines an immutable crawler base with approved RDS overlay revisions. The resolver must produce a deterministic, pinned school view with field provenance and must never silently replace an approved human value when a newer base snapshot conflicts.

In scope: opaque formal School identity, tenant-scoped snapshot registry and records, immutable overlay field proposals, candidate/approved/disabled receipts, reviewer separation, Founder approval for identity fields, Data Reviewer approval for general fields, conflict review records, immutable resolved revisions, target resolution-pin foreign keys, and a pure deterministic resolver.

Out of scope: crawler publishing or snapshot synchronization, warning acceptance (`OD-12`), network verification of evidence URLs, provisional-school/change-request routes (`P1-08`), route-specific SchoolTarget rules (`OD-05`), resolved SchoolTarget service (`P1-09`), real school data, RDS/Neon writes, staging/production migration, commit, push, cloud, or deployment.

## Invariants

- `school_id` is an opaque UUID relationship identity. `source_school_key` is retained as crawler-source identity and is never used as a cross-module foreign key.
- Snapshot content and snapshot records are append-only. Snapshot status may move forward from `candidate` to `active` to `retired`; content, source release, manifest hash, and record hash cannot change.
- Overlay content is immutable. A revision enters as `candidate`, can be approved or rejected once, and an approved revision can only receive a disabling receipt. A rollback never edits the old revision.
- A reviewer cannot approve or disable their own requested revision. Identity field changes require an active Founder role; general fields require an active Data Reviewer or Founder role.
- An approved revision stores the base value hash for every changed field. A newer base with a different value preserves the approved overlay and emits `base_changed` conflict data. A newer base equal to the proposed value is eligible for `close_override` reconciliation without automatic mutation.
- A resolved view is identified by `baseSnapshotId + overlayRevisionId + resolutionSha256`, and every field has crawler or approved-overlay provenance. `schools_resolved_revisions` and a non-null Case target pin are immutable and tenant-composite.
- Resolved target pins must reference the same organization and School and must carry the exact stored resolution hash. Cross-tenant or stale hash references fail closed.

## Public Contract

`modules/schools/contract.ts` exposes JSON canonicalization and SHA-256 helpers, immutable base/overlay types, candidate proposal, reviewer approval/disable receipts, and role-specific approval decisions. `modules/schools/resolver.ts` exposes `resolveSchoolView` and `reconcileSchoolOverlay`; it has no database or network side effect.

The resolver selects the highest approved revision for the same organization and School, ignores candidate/rejected/disabled revisions, applies overlay values over a cloned base, and returns frozen fields, provenance, conflict data, and a deterministic hash. It does not mutate the caller's base or revision objects.

## Migration Payload

`202608022030_004_expand_school_overlay.sql` creates:

- `schools_schools` and `schools_snapshots` as tenant-composite identity and base registry tables;
- `schools_snapshot_records` as immutable per-snapshot base records;
- `schools_overlay_revisions` and `schools_overlay_fields` as versioned human overrides;
- `schools_overlay_review_queue` for base-change conflicts; and
- `schools_resolved_revisions` for immutable hashes/provenance used by pinned targets.

The migration adds the tenant-composite FK from `cases_school_targets` to resolved revisions and a trigger that verifies the pinned resolution hash. Triggers reject immutable deletes and updates, enforce record-version increments for mutable receipts, restrict overlay fields to candidate revisions, verify active reviewer role bindings, enforce identity Founder approval, and constrain review-queue resolution receipts.

## TDD Evidence

- Red: `tests/unit/schools/resolver.test.ts` failed because the public School contract and resolver modules were absent.
- Green: the pure resolver and contract slices now pass `9/9` tests, including base provenance, deterministic hashing, overlay precedence, conflict preservation, convergence reconciliation, rollback hash recovery, reviewer separation, JSON/cycle rejection, and non-mutating freeze behavior.
- Migration planner assertions pass, including DDL naming, immutable trigger presence, School FK, resolution pin contract, and the candidate SHA-256.
- The migration/drift suite passes `10/10`.
- The complete local test set passes `70/70` runnable tests with `0` failures and `3` PostgreSQL skips from P0-05/P0-06/P0-07 because `TEST_DATABASE_URL` is unavailable.
- OPA residency policy remains `7/7` on OPA `1.19.0`; `git diff --check` passes for the P0-08 files.

## Residual Risk And Gate

The SQL was not executed against PostgreSQL. The one bounded attempt to start Colima profile `codex-p005` left it `Broken`; no retry, container, database, synthetic SQL execution, or database pass is claimed. Targeted TypeScript had previously hung and was terminated with exit `130`; no TypeScript pass is claimed. Frontend lint/build remain unrun under `erp-frontend/AGENTS.md`.

Before P0-08 can be marked runtime-passed, run the additive migration against a repaired disposable PostgreSQL profile and verify candidate/approval/disable receipts, cross-tenant composite FKs, immutable update/delete failures, conflict queue receipts, and target pin hash checks. That action remains local synthetic verification only and does not authorize RDS/Neon/staging/production execution.

The P0-08 reducer remains subject to the Data Reviewer/Founder human gate in the phase plan. No warning is accepted and no crawler snapshot is synchronized by this ticket.
