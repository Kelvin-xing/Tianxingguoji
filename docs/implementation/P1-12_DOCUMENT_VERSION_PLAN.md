# P1-12 Document Version And Soft-Delete Record

## Status

Implemented locally on 2026-08-07. This record covers only audited clean-version
pointer rollback, soft delete, and restore. It does not implement export, legal-hold
management, retention scheduling, purge, S3 operations, or a production RDS adapter.

## Scope And Ownership

- `modules/documents/version-service.ts` constructs validated, redacted commands and
  effect bundles.
- `modules/documents/version-runtime.ts` has no fallback and fails closed until one
  HK RDS transaction adapter is composed.
- `POST /api/v1/cases/:caseId/documents/:documentId/version-rollbacks` moves the
  active pointer only to an eligible clean version.
- `POST /api/v1/cases/:caseId/documents/:documentId/deletions` records soft delete.
- `POST /api/v1/cases/:caseId/documents/:documentId/restorations` restores a selected
  clean version during the recovery window.
- No UI was added because the current local application has no document workspace;
  the case-scoped mutation routes are the P1-12 functional surface.

## State Model

```text
active(document, pointer -> available + clean + unrevoked version)
  -- soft delete --> pending_delete(document; original versions retained)
  -- restore clean version within 30 days --> active(document, new pointer revision)

active(document, pointer -> old available version)
  -- rollback to another available + clean + unrevoked version --> active(document, new pointer revision)
```

The pointer change increments `DocumentRecord.recordVersion`; it never alters a
`DocumentVersionRecord`, deletes history, or hard-deletes bytes. Existing P0-10
download policy denies `pending_delete`, and its purge predicate/DDL independently
denies legal-hold purge.

## Enforced Invariants

| Invariant | Enforcement owner |
| --- | --- |
| Rollback target is the same document, `available`, unrevoked, valid private object, and document is active | RDS repository locks records and applies `evaluateDocumentVersionActivation` in the same transaction |
| Restore target is the same document, clean/unrevoked, document is `pending_delete`, and the 30-day window has not expired | RDS repository applies `evaluateDocumentRestore` in the same transaction |
| Legal hold blocks the new soft-delete command; existing P0 predicate and DB trigger block purge | RDS repository plus P0-10 contract/schema |
| Pointer uses exact expected record version; stale commands do not write | RDS row lock and `expected_record_version`; route returns P0-03 `STALE_VERSION` / HTTP 409 |
| Cross-case/non-authorized requests reveal no document fact | Repository rechecks current case authorization; route maps forbidden/not-found to generic `NOT_FOUND` |
| Every successful mutation writes document fact, scoped idempotency result, audit event, and outbox row atomically | Single repository transaction port; staged fake commits all maps together |
| Audit/outbox do not contain object key, bucket, content type, classification, or object version | P0-11 redacted builders and focused canary assertions |
| Runtime cannot mutate through local/mock/S3 fallback | `getDocumentVersionRuntime()` throws until HK RDS composition is configured |

## Route Error Contract

All routes use the P0-03 envelope, set `cache-control: no-store`, and require a
reauthenticated opaque session plus `Idempotency-Key`.

| Internal condition | External response |
| --- | --- |
| Invalid body, UUID, version, or idempotency command | `422 VALIDATION_FAILED` or `400 INVALID_REQUEST` |
| Unauthorized or cross-case document/version | `404 NOT_FOUND`, without document details |
| Expected record version stale | `409 STALE_VERSION` |
| Non-clean/revoked target, legal hold, already-incompatible lifecycle, expired restore window, idempotency reuse/in-progress | `409 CONFLICT` |
| Missing identity or document RDS composition | `401 UNAUTHENTICATED` or `503 SERVICE_UNAVAILABLE` |

## Resolved Decisions

- `DEC-017`: only scanned, unrevoked versions become active; version history is not
  overwritten; delete and restore are audited.
- `DEC-030`: recovery is limited to 30 days and a restore must target a clean,
  unrevoked version. Legal hold blocks purge.
- `DEC-045`: this ticket is soft-delete only; no hard delete/purge path is exposed.
- Resolved `OD-02`: the 7-year/2-year/30-day class schedule and Founder-owned purge
  remain P2-07 policy/cleanup work. This ticket clears any pending-delete retention
  endpoint on restore and does not infer or execute a purge.
- Resolved `OD-03`: no cross-region recovery is added. With no configured runtime,
  mutation routes fail closed; the HK restore drill remains a P3 evidence gate.

## Deterministic Evidence

Executed from `erp-frontend/`:

```text
node --test --test-reporter=spec tests/integration/document-version-workflow.test.ts
# 8 passed, 0 failed

node_modules/.bin/tsc --noEmit --pretty false
# exited 0 with no diagnostics
```

The focused workflow verifies clean pointer revision and exact idempotent replay,
non-clean rollback denial, hold-blocked delete, no version history removal, clean
restore, expired-window denial, stale/cross-case no-disclosure behavior, failed
transaction atomicity, redaction canaries, and fail-closed runtime behavior.

## External Gates

1. No production repository is composed. The runtime intentionally throws rather
   than using the local staged fake; a private HK RDS adapter must lock document,
   target version, case authorization, and idempotency then persist every fact in
   the one transaction described above.
2. P0-10 currently makes `object_version_id` immutable after version creation while
   P1-10 begins upload rows with `NULL` and P1-11 needs the final S3 version ID for
   its scan tuple. That incompatibility must receive reviewed migration/runtime
   evidence before real scanner or version workflows are enabled. No migration was
   changed or executed here.
3. No S3, scanner, cloud, database, purge, export, retention-policy, restore-drill,
   commit, push, deployment, lint, or build action was run by this ticket.
