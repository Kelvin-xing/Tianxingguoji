# DOC-01 Case Document Registration And Read Workspace

| Control | Frozen value |
| --- | --- |
| Ticket | `DOC-01` authoritative Case-linked Document registration and metadata read workflow |
| Date | 2026-08-23 (Asia/Singapore) |
| Status | `accepted_for_local_implementation` |
| Acceptance | Local-only: disposable PostgreSQL 17, current one-role baseline, Release 1 synthetic seed, isolated Next Dev and system Chrome |
| Delivery owners | Frontend, Backend, independent QA |
| Remote state | Vercel, Neon and AWS are outside this ticket and remain unverified |

## 1. Business Result And Boundary

DOC-01 replaces the `/documents` preview adapter with authoritative Document metadata and fills the
missing prerequisite assumed by P1-10: an existing `(organization, case, document)` tuple. Founder
and the current Primary Advisor can register a named Document placeholder under a visible Case;
authorized users can then read the same record from the organization Document directory and the Case
Document panel after refresh and re-login.

The registration command creates only Document metadata. It does not create a DocumentVersion,
object key, upload intent, presigned URL, object-store record, scan job, active version, or file byte.
The new record is an active Case-owned Document with no latest or active version and is therefore not
downloadable.

In scope:

- Case-owned Document metadata registration;
- authoritative organization list, Case list and Case-scoped detail reads;
- the `/documents` directory and Case detail Document panel;
- strict browser DTOs, capability-only UI, idempotency and authoritative refresh;
- additive schema completion, PostgreSQL repository/runtime, API routes, audit/outbox and local
  PostgreSQL HTTP/browser/QA evidence.

Out of scope:

- file selection, original filename capture, file bytes, checksum, MIME type and size;
- LocalStack/S3 upload, presigned PUT, object key/version, SQS, ClamAV and scanner workers;
- download, preview, OCR, export, legal-hold commands, rollback, soft delete, restore and purge;
- Student-owned or Task-owned Document creation, Document metadata editing, bulk commands and cloud
  execution.

P1-10 through P1-12 remain separate future slices. No DOC-01 result claims that an object was
uploaded, scanned, clean, available, active, downloadable, restorable or deletable.

## 2. Authorization Contract

Two capabilities are authoritative. UI code consumes only the Access snapshot and never infers
permission from a role string.

| Capability | Founder | Advisor | Admin | Data Reviewer | Contractor |
| --- | --- | --- | --- | --- | --- |
| `documents.read` | allow | allow | deny | deny | deny |
| `documents.create` | allow | allow | deny | deny | deny |

`documents.read` is the existing capability. DOC-01 adds `documents.create`. Capabilities are coarse
entry permissions; the Document repository reauthorizes the resource relationship in the same
tenant transaction:

- Founder may read organization Documents and register a Document under any visible non-closed Case.
- Advisor may read or register only when they are the Case's current Primary Advisor.
- Admin, Data Reviewer and Contractor have neither capability and receive `403 FORBIDDEN` from
  direct endpoints.
- A missing, cross-tenant or Advisor-unassigned Case is resource-invisible and returns
  `404 NOT_FOUND`.
- A Case whose Student is `pending_delete` or `purged` is resource-invisible for new Document
  registration and returns `404 NOT_FOUND`.
- A visible closed Case returns `409 CONFLICT` for registration. Existing authorized metadata reads
  remain available after Case closure.
- Document lifecycle `deleted` is never returned by DOC-01 reads. `active` and `pending_delete`
  records remain readable so a later lifecycle ticket cannot make evidence disappear from an
  authorized read solely because a review is pending.

Requests never submit organization, actor, role, capability, Case assignment, owner kind, lifecycle,
record version, storage or scan claims. The server derives all of them.

## 3. Data And Migration Contract

The existing `documents_documents` table remains authoritative. Additive migration `034` may add one
required `display_name` column with a trimmed 1-200 character bound and constrain new Case-attached
records to the approved retention classifications:

- `identity_and_case_evidence`;
- `operational_attachment`.

`temporary_upload` is invalid for a Case-owned Document because the approved policy reserves it for
an unattached temporary object. Unknown or legacy free-form classifications fail closed.

The current source manifest contains 32 migrations and the one-role baseline contains 33 generated
files. Backend must stop for architecture review if that baseline has changed before implementation;
it must not assume migration number `034` is still free. Against the current baseline, implementation
adds one immutable source migration, updates the source manifest with repository tooling and
regenerates the one-role baseline from 32/33 to 33/34. Historical SQL and generated SQL are never
hand-edited.

The migration must fail closed if a pre-existing Document row cannot receive an authoritative
`display_name` and approved classification without inventing business data. It must not synthesize a
label from a UUID, Case number, object key or filename. On the accepted empty/synthetic baseline it
may then enforce `display_name NOT NULL` and the canonical classification constraint.

For DOC-01, Case ownership, `display_name` and `classification` are immutable after insert. A later
metadata-edit ticket requires a new command, optimistic version contract and additive database
decision; direct arbitrary updates are not enabled here.

Document registration inserts exactly one `documents_documents` row:

- `owner_kind=case` and only `service_case_id` populated;
- `lifecycle_state=active`;
- `active_document_version_id=null`;
- `legal_hold=false` and all delete/retention/purge fields null;
- `record_version=1`;
- no row in `documents_document_versions` or `documents_scan_results`.

All Document tables continue to use organization RLS with `FORCE ROW LEVEL SECURITY`, tenant-safe
foreign keys, the application role's minimum grants and append-only history protections.

## 4. HTTP And Exact DTO Contract

All routes use the existing versioned API envelope, `Cache-Control: no-store`, strict request and
response decoders and the server session actor. Unknown, duplicate or extra query/body/DTO keys fail
closed.

### 4.1 Reads

- `GET /api/v1/documents` returns exact `{documents}` for the actor's visible organization scope.
- `GET /api/v1/cases/{caseId}/documents` returns the same exact wrapper restricted to one visible
  Case.
- `GET /api/v1/cases/{caseId}/documents/{documentId}` returns exact `{document}` with the same item
  shape.
- These routes accept no query parameters in DOC-01. Results are capped at 100 and ordered by
  `updated_at DESC, id ASC`.

Every item has exactly ten keys:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "case_id": "00000000-0000-4000-8000-000000000000",
  "case_number": "TX-2026-00000000",
  "display_name": "Synthetic Application Evidence",
  "classification": "identity_and_case_evidence",
  "lifecycle_state": "active",
  "latest_version_state": null,
  "has_active_version": false,
  "record_version": 1,
  "updated_at": "2026-08-23T00:00:00.000Z"
}
```

`lifecycle_state` is `active|pending_delete`. `latest_version_state` is `null` or one existing
DocumentVersion state in canonical P0-10 vocabulary. It is derived from the newest version ordered
by `created_at DESC, id ASC`; it is never inferred in the browser. `has_active_version` is true only
when the authoritative active pointer is non-null and resolves to an available, non-revoked version
belonging to the same Document. The item exposes no Student identity, owner kind, task, object region,
bucket, key, provider version, checksum, MIME type, byte size, uploader, scan result, retention,
legal-hold reason, purge evidence or signed URL.

### 4.2 Registration

`POST /api/v1/cases/{caseId}/documents` requires `Idempotency-Key` and this exact body:

```json
{
  "display_name": "Synthetic Application Evidence",
  "classification": "identity_and_case_evidence"
}
```

The client trims the display name for validation, but the server is authoritative and rejects empty,
over-200-character or non-string values. It does not accept browser-supplied owner, organization,
lifecycle, record version, version state or storage fields.

Success is `201` with exact non-PII acknowledgement:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "record_version": 1
}
```

The acknowledgement is only a command receipt. The browser must immediately perform the exact
Case-scoped authoritative GET and confirm the matching ID/version before rendering success or the
new metadata state.

The same semantic attempt, including an uncertain transport retry, reuses one Idempotency-Key.
Changing `display_name` or `classification` rotates it. A synchronous duplicate click emits one
POST. Same-key/same-payload returns the first exact acknowledgement and produces no second Document,
audit or outbox row; same-key/different-payload returns `409 CONFLICT` with no new effect.

Public errors are fixed:

- `401 UNAUTHENTICATED` for no valid session;
- `403 FORBIDDEN` for a principal without the required capability;
- `404 NOT_FOUND` for missing, cross-tenant, Advisor-unassigned or pending/purged-owner scope;
- `409 CONFLICT` for a closed Case or idempotency payload conflict;
- `422 VALIDATION_FAILED` for invalid query/body/classification/display name;
- `503 SERVICE_UNAVAILABLE` for unavailable database/runtime;
- unknown failures remain redacted `500 INTERNAL_ERROR`.

Stable error mapping uses `Error.name` plus an allowlisted code rather than constructor identity alone,
so Next Dev/HMR cannot turn a known denial into an accidental `500`.

## 5. Transaction And Privacy Contract

Registration runs in one tenant transaction:

1. set transaction-local organization and actor context;
2. claim the scoped idempotency receipt;
3. reauthorize the current actor role/capability and lock the Case, its current Primary Advisor and
   owning Student;
4. validate tenant, visibility, Case stage and Student lifecycle;
5. insert the exact active Case-owned Document metadata row;
6. append one PII-free audit fact and one PII-free outbox fact;
7. complete the exact `{id,record_version}` receipt and commit once.

Any failure rolls back every effect. Concurrent same-key requests return one exact business result;
changed payload reuse conflicts. Injected audit/outbox or receipt-completion failure returns a safe
unavailable result and leaves zero Document, idempotency, audit or outbox effects.

`display_name` is authorized Document metadata and may be shown in the UI, but it is treated as
private content for evidence. It must not enter URL/query strings, browser storage, request IDs,
idempotency keys, audit/outbox payloads, application/browser logs or QA reports. The same prohibition
applies to Case number, Student/Guardian data, raw UUIDs, request bodies, cookies, tokens, database
errors and connection details. Audit/outbox contain only opaque internal references, fixed action and
status codes, record version and timestamps.

## 6. UI Contract

- `/documents` removes the preview adapter, preview notice and disabled fake upload control. It reads
  the authoritative organization list and provides bounded fixed filters over the returned lifecycle,
  classification and latest-version state without mutating server data.
- The Case detail page adds a Document panel backed by the Case-scoped read. `documents.create`
  exposes the registration form; `documents.read` alone exposes only the list.
- The form has a manual Document display name and a fixed classification selector. It has no file
  input, drag/drop, filename capture, upload button, checksum field, MIME selector, URL field or raw
  UUID input.
- Registration success appears only after the exact receipt and authoritative refresh agree. Loading,
  empty, denied, validation, conflict, unavailable and success states are distinct and truthful.
- Rows show the safe display name, Case number, classification, lifecycle and authoritative latest
  version state. A null latest version is presented as awaiting upload, not as clean or available.
- No role matrix, optimistic authoritative state, fabricated version history, fake scan progress or
  disabled cloud command is rendered.
- Cancellation and errors preserve or restore focus appropriately. Desktop and mobile checks require
  zero horizontal overflow, out-of-bounds controls, overlapping controls and clipped text.

Navigation continues to use `documents.read`. The create action is checked separately with
`documents.create` on the Case panel. Direct navigation and hidden controls never replace server-side
authorization.

## 7. Owner Handoffs

### Backend

Backend owns Access capability/policy changes, Document domain/application contracts, PostgreSQL
repository/runtime/server entrypoint, Route Handlers, migration/manifest/baseline, synthetic fixture
support, focused tests and the permanent real HTTP gate. Backend must not add S3/LocalStack/ClamAV
composition or edit frontend files in this ticket.

Backend must first freeze the exact DTO implementation against this plan and report any schema or
cross-module conflict before Frontend's final decoder is accepted. It must use Cases only through its
public/server boundary or a documented tenant-safe database ownership seam; it must not import Cases
internals.

### Frontend

Frontend owns the strict Document browser client, `/documents`, the Case Document panel, capability-
only controls, accessibility/responsive behavior, focused tests and permanent browser harness.
Frontend must not infer role/scope, add a dual decoder, use preview data, connect to PostgreSQL, or
introduce upload/scanner behavior.

Frontend may build static UI after this contract is frozen, but the one formal browser gate waits for
Backend's real PostgreSQL HTTP/DTO/baseline pass and architecture compatibility confirmation.

### QA

QA is an independent acceptance executor, not an implementation owner. It receives the frozen plan,
the exact accepted commit/worktree scope, Backend HTTP pass and Frontend browser pass. QA does not
modify product or test code and does not operate Git, databases, migrations, seeds, environment
variables, Vercel, Neon, AWS or deployment controls.

QA may execute the architect-approved existing permanent Local Dev command once. That command may
internally create and clean disposable PostgreSQL/Next/Chrome resources, but QA performs no manual
SQL, database inspection, provisioning or cleanup step. QA validates only redacted user-observable
and HTTP contract evidence. A failure stops the run; QA does not patch, weaken assertions, diagnose
by speculative retries or rerun without a new architecture gate.

## 8. Permanent Local Gates

### Backend self-test

The permanent Backend HTTP command uses disposable PostgreSQL 17, the regenerated one-role baseline,
Release 1 synthetic seed, provisioned synthetic principals and isolated Next Dev. It must prove:

- exact read/write DTOs, no-query contract, result cap/order and display-name/classification bounds;
- Founder and current Primary Advisor create/read; Advisor unassigned `404`; Admin, Data Reviewer and
  Contractor `403`; cross-tenant and pending/purged owner invisibility; closed Case conflict;
- exact receipt, authoritative GET, refresh/relogin persistence, same-key replay, changed-payload
  conflict, synchronous/concurrent behavior and injected rollback;
- registration produces one Document metadata row and zero version/scan rows;
- exact Document/idempotency/audit/outbox deltas, RLS/FORCE RLS, minimum grants, no private matches and
  complete cleanup.

### Frontend self-test

The permanent browser command uses the same disposable contract plus system Chrome. It must prove:

- capability-filtered navigation, Case entry and registration controls;
- native/client/server validation with zero POST on invalid input;
- uncertain retry key reuse, changed-command rotation and synchronous duplicate-click protection;
- exact receipt plus authoritative read, organization list, Case list, refresh and re-login
  persistence;
- null latest version rendered as awaiting upload and never as clean/available;
- direct denied APIs, hidden entries, loading/empty/conflict/unavailable states, keyboard/focus;
- desktop/mobile four-zero layout metrics, zero page errors, zero sensitive log matches and cleanup.

### Independent QA acceptance

After both owner self-tests pass, the architect issues QA one exact permanent command and immutable
scope. QA runs it once from a clean disposable environment and independently confirms the fixed
business journey: Founder registration, current Primary Advisor registration, authoritative
directory/Case reads, refresh/re-login persistence, denied roles, idempotency, no upload controls,
privacy, responsive behavior and cleanup.

QA reports exactly:

```text
status: pass | failed | blocked
owner: qa
scope: DOC-01 independent Local Dev acceptance
source_boundary: reviewed commit/worktree and exact command
changed: none
evidence: redacted observable booleans/counts/status codes only
defect_reproduction: exact stage and fixed safe classification, or not_run
not_run: every omitted check marked unverified
risks_or_stop_conditions: blocker and architect handoff
```

QA must not describe Backend or Frontend self-test evidence as its own independent pass. If QA cannot
run the exact gate, status is `blocked`; if a check was not reached, it is `not_run (unverified)`.

Static owner gates are Node 22 TypeScript, targeted ESLint, focused unit/contract/migration tests,
architecture boundaries, deterministic baseline check, `git diff --check` and no unmerged paths.
Full `pnpm lint`, production build, full suite, Vercel Test and AWS Production are not DOC-01 gates.

## 9. Delivery Sequence And Stop Conditions

The mandatory order is:

1. Architect freezes this contract and owner handoffs.
2. Backend and Frontend implement within their boundaries and run their focused/static self-tests.
3. Backend passes the real PostgreSQL HTTP/DTO/baseline gate.
4. Frontend passes the real Local Dev browser gate against that Backend contract.
5. QA performs the independent Local Dev acceptance with no source changes.
6. Architect performs final shared-diff, security, evidence and scope review.
7. The project owner explicitly approves the PR/Git publication gate.
8. Only then may the architect stage exact paths, commit, push, create/review/merge the PR.
9. Platform operations receives a separate deployment gate only after merge.
10. QA may validate a Vercel customer flow only after a new explicit remote authorization.

Stop before implementation or publication on any unfrozen DTO, capability or classification; source
manifest drift; need for bytes/object store/scanner behavior; migration requiring invented legacy
metadata; cross-owner import; authorization mismatch; database/runtime failure; duplicate write;
PII/secret/raw error exposure; incomplete cleanup; or QA failure. No failed gate is blindly retried,
no cloud/local substitution is allowed, and no prior completed CRM/CASE/TASK ticket is rerun merely
because QA joined the process.

## 10. DOC01-ADR-TENANT-FIXTURE-002

The one-role Release 1 database intentionally permits only one active organization through
`access_organizations_one_active_idx`. DOC-01 tests must not weaken or bypass that invariant merely
to manufacture a second active tenant.

For the permanent Local Dev HTTP gate, the cross-tenant HTTP contract is exercised with fixed UUIDs
that are not visible in the current organization and must return `404/NOT_FOUND` without private
echo or side effects. The underlying tenant-isolation claim is proved separately by repository and
service scope tests, FORCE RLS on the affected tables, one-role minimum grants and the real
PostgreSQL 17 baseline security checks. The test suite must not describe a nonexistent-resource HTTP
probe by itself as proof of a second live tenant.

The first DOC-01 Backend HTTP run stopped before any DOC-01 API assertion because its fixture tried
to insert a second active organization. The approved correction is test-only: remove that impossible
fixture, retain the opaque not-visible UUID probe, add explicit safe setup stages, rerun static gates,
then execute exactly one new formal `test:doc-01-dev-http` command. No product, Access, DTO, SQL,
migration, baseline or timeout change is authorized by this ADR.
