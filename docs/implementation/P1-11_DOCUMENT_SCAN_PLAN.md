# P1-11 HK Document Scanner Implementation Record

| Control | Value |
| --- | --- |
| Task ID | `prd-phase-implementation-plan-2026-07-31:P1-11` |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_schema_reconciliation_runtime_composition_and_cloud_validation` |
| Source plan | `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md`, Phase 1 ticket `P1-11` |
| Decisions | `DEC-017`, `DEC-024`, `DEC-032`; P0-10/P0-11 and P1-10 are binding dependencies |
| Runtime action | None. No S3/SQS/DLQ/scanner action, RDS connection, migration execution, Terraform action, commit, push, or deployment occurred. |

## Outcome And Scope

P1-11 provides a fail-closed worker contract for private Hong Kong document
scanning. A worker claims one exact S3 tuple
`(bucket, key, version_id, scan_policy_version)`, invokes a composed scanner
once, and records an explicit clean, malicious, or bounded failure result. It
never accepts, persists, logs, or returns document bytes, scanner detail, or
credentials, and exposes no public API route.

In scope: document scan claim/completion/failure/reconciliation policy,
fail-closed scan runtime, `scan-document` and `reconcile-documents` workers,
deterministic in-memory transaction/scanner tests, and this record. Out of
scope: actual S3/SQS/scanner calls, scan-engine selection, parsing/OCR,
download/preview/export, document restore/delete, queue deployment, migration
execution, and P1-10 API/Terraform changes. P1-12 owns restore/delete.

## State And Ownership

```text
quarantined -> scanning -> available  (clean only)
                       -> rejected   (malicious only)
scanning -> scan_failed -> scanning  (next bounded delivery only)
scan_failed after attempt 3 -> SQS DLQ, still unavailable
```

`DocumentScanService` owns event validation, state-transition policy, retry
bounds, and redacted effect construction. `DocumentScanRepository` owns the
HK RDS transaction: it resolves and locks the exact tuple, deduplicates or
resumes work, and atomically writes document/scan/idempotency/audit/outbox
facts. The claim port accepts an effect factory so the repository builds audit
and outbox records only after resolving authoritative organization and version
IDs, never with placeholders.

The scan worker calls a scanner only after an accepted claim. An exact duplicate
returns before invoking the scanner. Retryable failure throws a bounded retry
error; attempt three throws a DLQ-bound error so reviewed SQS redrive, rather
than a local loop, performs the external move. The reconciliation worker only
delegates bounded recovery to the service. `getDocumentScanRuntime()` throws
until approved HK RDS and private scanner adapters are configured.

## Invariants

| Invariant | Owner |
| --- | --- |
| One work item exists for `(bucket,key,version_id,scan_policy_version)`; the exact delivery attempt has no second scan/effect. | Repository tuple lock and worker duplicate branch. |
| First claim requires `quarantined`; retry requires `scan_failed` and exactly the next attempt. | Repository plus service validation of attempts 1-3. |
| Only clean creates `available`; malicious creates `rejected`. | P0-10 transition decision is checked in the service and rechecked by repository transaction. |
| Timeout, failed, or mismatched scanner result leaves `scan_failed`, never available. | Worker failure branch and repository transaction. |
| Third failed attempt is DLQ-bound and remains unavailable. | Service labels the terminal effect; worker throws for the SQS redrive policy. |
| Reconciliation never promotes a document. | Missed events remain quarantined; stuck scans become `scan_failed` before requeue/DLQ. |
| Every claim, terminal result, failure, and reconciliation mutation has matching redacted audit/outbox in one transaction. | DocumentScanRepository and P0-11 mutation bundle. |
| Missing runtime configuration cannot invoke a mock scanner or storage fallback. | Fail-closed scan runtime. |

The worker requires a non-null provider `version_id`, required for the exact
tuple. Audit/outbox facts contain stable IDs and state only, never bucket, key,
provider version, policy, engine/version, scanner result detail, or content.
P0-10 download policy independently rejects every state except an available,
non-revoked version under fresh authorization.

## Error Contract

There is no P1-11 public route. Worker outcomes are terminal `available` or
`rejected`, `duplicate` without a scanner call, a retryable worker error, or a
DLQ-bound worker error. Invalid tuple/reconciliation input, mismatched scanner
response, and illegal transition use typed document-scan errors only within
worker infrastructure; raw scanner failures never become user-facing text.

## Evidence

The deterministic local command below passed on 2026-08-07:

```sh
node --test --test-reporter=spec tests/integration/document-scan-workflow.test.ts tests/unit/documents/lifecycle.test.ts tests/integration/outbox-audit.test.ts
```

Results: `18` passed; `2` expected PostgreSQL skips because
`TEST_DATABASE_URL` is unset. P1-11 tests cover clean-only availability,
malicious rejection, exact duplicate one-scan behavior, attempts one through
three/DLQ, missed-event plus stuck-scan recovery, transaction rollback,
redaction, and fail-closed runtime. `node_modules/.bin/tsc --noEmit --pretty
false` also completed locally with no diagnostics. `pnpm lint` and `pnpm
build` remain unrun under repository instructions.

## External Gates

P0-10 currently keys scan work by `(organization_id, document_version_id,
scan_policy_version)`, but P1-11 requires provider `(bucket,key,version_id,
scan_policy_version)`. P1-10 also creates a version with
`object_version_id = null`, while P0-10 makes that field immutable. A reviewed
additive schema/design reconciliation must define a post-upload provider
version receipt and enforce the exact tuple before runtime composition or any
migration. This ticket neither modifies nor executes migrations.

Before staging use, approved HK evidence must prove RDS tuple locking under
concurrency, transaction rollback across document/scan/audit/outbox, SQS
receive-count and redrive, authenticated S3 event plus exact-object HEAD
verification, scanner timeout/error classification, scanner temporary-file and
network residency, queue/DLQ encryption/policies, missed-event recovery
delivery, and log/effect redaction. Terraform application, cloud actions,
scanner selection, migrations, cost approval, and deployment remain separate
gates.
