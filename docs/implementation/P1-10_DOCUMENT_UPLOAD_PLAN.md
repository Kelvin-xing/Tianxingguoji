# P1-10 Private Document Upload Intent Implementation Record

| Control | Value |
| --- | --- |
| Task ID | `prd-phase-implementation-plan-2026-07-31:P1-10` |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_schema_reconciliation_runtime_composition_and_cloud_validation` |
| Source plan | `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md`, Phase 1 ticket `P1-10` |
| Decisions | `DEC-017`, `DEC-018`, `DEC-024`; P0-10 and P0-11 contracts are binding dependencies |
| Runtime action | None. No Terraform init/plan/apply, AWS/S3/KMS/SQS action, RDS connection, migration execution, document-byte handling, commit, push, or deployment occurred. |

## Outcome And Scope

P1-10 adds the local contract for a case-bound direct upload capability. An
already-authorized, active case Document receives exactly one new opaque
DocumentVersion in `quarantined`, then receives a short-lived signed `PUT`
capability. The response contains only the Document/version UUIDs, the expiry,
and the required signed-upload headers; it does not expose bucket name, object
key, a persistent object URL, document metadata, credentials, or audit/outbox
payloads.

In scope: the `DocumentUploadService` command/transaction port, fail-closed
runtime seam, `POST /api/v1/cases/{caseId}/documents/upload-intents`, HK
private S3/KMS/SQS Terraform declaration, and deterministic fake-repository
coverage. The command validates canonical SHA-256, a configured bounded size,
strict MIME syntax, case/document UUIDs, generated opaque key, idempotency,
and a short configured TTL no greater than fifteen minutes.

Out of scope: document creation UI, actual S3 object upload, scanner workers,
scan transition/result semantics, download/preview/export, deletion/restore,
provider credentials, Terraform application, migration execution, and any
resource or data write. P1-11 remains the owner of scan/reconciliation/DLQ
execution; P1-12 remains the owner of version restore and deletion behavior.

## Model And Ownership

The relevant model is an existing `(organization, case, document)` tuple plus
a new `DocumentVersion`. The route binds the caller-supplied document ID to a
case route parameter, but it does not decide that relationship itself.

`modules/documents/application/upload-service.ts` owns command validation, generated
version identity, opaque `documents/{document UUID}/versions/{version UUID}`
key construction, redacted effects, and public result validation.
`DocumentUploadRepository` owns the production transaction. It must revalidate
the opaque session and `session_version`, lock the current case/document and
current upload authorization, apply scoped idempotency, create the version,
and insert matching audit and outbox facts in that same RDS transaction. The
repository issues and validates the private one-method PUT capability only
after authorization, and never persists that capability.

The required valid state is:

```text
existing active case Document
  -> one new DocumentVersion: quarantined, unavailable, no active pointer
  -> short-lived private PUT capability
  -> P1-11 only: scanning and a later explicit scanner result
```

No P1-10 path can make a version `available`, set an active document pointer,
or issue a download capability.

## Invariants And Enforcement

| Invariant | Enforcement owner |
| --- | --- |
| A request cannot address another case's Document or a case without current upload authorization. | Production `DocumentUploadRepository` locks and rechecks session/case/document/auth facts in one HK RDS transaction; the route maps both absence and access denial to `404` to avoid existence disclosure. |
| A created version starts `quarantined`, has no provider object version ID, and has no active pointer. | `DocumentUploadService` creates only that state; repository input contract and focused fake require it. |
| Object keys are UUID-only and no filename, student, case number, or content appears in a key. | P0-10 `createOpaqueDocumentObjectKey` plus Document contract integrity checks. |
| Checksum, size, and type are bound before intent issuance. | Service validates lowercase 64-hex SHA-256, configured `maxSizeBytes`, strict MIME syntax, and requires the returned signed `PUT` headers to match all three values exactly. |
| A capability is private, single-method, HTTPS, signed, short-lived, and cannot carry unsafe optional headers. | Service accepts only a SigV4-shaped `PUT` capability with the exact three permitted headers; the intended provider adapter must bind the exact object/key/method inside the repository transaction. |
| Expired capabilities are denied. | Service rejects an expired repository replay; the approved provider signer must enforce the same expiration at S3. |
| One idempotency key with the same request is one version/effect bundle; changed reuse is rejected. | Repository transactional idempotency scope is `(organization, actor, documents.upload_intent.create, key)`. |
| Audit/outbox disclose neither checksum, size, MIME type, object key, bucket, URL, nor document bytes. | Service emits only stable action/status/version references plus a redacted state hash; P0-11 allowlists enforce the effect payloads. |
| No configured HK RDS/S3 adapter means no document write or signed capability. | `modules/documents/infrastructure/runtime.ts` always throws `DocumentUploadRuntimeUnavailable`; no local, public, or legacy fallback exists. |
| Storage is private, regional, encrypted, versioned, and scan-event-only. | Non-applied Terraform module enables Block Public Access, BucketOwnerEnforced ownership, TLS deny, versioning, SSE-KMS with Bucket Key, a single-region CMK, SQS and DLQ encryption, S3 Put events under `documents/`, and app-role `PutObject`/abort only. It declares no replication, MRAP, CloudFront, or transfer acceleration resource. |

`maxSizeBytes` remains a composition-time policy input because no approved
document-size business limit exists. It cannot be omitted; production runtime
composition must supply a reviewed value. The service hard-caps capability TTL
at fifteen minutes as a local security maximum, while the actual selected TTL
is also composition-time configuration.

## API And Error Contract

`POST /api/v1/cases/{caseId}/documents/upload-intents` requires an opaque
session, `Idempotency-Key`, and body fields `document_id`, `checksum_sha256`,
`size_bytes`, and `content_type`. It uses the P0-03 `v1` JSON envelope,
server-generated request ID, and `Cache-Control: no-store`.

The successful data object returns `document_id`, `document_version_id`,
`state: quarantined`, `expires_at_ms`, and the signed `upload` method/URL/header
set. It does not return object storage identifiers or durable URL fields.

Malformed commands map to `422 VALIDATION_FAILED`; missing/invalid session to
`401 UNAUTHENTICATED`; both cross-case and inaccessible/missing document facts
to `404 NOT_FOUND`; idempotency conflict, inactive document, expired intent,
or provider-binding mismatch to `409 CONFLICT`; missing runtime composition and
unknown internal failures to redacted `503 SERVICE_UNAVAILABLE`. No internal
repository, provider, credential, or document metadata error crosses the route.

## Evidence

The following deterministic local commands passed on 2026-08-07:

```sh
node --test --test-reporter=spec tests/integration/document-upload-workflow.test.ts tests/infra/document-store.test.ts
node_modules/.bin/tsc --noEmit --pretty false
```

The focused suite passed `7/7`: successful quarantined version creation;
redacted audit/outbox; exact idempotent replay and changed-key conflict;
cross-case/current-authorization denial; expired replay and malformed
checksum/size/type denial; transaction rollback; fail-closed runtime; and
static private/HK Terraform controls. The TypeScript check exited successfully
with no diagnostics. `pnpm lint` and `pnpm build` were not run because the
repository instructions prohibit them without explicit authorization.

## External Gates And Residual Risks

The current P0-10 candidate migration only permits an inserted
`DocumentVersion` in `pending_upload` and forbids later mutation of
`object_version_id`. P1-10's required initial `quarantined` state and a future
provider S3 version-id receipt therefore need a reviewed additive schema
reconciliation before any runtime composition or migration execution. This
ticket does not alter that P0 candidate migration or execute a migration.

Before any staging use, an approved HK RDS repository must prove session
revalidation plus current authorization in one transaction, safe idempotency
replay without retaining signed URLs, correct rollback on audit/outbox failure,
and exact-object presigning. An approved Terraform plan must also prove the
`ap-east-1` provider/account, KMS key policy evaluation for S3/SQS and the app
role, bucket public/replication/acceleration posture, queue notification
delivery, private networking, log residency, lifecycle/cost policy, and the
reviewed destroy payload. Those checks require separate cloud, security,
privacy, budget, and migration approval.

No P1-10 result implies that bytes arrived, a scan event was processed, a
quarantined object was readable, a clean result existed, or an uploaded object
can be restored or deleted. Those are explicitly deferred to P1-11/P1-12 and
their separate evidence gates.
