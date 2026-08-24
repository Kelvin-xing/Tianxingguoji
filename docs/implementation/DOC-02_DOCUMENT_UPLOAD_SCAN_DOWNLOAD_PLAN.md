# DOC-02 Case Document Upload, Scan, And Download Plan

| Control | Value |
| --- | --- |
| Ticket | `DOC-02` |
| Status | `accepted_for_local_implementation` |
| Date | 2026-08-24 (Asia/Singapore) |
| Delivery boundary | Local Dev only |
| Dependencies | DOC-01, P0-10, P0-11, P1-10, P1-11, DEC-017, DEC-018, DEC-024, DEC-032 |
| Remote evidence | Vercel Test: `not_run (unverified)`; AWS Production: `not_run (unverified)` |

## 1. Business Outcome

An authorized Founder or the current Primary Advisor can take an existing active
Case Document created by DOC-01, select one synthetic local file, upload it to
private versioned LocalStack S3, wait for an actual ClamAV scan, and download it
only after the authoritative version is clean and active.

The complete accepted flow is:

```text
active DOC-01 Case Document
  -> durable pending_upload DocumentVersion
  -> short-lived exact-object PUT capability
     OR authoritative same-file capability reissue after refresh/re-login
     OR idempotent abandonment before object receipt
  -> browser PUT to private LocalStack S3
  -> versioned S3 event through SQS
  -> exact-object receipt and metadata verification
  -> quarantined -> scanning
  -> available + active pointer (clean)
     OR rejected (malicious, MIME mismatch, or immutable object mismatch)
     OR scan_failed -> bounded retry -> DLQ after attempt 3
     OR abandoned -> exact cleanup of every late provider object version
     OR repeated PUT -> exact cleanup of every unbound provider object version
  -> fresh authorized short-lived GET capability for the active clean version
```

No abandoned, rejected, failed, pending, quarantined, scanning, revoked,
deleted, or non-active version is downloadable.

## 2. Scope

### In scope

- one durable Case DocumentVersion creation command;
- direct browser upload through a short-lived private LocalStack S3 capability;
- versioned S3 event delivery through LocalStack SQS and its configured DLQ;
- server-side exact object receipt, checksum, size, declared MIME and magic-byte
  validation;
- streaming the exact private object to ClamAV without a temporary file;
- duplicate delivery, bounded retry, DLQ and missed/stuck-work reconciliation;
- authoritative recovery of an interrupted `pending_upload`, explicit
  abandonment, and exact cleanup of every PUT that arrives after abandonment;
- exact cleanup of every extra provider object version created by reusing one
  valid upload capability after a different provider version is durably bound;
- automatic active-pointer update only after a clean result;
- a fresh authorization check and audited short-lived private download capability;
- capability-only UI, authoritative polling, truthful lifecycle states and local
  browser download;
- additive PostgreSQL migration, one-role baseline, deterministic synthetic
  fixtures, focused owner tests and independent QA.

### Out of scope

- P1-12 rollback, soft deletion, restoration or purge;
- P2-07 legal-hold management, export, watermarking or retention cleanup;
- OCR, parsing, document preview or content indexing;
- original filename persistence or display outside the current browser session;
- multiple-file, byte-range or resumable multipart upload; reissuing one
  exact-object capability for the same durable pending version remains in scope;
- Vercel, Neon, real AWS, production credentials, Terraform apply or deployment;
- changing the External Portal prohibition on document listing and download.

## 3. Frozen Local Policy

| Policy | Exact value |
| --- | --- |
| Maximum file size | `10_485_760` bytes (10 MiB); zero-byte files are invalid |
| Allowed declared and detected MIME | `application/pdf`, `image/jpeg`, `image/png` |
| Upload capability TTL | 10 minutes |
| Download capability TTL | 5 minutes |
| Scan policy version | `clamav-release1-v1` |
| Scanner transport | ClamAV `INSTREAM`, private loopback TCP only in `local-synthetic` |
| Scanner timeout | one 30-second wall-clock deadline covering exact HEAD, GET stream, magic-byte validation and ClamAV `INSTREAM`; expiry actively cancels the S3 request/body and ClamAV socket |
| Scan attempts | maximum 3, then SQS DLQ and version remains unavailable |
| SQS visibility timeout | 180 seconds on the queue and each receive; no shorter per-receive override |
| Object region | `ap-east-1` |
| Object key | `documents/{document UUID}/versions/{version UUID}` only |
| Download name | fixed non-PII `document.pdf`, `document.jpg`, or `document.png` |

The browser-declared MIME is not authoritative. The worker must match it to
magic bytes: `%PDF-` for PDF, `ff d8 ff` for JPEG, and the eight-byte PNG
signature. A mismatch is rejected without exposing detected bytes or a local
filename.

## 4. Access And Visibility

Add exact capabilities `documents.upload` and `documents.download`.

| Role | Metadata read | Upload | Download |
| --- | --- | --- | --- |
| Founder | yes | yes | yes |
| Current Primary Advisor for the Case | yes | yes | yes |
| Other Advisor | resource-invisible | resource-invisible | resource-invisible |
| Admin | no | no | no |
| Data Reviewer | no | no | no |
| Contractor | no | no | no |

Frontend visibility uses only the Access snapshot capability list. Every server
operation rechecks the active user, membership, role binding, organization,
Case, Student, Document and current Primary assignment inside the owning
transaction. Cross-tenant, cross-Case, missing and unassigned-Advisor resources
return `404 NOT_FOUND` without an existence oracle.

Upload additionally requires an active Student, active Document and non-closed
Case. Ordinary authorized download of retained evidence remains allowed after
Case closure, but not when the Document is pending delete or deleted.

## 5. Durable State And Concurrency

### 5.1 Version lifecycle

```text
pending_upload -> quarantined -> scanning -> available
pending_upload -> rejected
pending_upload -> abandoned
scanning -> rejected
scanning -> scan_failed -> scanning
```

Existing later lifecycle transitions remain owned by P1-12. Migration `035`
must not edit migration `006`.

Migration `035` must:

1. allow `object_version_id` to change exactly once from `NULL` to a non-empty
   value only while `pending_upload` becomes `quarantined` or `rejected`; the
   sole migration-compatibility exception is a migration-006 row already in
   `pending_upload` with a non-empty provider version, which may keep that exact
   immutable value while making the same transition but may never replace it;
2. require a non-null provider version for every state after `pending_upload`
   except `abandoned`, which must retain a null provider version;
3. allow the direct integrity-rejection transition `pending_upload -> rejected`;
   allow only the user-command transition `pending_upload -> abandoned`, and
   make `abandoned` terminal, non-active, non-downloadable and excluded from
   scan facts;
4. add one partial unique in-flight constraint per organization/document for
   `pending_upload`, `quarantined` and `scanning`;
5. add one immutable positive upload generation per DocumentVersion, unique
   inside its organization/Document and assigned from the locked Document at
   creation; deterministically backfill any pre-DOC-02 rows;
6. close scan facts to the bound parent version: a queued/running/terminal scan
   may exist only in the corresponding bound parent lifecycle, uses exactly
   `clamav-release1-v1`, and activation accepts only that exact clean work fact;
7. reject retry or activation whenever any greater upload generation exists for
   the same organization/Document, regardless of that newer version's state;
8. preserve FORCE RLS, tenant policies, minimum application grants, immutable
   identity/content columns, no-delete history and exact version increments;
9. regenerate the one-role baseline through repository tools only.

`scan_failed` is not in the partial unique constraint so a user can start a new
version after failure. A retry for an older failed version is ignored if a newer
version exists; it can never replace the newer version. Timestamp ordering alone
is not an upload generation and must not decide this rule.

### 5.2 Active pointer

- The current safe active version remains downloadable while a newer upload is
  pending, scanning, abandoned, rejected or failed.
- A clean terminal transaction marks the candidate `available` and atomically
  sets the Document active pointer to it.
- A previous clean version and its scan facts remain immutable and available for
  later P1-12 rollback; DOC-02 does not overwrite or delete it.
- Abandoned, rejected or failed work never changes the active pointer.

## 6. Exact API Contract

Every API uses the `v1` envelope, a server-generated request ID and
`Cache-Control: no-store`. JSON parsers reject unknown, missing or duplicated
fields. UUIDs and versions are exact positive values.

### 6.1 Create a durable upload version

`POST /api/v1/cases/{caseId}/documents/{documentId}/versions`

Required header: `Idempotency-Key`.

Exact body:

```json
{
  "checksum_sha256": "lowercase-64-hex",
  "size_bytes": 123,
  "content_type": "application/pdf",
  "expected_document_record_version": 1
}
```

Success is HTTP `201` with exact data:

```json
{"id":"document-version-uuid","record_version":1}
```

The transaction locks and reauthorizes the actor/Case/Student/Document, checks
the expected Document version and one-in-flight rule, claims scoped idempotency,
inserts one `pending_upload` version with a null provider version, increments the
Document record version, appends PII-free audit/outbox, completes the exact
two-key receipt and commits once. Same-key/same-body replay returns the exact
first acknowledgement and creates no second fact. Changed reuse is `409`.

### 6.2 Issue an ephemeral upload capability

`POST /api/v1/cases/{caseId}/documents/{documentId}/versions/{versionId}/upload-intents`

No `Idempotency-Key` is used because the capability is ephemeral and is never
persisted or replayed. Exact body:

```json
{"expected_record_version":1}
```

Success is HTTP `200` with exact data:

```json
{
  "method":"PUT",
  "expires_at_ms":1787559000000,
  "url":"short-lived-private-url",
  "headers":{
    "content-type":"application/pdf",
    "x-amz-checksum-sha256":"base64-checksum"
  }
}
```

The capability signs only the exact bucket/key, method, declared MIME and
base64 checksum. Browser code must not set or sign `Content-Length`; S3 controls
that header and the worker verifies actual size through the provider receipt.
Repeated issuance is allowed only while the same version is `pending_upload`,
and each successful issuance is separately audited.

Production signing accepts HTTPS only. `local-synthetic` may accept HTTP only
for the validated configured loopback LocalStack origin. Any other HTTP origin
fails closed.

### 6.3 Read authority and recover an interrupted pending upload

The exact DOC-01 Case Document list/detail item gains one required field:

```json
"pending_upload":{"id":"document-version-uuid","record_version":1}
```

or `"pending_upload":null`. It is non-null if and only if
`latest_version_state` is `pending_upload`; any other combination fails closed.
No checksum, MIME, size, bucket, key, provider version, scanner detail or signed
URL is exposed.

After refresh or re-login, the browser reselects and hashes a local file, then
reuses the exact version-level endpoint from section 6.2 with the authoritative
pending ID and record version. The strict intent decoder must compare the
returned MIME and checksum header with the newly selected file before any PUT.
A different file performs no PUT and creates no new version. The pending
reference, selected file and ephemeral capability are never persisted in
browser storage or placed in a URL.

### 6.4 Abandon an interrupted pending upload

`POST /api/v1/cases/{caseId}/documents/{documentId}/versions/{versionId}/abandonments`

Required header: `Idempotency-Key`.

Exact body:

```json
{
  "expected_document_record_version":2,
  "expected_version_record_version":1
}
```

Success is HTTP `200` with exact data:

```json
{"id":"abandoned-document-version-uuid","record_version":2}
```

One transaction reauthorizes and locks the actor/Case/Student/Document and exact
pending Version, claims scoped idempotency, checks both expected versions and
the authoritative pending reference, requires its provider version to remain
null, transitions it to `abandoned`, increments both Version and Document
record versions, appends one PII-free audit/outbox pair with event/effect
`documents.pending_upload_abandoned`, completes the exact receipt and commits
once. Same-key and same-body replay returns the exact first acknowledgement with
no second effects; changed reuse is `409 CONFLICT`. Either stale expected version
is `409 STALE_VERSION`. A second new-key abandonment, a receipt that already
moved the version, or any non-pending state is `409 CONFLICT`.

An issued PUT capability cannot be revoked. The object-receipt service therefore
accepts a bounded lazy HEAD callback and locks the parent and Version before
obtaining object metadata. If the durable state is already `abandoned`, it does
not call HEAD and returns the distinct fixed outcome `abandoned_cleanup` without
binding a provider version or creating a scan fact. The worker deletes the exact
S3 `(bucket,key,provider version)` from that event, then persists an idempotent
PII-free `documents.abandoned_object_removed` audit/outbox result, and
acknowledges SQS only after the exact versioned delete succeeds or is strictly
classified already absent. Neither effect may contain an object coordinate,
provider version, checksum, MIME, size or filename.

Delete failure, timeout or cleanup-effect failure retains the message and
follows the three-delivery DLQ boundary. A dedicated cleanup drain may consume
only DLQ messages that still resolve to durable `abandoned_cleanup`; ordinary
scan-failure DLQ messages remain untouched. It repeats exact deletion and the
idempotent cleanup effect before acknowledging. Reused presigned PUTs create
separate provider versions, so every event is cleaned independently. A crash
after deletion but before durable effect or SQS acknowledgement is safe because
exact version deletion and the cleanup effect are idempotent. If receipt wins the
row lock first, abandonment conflicts after the version becomes `quarantined`;
if abandonment wins first, every later event is cleanup-only. Neither order can
scan, activate or download an abandoned version, and a newer upload generation
uses a different opaque key.

There is no public completion endpoint. The versioned S3 event remains
authoritative, and normal upload/scan polling uses the Case Document detail DTO.

### 6.5 Issue an ephemeral download capability

`POST /api/v1/cases/{caseId}/documents/{documentId}/download-intents`

Exact body: `{}`. No `Idempotency-Key` is used.

Success is HTTP `200` with exact data:

```json
{
  "method":"GET",
  "expires_at_ms":1787558700000,
  "url":"short-lived-private-url",
  "download_name":"document.pdf"
}
```

The server derives and locks the current active version, rechecks it is
`available`, unrevoked and bound to the exact private object, appends one
high-risk-read audit/outbox bundle, then signs the exact object. The URL,
signature, bucket, key and provider version are neither persisted nor logged.

### 6.6 Error mapping

| Condition | External result |
| --- | --- |
| Invalid JSON, field, MIME, checksum, size or version | `422 VALIDATION_FAILED` |
| Missing/invalid session | `401 UNAUTHENTICATED` |
| Authenticated role without capability | `403 FORBIDDEN` |
| Missing/cross-tenant/cross-Case/unassigned resource | `404 NOT_FOUND` |
| Stale expected version | `409 STALE_VERSION` |
| In-flight upload, incompatible state, no safe active version, replay conflict or expired intent | `409 CONFLICT` |
| PostgreSQL, S3, SQS, ClamAV or signing unavailable/unknown | `503 SERVICE_UNAVAILABLE` |

No external error contains a filename, checksum, MIME, object coordinate,
scanner signature, URL, credential, SQL detail or private record value.

## 7. Worker And Object Contract

The local worker consumes only versioned S3 `ObjectCreated:Put` events from the
configured SQS queue. It derives delivery attempt from SQS receive metadata,
never from an untrusted event field.

`ApproximateReceiveCount` is the bounded queue-delivery count, not proof that a
scanner attempt committed. The durable `attempt_count` advances exactly once
only when a scan claim commits. A delivery that fails before that commit may be
received again with a greater queue count while the durable scan is still
queued; it must remain claimable and must not be acknowledged as a duplicate.
A redelivery observed while a durable scan is still `running` is not deleted
merely because the claim exists: it is left for the bounded stale-scan
reconciliation path unless a durable terminal result is already present. Queue
delivery three is still the hard DLQ boundary, while durable scanner claims are
independently capped at three; either boundary leaves the version unavailable.
The local queue and every receive use a `180`-second visibility timeout, matching
the existing AWS infrastructure contract and exceeding the bounded scan plus
database overhead. A worker must not shorten that window. Tests must prove that
an overlapping redelivery of `running` work is not acknowledged and that a
message is deleted only after a durable terminal result or a verified terminal
duplicate.

Native S3 events do not carry an application tenant identity. For this
Local-Dev-only slice, the worker must therefore receive the exact Release 1
synthetic organization UUID `51000000-0000-4000-8000-000000000001` and the fixed
non-user worker-context UUID `10000000-0000-4000-8000-000000000901` from its
isolated harness/runtime before any repository read. Both values are compared to
stable runtime constants; accepting an arbitrary active organization is forbidden. The worker-context
UUID must not equal an Identity user and cannot satisfy any user capability or
Case-assignment check; durable effects use `actor_kind=worker`, not a borrowed
Founder or Advisor identity. The repository must still match the exact bucket,
opaque key and provider version to a row visible under FORCE RLS; an event for
any other tenant or object produces no business effect.
`production-aws` remains fail-closed until a separately reviewed tenant-dispatch
primitive exists. The local fixed-tenant composition is not production evidence.

For a first exact non-abandoned event it:

1. validates bucket, opaque key and non-empty provider version;
2. locks and classifies the parent/version, then invokes the bounded lazy exact
   versioned `HEAD` only for a still-`pending_upload` version and validates actual
   size, declared MIME and S3 SHA-256 checksum;
3. binds the provider version once and records `quarantined` plus queued scan
   facts in one transaction;
4. claims the exact `(bucket,key,version_id,scan_policy_version)` tuple and moves
   it to `scanning` in one transaction;
5. streams the exact object simultaneously through bounded magic-byte detection
   and ClamAV `INSTREAM` without a local file;
6. commits exactly one clean, rejected or failed result with redacted
   audit/outbox evidence.

An exact duplicate after a durable claim or terminal result performs no second
scan and adds no duplicate business effect. Only a durable terminal result may
be acknowledged immediately; an in-progress claim is not a terminal duplicate.
Integrity/MIME mismatch is terminal `rejected`. A scanner timeout or transport
failure is retryable within both the three-delivery queue ceiling and the three-
claim durable ceiling. Reaching either ceiling remains unavailable and is left
for SQS redrive to DLQ.

### 7.1 DOC02-ADR-UNBOUND-PROVIDER-VERSION-001

One valid signed PUT capability can be reused while it is unexpired. With S3
versioning enabled, two uncertain or repeated PUTs to the same opaque key can
therefore create provider versions `A` and `B`. If `A` wins the row lock and is
durably bound to the DocumentVersion, `B` is not an application duplicate: it
is an unbound sensitive object version that must be removed exactly. No schema
migration is required; the existing append-only audit/outbox facts and their
uniqueness contract are sufficient for the cleanup receipt.

After locking and matching the exact organization, bucket, opaque key, parent
Document and DocumentVersion, the object-receipt repository returns the exact
classification
`{status:"unbound_provider_version_cleanup",documentVersionId}` only when the
parent is not `abandoned`, the durable `object_version_id` is non-null and the
event provider version differs from that bound value. The exact bound provider
version remains under the existing duplicate/in-progress/terminal
classification and must never be deleted. A missing or cross-tenant parent, a
wrong bucket/key, or any unverified coordinate fails closed with no object
deletion and no cleanup effect.

The worker dispatches that classification to
`processDocumentUnboundProviderVersionCleanup`. It deletes only the exact
unbound `(bucket,key,event provider version)`, then calls
`recordUnboundProviderVersionRemoval` to append one PII-free audit/outbox bundle
with outcome `unbound_provider_version_removed` and event/effect
`documents.unbound_provider_version_removed`. The idempotency hash is the exact
verified organization, Document, DocumentVersion, bucket, key and event provider
version tuple. Only the derived hash is persisted; the tuple must not be emitted
or stored in plaintext, and the durable effect exposes no object coordinate,
provider version, checksum, MIME, size, URL, filename or bytes.
SQS acknowledgement occurs only after exact deletion is proven successful or
already absent and the durable cleanup effect is complete.

Deletion, effect persistence and acknowledgement are independently retry-safe:
a crash after deletion, after the durable effect or before acknowledgement
replays without a second effect and without touching the bound provider
version. Distinct unbound provider versions each have their own exact cleanup
effect. The cleanup DLQ drain may acknowledge only a message that reclassifies
under the lock as either verified `abandoned_cleanup` or verified
`unbound_provider_version_cleanup`; it must retain every ordinary scan-failure
DLQ message.

Backend acceptance adds focused repository/worker tests for classification,
the exact-bound-version no-delete rule, unbound deletion, concurrency, each
crash boundary, DLQ drain, cross-tenant/wrong-key zero deletion/effects and
private-value redaction. The real Local Dev HTTP gate must reuse the same upload
capability for two PUTs, prove one provider version is bound and becomes
available/downloadable, prove the other exact provider version is absent, and
prove one scan fact plus one cleanup audit/outbox bundle with replay adding zero
rows. The permanent browser harness must repeat the same capability PUT, retain
the authoritative available/download result and prove zero extra provider
versions remain. Independent QA verifies that browser behavior through the
unchanged command in section 11; unrun Backend, browser or QA evidence remains
`not_run (unverified)`.

### 7.2 DOC02-ADR-NEXT-REQUEST-LOG-PRIVACY-002

The opaque object key `documents/{documentId}/versions/{versionId}` is also a
contiguous suffix of the version upload-intent and abandonment API paths. Next
Dev logs full incoming request URLs by default, so those two framework access
logs would disclose the exact object coordinate even when application code
never logs it. This is a source logging defect, not permission to remove object
keys from the privacy scan.

The pinned Next.js `logging.incomingRequests.ignore` contract must suppress only
the anchored, UUID-shaped Document version `upload-intents` and `abandonments`
paths. Other incoming request logs remain enabled. The HTTP and browser harnesses
continue scanning for every bucket, object key, provider version, checksum,
signed URL, signature label, queue URL, private payload marker and database URL
scheme. Marker values are deduplicated before matching. Safe evidence may expose
only fixed channel/category counts; it must never emit the matched value, URL,
ID, hash, body, raw log or stack. All private categories must be zero after the
route filter is active, and focused configuration tests must lock the narrow
patterns so a broad logging disable cannot replace them.

Reconciliation may requeue a quarantined missed event or a stale scan, but can
never mark a version available. Every retry rechecks whether a newer version now
supersedes the failed work.

For `local-synthetic` only, the main queue resource policy has exactly two
`sqs:SendMessage` grants on the exact queue ARN: the existing
`s3.amazonaws.com` grant constrained to the exact bucket ARN/account, and one
grant to the exact LocalStack account root principal used by the fixed `test`
credentials. The second grant exists only so the bounded reconciliation worker
can republish an already-bound opaque `(bucket,key,provider version)` event. It
must not use a wildcard principal, action or resource, and it must not be copied
to `production-aws`. The requeue adapter remains fail closed unless its endpoint
is the configured loopback LocalStack origin and its queue, bucket, opaque key
and provider version match the frozen local contract.

### 7.3 DOC02-ADR-QUEUE-ACK-EVIDENCE-003

`GetQueueAttributes` exposes approximate visible, not-visible and delayed
message counts. Those values may require at least one minute after producers
stop before they become consistent, so a 30-second exact-zero assertion is not
valid evidence that a durable worker outcome was or was not acknowledged.

The Local Dev HTTP and browser gates therefore allow at least 75 seconds for
those three approximate counters to converge. This is evidence-only waiting:
the queue and every receive retain the frozen 180-second visibility timeout,
the three-delivery retry/DLQ boundary is unchanged, and no product dependency,
scan or API timeout is extended.

When an explicit local-test safe-evidence switch is enabled, the document
worker may emit only fixed `DeleteMessage` requested and completed markers.
The harness may retain only bounded marker counts, strict non-negative visible,
not-visible and delayed counts, attribute completeness, bounded poll count and
an allowlisted worker alive/exit state. These markers and observations must not
contain or derive a message body, message ID, receipt handle, queue URL, event
ID, object coordinate, provider version, signed capability, filename, checksum,
bytes or raw log content. Production and ordinary local worker output remain
unchanged when the switch is absent.

Successful cleanup acceptance requires its durable database/object authority,
the fixed completed acknowledgement evidence and converged queue counters. If
the extended window still leaves a visible message, a separately reviewed
bounded receive may classify only fixed booleans for a recognized Document
event and known synthetic fixture; it must not output or persist the message or
alter the product disposition contract.

### 7.4 DOC02-ADR-S3-TEST-EVENT-004

Enabling an S3 bucket notification publishes one `s3:TestEvent` to its
destination. That notification uses a distinct top-level shape instead of the
ordinary `Records` array and is not Document scan work. Retaining it as an
invalid business event leaves a permanently retrying queue message and is not
an acceptable fail-closed outcome.

The document worker may acknowledge this control-plane notification only when
the SQS message and JSON body satisfy a separate strict parser: the message has
the required SQS receipt metadata, `Service` is exactly `Amazon S3`, `Event` is
exactly `s3:TestEvent`, `Bucket` equals the configured exact bucket, and the
remaining fixed test-event fields have bounded non-empty string values. The
test event performs no tenant lookup, object read/delete, scan, audit, outbox or
other business effect. It uses the same fixed local-test acknowledgement
markers as an ordinary successful deletion. Any wrong bucket, unknown event,
malformed body or business event that fails the existing exact parser remains
retained; the ordinary `ObjectCreated:Put` contract is not relaxed.

Focused tests must lock the exact test-event shape, zero business callback and
all malformed/wrong-bucket retention cases. The real HTTP and browser gates
must include its completed acknowledgement in their safe marker counts and
still converge the main queue to zero without exposing the test event body or
its request/host identifiers.

## 8. Frontend Contract

- File input accepts exactly the three allowed MIME types and one file.
- Client validation rejects zero bytes and files above 10 MiB before any POST.
- SHA-256 is calculated in the browser with Web Crypto; raw bytes and checksum
  are never sent to application logs.
- The UI creates the durable version, refreshes authoritative Document state,
  gets a fresh upload capability, performs the exact PUT and polls the
  authoritative detail for a bounded 90 seconds.
- After refresh or re-login, authoritative `pending_upload` state and its exact
  pending reference offer a same-file recovery form. The browser hashes the
  reselected file and reuses section 6.2; an exact MIME/checksum mismatch
  performs no PUT and creates no new version.
- The pending state also offers an explicit fixed-text confirmation to abandon
  and start over. There is no free-text reason. Its synchronous lock and
  fingerprinted idempotency key retain the key for an uncertain retry and
  rotate only when the authoritative Document version changes. Success always
  refreshes the authoritative GET before another version can be created.
- It displays truthful states for awaiting upload, scanning, available,
  rejected, scan failed, unavailable and timeout.
- The selected local filename may be shown only in the current browser state;
  it is not placed in a URL or application API request.
- Download requires `documents.download`, obtains a fresh intent, fetches the
  bytes and triggers the fixed non-PII download name. The signed URL is never
  rendered, persisted or logged.
- Synchronous locks prevent duplicate clicks. Durable version idempotency keeps
  the same key for an uncertain retry and rotates it when file/checksum/size/
  MIME/expected version changes.
- All success paths end with an authoritative GET. Refresh and re-login must
  preserve the visible state.
- Pending recovery state, selected files, version acknowledgements and signed
  capabilities are never persisted in `localStorage`, `sessionStorage`,
  IndexedDB, cookies, URLs or logs.

## 9. Owner Boundaries

### Backend

Owns Access capability changes, migration `035`, manifests/baseline, services,
PostgreSQL repositories, S3/SQS adapters, signer, ClamAV adapter, Route Handlers,
worker entry, local resource contract, synthetic fixtures, focused tests and
`test:doc-02-dev-http`.

### Frontend

Owns strict client DTOs, file/hash/direct PUT/download behavior, Case Document
controls, lifecycle feedback, accessibility/responsive behavior, focused tests
and the permanent `test:doc-02-dev-browser` harness source.

### Platform operations

Owns the local Compose/LocalStack initialization policy, including the exact
two-statement main-queue policy required by section 7 and its focused contract
test. It performs no Neon, Vercel or AWS operation for DOC-02.

### QA

Changes no source. After both owners pass and the architect freezes the source
boundary, QA executes the exact permanent Local Dev browser command once and
returns only allowlisted evidence.

## 10. Required Owner Evidence

Backend acceptance must include:

- Node 22 TypeScript, targeted ESLint, focused service/route/adapter tests and
  architecture tests;
- migration manifest/baseline drift checks and real disposable PostgreSQL 17
  baseline replay with FORCE RLS/owner/grant/security checks;
- one disposable PostgreSQL 17 + LocalStack + ClamAV + SQS worker + isolated
  Next Dev HTTP gate;
- clean PDF upload/scan/activation/download byte hash;
- JPEG/PNG magic-byte acceptance and MIME mismatch rejection;
- generated runtime-only EICAR detection with no committed malicious fixture;
- pre-clean/rejected/failed download denial, previous active version retention,
  duplicate event one scan, same-key replay, changed-key conflict, stale version,
  cross-tenant/unassigned/denied roles, timeout retries, third-delivery DLQ,
  180-second queue/receive visibility, failure before receipt/claim commit,
  crash after claim commit, overlapping running redelivery without deletion,
  delete-after-durable-terminal ordering, reconciliation,
  injected audit/outbox rollback and PII/log redaction;
- refresh-after-create-before-PUT same-file recovery; wrong-file recovery fixed
  client conflict feedback with zero PUT/new version; abandonment exact replay and changed-body
  conflict; a new generation after abandonment; both receipt/abandonment lock
  orders; two late provider versions both deleted; delete timeout retained and
  redriven/DLQ without scan, activation or duplicate business effects;
- one reused upload capability producing two provider versions, with the exact
  bound version retained and available, the unbound version removed, one scan
  fact, one redacted cleanup effect, crash-safe replay and zero extra rows;
- local-test-only fixed acknowledgement requested/completed counts and all
  three approximate queue counters converging within the evidence window,
  without changing the 180-second visibility or three-delivery policy;
- strict zero-business-effect acknowledgement of the exact S3 notification
  `s3:TestEvent`, while malformed, wrong-bucket and unknown messages remain;
- complete container, queue, object, process and temporary-file cleanup.

Frontend self-test must include TypeScript, targeted ESLint, focused client/UI
tests, architecture tests and the permanent browser harness source. Its formal
browser run waits for Backend HTTP/DTO pass.

## 11. Independent QA Gate

The frozen command is:

```sh
env PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin \
  /opt/homebrew/opt/node@22/bin/corepack pnpm test:doc-02-dev-browser
```

The harness internally owns disposable PostgreSQL 17, the current one-role
baseline, Release 1 seed, LocalStack S3/SQS/DLQ, ClamAV, the bounded document
worker, isolated Next Dev, system Chrome and cleanup. QA does not manually
operate any dependency.

QA must prove:

- Founder and assigned Advisor capability UI; denied roles hidden and direct
  API denial;
- validation causes zero POST; uncertain retry reuses one idempotency key;
  changed file rotates it; double click creates one version;
- clean upload becomes available and downloads byte-for-byte correctly;
- download before clean and malicious content remain denied;
- old clean version remains downloadable when a newer upload is rejected;
- one reused upload capability may create two provider versions, but only the
  bound version remains, becomes available and downloads correctly; the extra
  unbound provider version is removed without a second scan;
- refresh/re-login while `pending_upload`, wrong-file recovery with zero PUT,
  successful same-file recovery, exact abandonment replay, authoritative
  abandoned state and a new upload after abandonment;
- refresh/re-login persistence and real stale recovery;
- keyboard/focus behavior, desktop/mobile overflow, bounds, overlap and clipped
  text all zero;
- page errors and sensitive application/worker/Next logs all zero matches;
- browser, Next, worker, app/profile directories, PostgreSQL, LocalStack,
  ClamAV, queues, objects and volumes are cleaned.

Any failure stops the QA gate. Unreached checks remain `not_run (unverified)`;
QA neither edits nor retries without a new architect decision.

## 12. Stop Conditions

Stop and return to architecture if any owner would need to:

- persist or log a signed URL, raw filename, checksum, object coordinate,
  scanner detail or bytes;
- make an unscanned version active or downloadable;
- weaken current Case/tenant/role/RLS checks;
- edit historical migration `006` or hand-edit generated baseline files;
- add a filesystem/in-memory/public fallback or enable local adapters in
  `production-aws`;
- silently change the exact DTO, MIME/size/TTL policy, scan attempts, active
  pointer rule or error mapping;
- claim Vercel, Neon or AWS evidence from Local Dev results.

Git publication occurs only after Backend and Frontend self-tests, independent
QA Local Dev acceptance and final architect security/scope review. The project
owner has already authorized the architect to publish and merge that exact
accepted scope without another approval request.
