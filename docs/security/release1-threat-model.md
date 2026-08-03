# Release 1 Threat Model

Status: Phase 0 synthetic template. This document is a control contract, not evidence that AWS resources or a production environment exist.

## Purpose and Scope

Release 1 is an internal K12 operations core. Sensitive data includes Student, Guardian, ServiceCase, Assessment, SchoolTarget, Task, document metadata and bytes, identity/session data, authorization state, audit records, application logs, scanner inputs/results, previews, temporary OCR data and backups.

The synthetic harness covers the failure shapes that must be injectable before staging work begins. It uses no real people, credentials, tokens, document bytes, database connection, crawler output or cloud resource.

The authoritative assumptions are:

- Sensitive processing, storage, logs and backups remain in Hong Kong (`DEC-018`, `DEC-021`, `DEC-023`, `DEC-024`).
- Cognito proves identity, while the Hong Kong database owns sessions and authorization (`DEC-020`).
- Private object bytes are versioned and accessed only after server authorization and short-lived signing (`DEC-017`, `DEC-024`).
- Mutations use transaction, optimistic concurrency, audit and outbox controls (`DEC-032`, `DEC-044`).
- Restore evidence must validate counts, hashes, linkage, audit continuity and sampled business queries (`DEC-022`, `DEC-037`, `DEC-038`, `DEC-057`).

## Assets and Trust Seams

| Asset | Owner | Required protection |
| --- | --- | --- |
| User, session and grant state | Identity/Access | Opaque browser session, version revocation, least privilege, no provider-only authorization |
| Case and CRM records | CRM/CaseWorkflow | Tenant and case scope, optimistic concurrency, audit, no export by default |
| School snapshot and approved overlay | School data owner | Immutable source, provenance, reviewer separation, deterministic resolution |
| Document metadata and object versions | Documents | Quarantine, scan verdict, private HK object, legal hold and soft-delete controls |
| Audit, outbox and telemetry | Audit/Operations | Append-only audit, idempotent effects, allowlisted fields, no raw PII |
| Evidence manifest and artifacts | Engineering/Operations | Synthetic-only inputs, checksums, immutable run identity, human gate visibility |

The relevant seams are:

1. Browser to the Hong Kong BFF: the browser supplies only an opaque session cookie.
2. BFF to owning modules: authorization occurs close to the data owner and returns minimal DTOs.
3. Owning modules to Cognito, RDS, S3, scanner and queue adapters: provider failures are explicit and retryable only where the contract allows it.
4. Harness adapters to evidence compiler: fake receipts are converted into redacted, hashed evidence without treating the fake as production proof.

## Threat Catalogue

| Threat / failure | Synthetic injection | Expected control | Terminal result |
| --- | --- | --- | --- |
| Identity provider timeout | `COGNITO_TIMEOUT` | Do not activate or revoke based on an unconfirmed provider result; bounded retry and reconciliation receipt | `needs_human` after retry budget or reconciliation failure |
| Provider returns an error or denial | Cognito `provider_error` / `denied` | Stable error code; no raw provider message in API, audit or telemetry | `blocked` or `needs_human` |
| Object upload/download timeout or access denial | S3 `timeout` / `access_denied` | Keep document quarantined or unavailable; preserve prior clean version; reconcile | `blocked` |
| Scanner timeout or malicious verdict | Scanner `timeout` / `malicious` | Only a clean verdict can activate/download a version; failed scans stay quarantined | `blocked` or `needs_human` |
| Scanner/object event is lost or replayed | S3 `event_lost` and duplicate event ID | Unique event key, bounded retry, DLQ/reconciliation, one receipt for a replay | `needs_human` if unresolved; replay is verified as idempotent |
| Stale concurrent mutation | Existing module `recordVersion` contracts | Return structured `409`; never last-write-wins | `blocked` for the attempted write, source remains intact |
| Migration checksum or schema drift | Migration planner mismatch fixture | Stop before mutation; preserve prior schema and evidence; require migration owner review | `needs_human` |
| Outbox poison message or partial effect | Existing P0-11 receipt/idempotency contracts | Transaction-linked outbox, max three transient retries, DLQ and reconciliation | `needs_human` |
| PII or secret enters an artifact/log | Evidence compiler text/key canary | Reject the bundle; do not redact and silently continue | `blocked` |
| Restore has mismatched counts/hashes/linkage | Restore mismatch fixture | Restore into an isolated target; no endpoint switch until all checks pass and humans approve | `blocked` |
| Evidence artifact is changed after generation | SHA-256 manifest and artifact hashes | Hash mismatch invalidates the run; generate a new run instead of editing history | `needs_human` |
| Vercel or another public plane receives sensitive data | Deployment/data-flow review | Keep authenticated runtime in `ap-east-1`; public hosting only after a separate audit | Release blocker |

## Required Evidence Shape

Every run must contain:

- `runId`, `inputVersion`, schema version and deterministic generation timestamp;
- scenario-level expected state, observed state, stable error facts and referenced artifacts;
- UTF-8 byte count and SHA-256 for every artifact;
- explicit `verification` separate from `releaseState`;
- explicit approval records and a fail-closed `releaseEligible` field;
- a synthetic-only redaction assertion.

An evidence bundle can have `verification: pass` while its `releaseState` is `blocked` or `needs_human`. That means the harness correctly reproduced the expected failure; it does not mean the release passed.

## Residual Risks and Gates

P0-12 does not prove residency, RPO/RTO, AWS IAM, database behavior, scanner efficacy, browser authorization, or restore usability. Those require Phase 1 staging evidence and the gates in `DEC-034` and `DEC-057`.

No synthetic artifact may be promoted as a staging or production receipt without a new run ID, source version, environment identifier, access-controlled evidence store and the named security, privacy and operations approvals.
