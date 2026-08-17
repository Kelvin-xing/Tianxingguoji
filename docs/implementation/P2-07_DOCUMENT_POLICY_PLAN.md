# P2-07 Document Legal Hold, Export, And Cleanup Policy Record

| Control | Value |
| --- | --- |
| Task ID | `prd-phase-implementation-plan-2026-07-31:P2-07` |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_rds_object_adapter_route_worker_ui_and_hk_runtime_evidence` |
| Source | `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md` P2-07; `OD-02`, `OD-03`; `DEC-030`, `DEC-045`, `DEC-046` |
| Policy version | `hk_document_retention_export_v1` |
| Runtime action | None. This ticket performs no object-store call, export, purge, retention cleanup, database write, migration, cloud action, commit, push, deployment, or release change. |

## Outcome And Boundary

P2-07 supplies a fail-closed local contract for three independently controlled
document operations:

1. Founder-controlled legal-hold placement and explicit release;
2. Founder-only, one-use, short-lived, watermarked export grants confined to
   Hong Kong storage; and
3. a policy evaluation that determines whether an already soft-deleted document
   may be considered for a separate purge workflow.

It does **not** create document bytes, presign an object, redirect to storage,
run a worker against real data, delete an object, purge a document, or perform
an isolated HK restore drill. The existing 30-day soft-delete/recovery flow is
owned by P0-10/P1-12 and remains a prerequisite to any purge attempt.

## State, Invariants, And Enforcement Owner

```text
active or pending_delete document
  -- Founder records legal hold --> legal_hold = true (no automatic expiry)
  -- Founder explicitly releases --> legal_hold = false

Founder export request
  -- one RDS transaction --> pending_download grant (HK only, watermark required)
  -- one guarded consumption --> consumed
  -- expiry --> expired/cleanup candidate; never reissued or publicly shared

pending_delete document
  -- retention evidence + no hold + Founder purge approval + P0-10 guards -->
     eligible for a separately approved purge command
```

| Invariant | Enforcement owner |
| --- | --- |
| Unknown document class cannot produce a retention schedule or purge candidate. | Pure policy contract, rechecked by the RDS cleanup repository. |
| `identity_and_case_evidence` is retained 7 years after case closure; `operational_attachment` 2 years after case closure. | Versioned policy calculation with a case-closure timestamp supplied from authoritative RDS state. |
| An unattached `temporary_upload` expires 30 days after creation; a case-attached temporary upload is rejected as malformed policy context. | Policy contract and repository query. |
| A legal hold has no automatic expiry and blocks every purge candidate. | Legal-hold transaction port plus cleanup repository's request-time recheck. |
| Only the current Founder may place/release a hold, request export, or approve a purge candidate. | RDS repository locks/revalidates current opaque session, role, tenant, document, case relation, and idempotency record in one transaction. The local service performs a matching early denial only. |
| Export has exactly one opaque grant, one consumption, a reviewed expiry no longer than 15 minutes, an HK `ap-east-1` private-storage assertion, and a required watermark. | Export repository transaction and private HK object adapter; the route never provides a permanent/public URL. Fifteen minutes is a local maximum aligned with P1-10 signed capabilities; composition chooses the shorter live TTL. |
| Every hold/export/purge-candidate decision has a policy version, class, hold result, and redacted audit/outbox receipt. | The repository transaction; service result validation rejects a missing receipt. |
| HK incident status rejects export (and P1 upload/download) before capability issuance. | Runtime composition/repository authoritative region-health check; no local, cached, or cross-region fallback exists. |

## API And Worker Error Contract

The planned versioned routes use the P0-03 envelope and `Cache-Control: no-store`.
Malformed commands are `422 VALIDATION_FAILED`; absent authentication is
`401 UNAUTHENTICATED`; inaccessible cross-case documents are `404 NOT_FOUND`;
Founder/hold/retention/one-use/expired conflicts are `409 CONFLICT`; and missing
HK runtime composition or an HK outage is a redacted `503 SERVICE_UNAVAILABLE`.
No response exposes a bucket, object key, durable URL, document bytes, legal
reason, classification, or internal audit/outbox payload.

The export-expiry and cleanup workers are contract seams only. They may mark an
already-expired export grant as cleanup eligible, but cannot create an export,
delete an object, or purge a document. A real queue/object action needs a
separate approved payload and receipt.

## Security, Residency, Rollback, And Risks

- All composed storage must be private and `ap-east-1`; `OD-03` forbids a
  cross-region replica and requires operations to record only request IDs while
  HK is unhealthy.
- Watermark rendering is an adapter obligation: this contract requires a
  watermark descriptor but handles no bytes or PII.
- Hold release is an explicit new Founder decision. Releasing a hold does not
  purge; it merely permits a later request-time re-evaluation.
- To roll back a local implementation, disable runtime composition and leave
  grants unconsumed/expired. Do not delete document metadata or audit history.
- Before staging: prove RDS locking and session revalidation, real one-use
  consumption under concurrency, HK region/bucket/KMS policy, watermark
  application, audit/outbox atomicity, expiry cleanup receipts, and the
  `OD-03` isolated restore/outage reconciliation evidence.

## Deterministic Evidence

The following deterministic local evidence passed on 2026-08-07:

```sh
node --test --test-reporter=spec tests/unit/documents/policy.test.ts
# 7 passed, 0 failed

node --test --test-reporter=spec tests/unit/documents/lifecycle.test.ts tests/integration/document-version-workflow.test.ts
# 15 passed, 0 failed, 1 expected PostgreSQL skip (`TEST_DATABASE_URL` unset)
```

The P2-07 suite covers all three approved schedules, unknown-class and invalid
context denial, legal-hold override, Founder-only cleanup/export, HK outage,
watermark, region, expiry bound, hold receipt, one-use grant shape, and the
unconfigured-runtime failure path. The regression suite confirms P0-10/P1-12
still reject legal-hold purge and preserve version/soft-delete behavior.

`pnpm lint` and `pnpm build` are prohibited by repository instructions and will
not be run.

## Files And Remaining Gates

- `modules/documents/domain/policy.ts` owns the versioned pure policy, typed denial
  contract, Founder command validation, and transaction repository port.
- `modules/documents/infrastructure/policy-runtime.ts` is intentionally unavailable until HK
  RDS composition is approved.
- `tests/unit/documents/policy.test.ts` supplies synthetic deterministic proof;
  it does not provide RDS, signing, watermark, worker, route, UI, or cloud
  evidence.

An RDS adapter, export routes, expiry/cleanup worker, and policy-visible UI are
not implemented here because there is no approved production composition and
the P1-12 document workspace remains route-only. Those surfaces must be added
with a reviewed adapter that supplies current session/Founder role, current
case/document facts, HK region-health state, safe one-use atomic consumption,
and redacted audit/outbox persistence. No local contract test may be promoted
to an export, purge, or operational-residency approval.
