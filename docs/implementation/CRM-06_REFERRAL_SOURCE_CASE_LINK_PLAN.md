# CRM-06 ReferralSource 与 Case 来源关联纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_for_local_implementation` |
| Architecture contract | `CRM-REFERRAL-SOURCE-CASE-LINK/v1` |
| Product sources | `DEC-002`, `DEC-032`, `DEC-042`, `DEC-044`, `P0-06` |
| Delivery owners | Frontend, Backend |
| Acceptance boundary | Local PostgreSQL 17 + real Next Dev HTTP + real browser |
| Remote boundary | Vercel Test and AWS Production are not required for this ticket |

## 1. Business Result

Founder and Admin can maintain organization-owned ReferralSource reference data for banks,
insurers, and other partners. Founder or the current primary Advisor can assign one current source
to a visible Case. The Case preserves the source label, type, and version that were effective when
assigned, even after the source is renamed or inactivated.

A ReferralSource is not a person or system user. It has no credential, session, membership, role,
workspace access, case-read permission, portal, or notification destination.

## 2. Scope

Included:

- ReferralSource list, create, detail, safe metadata update, and irreversible inactivation;
- current and historical Case referral-source association;
- capability-only UI and server-side Case assignment checks;
- idempotency, optimistic concurrency, PII-free audit/outbox facts;
- Local PostgreSQL 17 HTTP and browser acceptance.

Excluded:

- partner login, case access, external portal, commission, billing, API key, notification delivery;
- hard delete, reactivation, duplicate-source merge, bulk import, source scoring, or automatic Case
  assignment;
- storing contact-person Email, phone, bank account, policy number, or customer data;
- Vercel/Neon business verification, AWS Production, or real partner data.

## 3. Authorization Contract

Add three capabilities to `WorkspaceCapability`:

- `referral_sources.read`: Founder, Admin, and Advisor own it;
- `referral_sources.manage`: Founder and Admin own it;
- `cases.referral_sources.assign`: Founder and Advisor own it.

Server authorization additionally requires:

- Founder may assign a source to any visible Case;
- Advisor may assign only when they are the current primary Advisor for the non-ended Case;
- Admin may maintain ReferralSource records but cannot read or assign Cases;
- Data Reviewer and Contractor have no ReferralSource or assignment capability;
- inactive sources remain readable as historical reference data but cannot receive a new assignment.

Frontend visibility is capability-only. Requests never provide organization, actor, role,
capability, assignment, or Case-access claims.

## 4. Data Contract

ReferralSource type is exactly `bank`, `insurance`, or `other_partner`. Free-form source types are not
accepted. `display_name` is 1-200 trimmed characters. Duplicate display names remain valid because a
name is not an identity key.

The existing `crm_referral_sources` table remains authoritative. Add one append-only history table,
`crm_case_referral_source_assignments`, with organization, Case, source, source display/type/version
snapshot, start/end timestamps, ended-by receipt, record version, and tenant-safe foreign keys. A
partial unique index permits at most one current assignment per Case.

Changing a Case source ends the previous assignment and inserts a new one in the same transaction.
Historical rows and snapshots are never updated except for the one controlled close transition.
Inactivating a source does not rewrite or remove existing Case history.

## 5. Page Flow

`/referral-sources` shows active/inactive sources, fixed type labels, and a capability-gated create
command. `/referral-sources/{sourceId}` shows safe metadata and, for managers, update/inactivate
commands. It never shows partner account, contact-person, or Case data.

The Case detail ReferralSource panel shows the current source and historical assignments. Founder or
current primary Advisor can select one active source and save. The screen explains that changing the
source closes the previous link rather than overwriting history.

Loading, empty, denied, stale, conflict, unavailable, success, inactive-source, and historical states
are distinct. Drafts are not stored in browser storage, URLs, analytics, or logs.

## 6. API Contract

All routes use API v1 envelopes, `Cache-Control: no-store`, strict DTOs, the server session actor,
`Idempotency-Key` on writes, and PII-free errors.

### 6.1 ReferralSource list and create

`GET /api/v1/referral-sources?status=active|inactive` returns at most 100 exact summaries.

`CRM06-ADR-DTO-001` freezes this response as one `data` array with no inner wrapper. The optional
query accepts exactly one `status` key with enum `active|inactive`; unknown, duplicate, empty, or
additional query keys are rejected. With no filter, active rows sort before inactive rows; within
each status rows sort by `display_name ASC, id ASC`. Every item has exactly these five keys:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "display_name": "Synthetic Partner",
  "source_type": "bank",
  "status": "active",
  "record_version": 1
}
```

`source_type` is one of `bank|insurance|other_partner`; `status` is one of `active|inactive`.
List and detail use this same exact five-key item. No timestamps, organization, actor, contact,
account, Case, credential, or arbitrary metadata field is exposed.

`POST /api/v1/referral-sources` exact body:

```json
{
  "display_name": "Synthetic Partner",
  "source_type": "bank"
}
```

Success `201` returns the exact non-PII acknowledgement frozen below; the client then fetches the
authoritative detail.

### 6.2 ReferralSource detail and update

`GET /api/v1/referral-sources/{sourceId}` returns the same exact DTO.

`PATCH /api/v1/referral-sources/{sourceId}` exact body:

```json
{
  "expected_record_version": 1,
  "display_name": "Synthetic Partner Updated",
  "status": "inactive"
}
```

`status` may remain unchanged or move `active -> inactive`; `inactive -> active` is rejected. Success
`200` returns the exact non-PII acknowledgement frozen below. No `DELETE` route exists.

`source_type` is immutable after create. PATCH requires all three listed keys and at least one actual
change to `display_name` or `status`; an exact no-op, inactive-to-active transition, or any extra key
returns `409 CONFLICT` with no write. Create and PATCH require `Idempotency-Key`; exact replay returns
the first exact acknowledgement, while the same key with a different payload returns `409 CONFLICT`.

### 6.3 Case assignment read and write

`GET /api/v1/cases/{caseId}/referral-source-assignments` returns current assignment plus closed
history, each containing assignment ID, source ID, source display/type/version snapshot, starts/ends,
and record version.

The GET `data` object has exactly `current` and `history`. `current` is either `null` or one assignment;
`history` is an array of at most 100 closed assignments ordered by `ends_at DESC, id ASC`. The current
assignment never appears in `history`. Every assignment has exactly these eight keys:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "referral_source_id": "00000000-0000-4000-8000-000000000000",
  "source_display_name": "Synthetic Partner",
  "source_type": "bank",
  "source_record_version": 1,
  "starts_at": "2026-08-23T00:00:00.000Z",
  "ends_at": null,
  "record_version": 1
}
```

Closed history requires non-null `ends_at`; current requires `ends_at=null`. Source display, type,
and version are immutable assignment-time snapshots. Source rename or inactivation never changes an
existing assignment snapshot. Internal close provenance is not exposed by this endpoint.

`record_version` is the monotonic Case referral-assignment chain version, not an ID-local create
counter. The first current assignment has version 1. On replacement, the closed previous row and the
new current row both receive `previous current record_version + 1`. This lets the next command use
the current version as the single optimistic-concurrency token for the Case association; two
concurrent replacements based on one version permit exactly one winner and one `STALE_VERSION`.

`POST /api/v1/cases/{caseId}/referral-source-assignments` exact body:

```json
{
  "referral_source_id": "opaque UUID",
  "expected_current_assignment_record_version": null
}
```

On replacement, the expected current version is required. Success `200` returns the exact non-PII
acknowledgement frozen below. Re-selecting the same source is an idempotent business no-op only when
the same request key and payload replay the first result.

For the first assignment, `expected_current_assignment_record_version` must be `null`; when a current
assignment exists it must be that positive version. The opposite shape or a stale version returns
`409 STALE_VERSION`. A new idempotency key that selects the already-current source returns
`409 CONFLICT`; only exact same-key/same-payload replay returns the original result. Assignment reads
require `cases.read`; writes require `cases.referral_sources.assign` plus the server-derived Case
scope.

`CRM06-ADR-IDEMPOTENCY-003` freezes every write success receipt. ReferralSource create/PATCH and Case
assignment POST return `data` with exactly two keys:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "record_version": 1
}
```

The ID is the created or updated ReferralSource ID for source writes and the new assignment ID for
Case assignment writes. The acknowledgement contains no display label, source type/status, Case ID,
source ID, timestamp, request body, or other mutable business field. It exists only to confirm the
command and make exact replay reconstructable from the bounded idempotency result reference. UI
success requires a subsequent authoritative GET: source create/PATCH fetches detail, and assignment
POST fetches `{current,history}`. Acknowledgement decoders reject missing, extra, malformed, or
mismatched IDs/versions and never treat the receipt itself as displayed business state.

ReferralSource create acknowledgement version is 1; ReferralSource PATCH acknowledgement version is
exactly `expected_record_version + 1`. First Case assignment acknowledgement version is 1;
replacement acknowledgement version is exactly
`expected_current_assignment_record_version + 1`.

Errors: `401 UNAUTHENTICATED`; `403 FORBIDDEN`; `404 NOT_FOUND` for missing, cross-tenant, or invisible
resources; `409 STALE_VERSION`; `409 CONFLICT` for inactive source, ended Case, invalid transition, or
idempotency conflict; `422 VALIDATION_FAILED`; `503 SERVICE_UNAVAILABLE`; unknown errors fail closed
as `500 INTERNAL_ERROR`.

`CRM06-ADR-INVISIBLE-005` freezes the Advisor scope boundary. A valid Advisor session that has the
assignment capability but is not the current primary Advisor for the requested non-ended Case must
receive `404 NOT_FOUND`, because that Case is outside the server-derived visible scope. `403
FORBIDDEN` remains for roles that lack the assignment capability entirely. Browser and HTTP evidence
must preserve this distinction and must not expose Case, source, or request payload fields.

## 7. Transaction And Migration Contract

Backend adds one immutable migration for the assignment table, tenant RLS, indexes, grants, and
controlled close/delete-rejection triggers. Historical migrations and generated baseline files are
not edited by hand; the baseline is regenerated through the repository tool and replayed from empty
PostgreSQL 17.

`CRM06-ADR-OWNERSHIP-002` freezes module ownership. CRM owns `ReferralSource` and every write to
`crm_referral_sources`. Cases owns `CaseReferralSourceAssignment`, its repository, its routes under
`/api/v1/cases/{caseId}`, and every write to the new assignment table. The Cases assignment
transaction may read and lock the CRM source row to validate its active state and snapshot, but it
must not update that row. CRM source management must not write Case assignment history. The new
history table records the controlled close provenance internally as `ended_by_assignment_id`, a
nullable tenant-safe self-reference set exactly once when the successor assignment is inserted; it
is not part of the public DTO. Audit/outbox metadata contains only IDs, fixed type/status/effect codes,
versions, and timestamps, never the source display name or request body.

The physical assignment table name is exactly `cases_case_referral_source_assignments`. Migration
032 does not add a mutable-response snapshot or expand the shared idempotency schema; the exact
two-key acknowledgements make both source and assignment replays reconstructable from the existing
bounded `result_reference` without storing mutable display data.

Create/update/inactivate/assignment commands each run in one tenant-scoped transaction:

1. set transaction-local organization and actor context;
2. claim idempotency;
3. re-authorize and lock the source, Case, current primary Advisor, and current assignment as needed;
4. validate expected versions, source state, and Case state;
5. append or perform the controlled versioned transition;
6. append PII-free audit and outbox facts;
7. complete idempotency and commit once.

Any failure rolls back every effect. Same-key/same-payload returns the first result; same-key/different
payload returns `409 CONFLICT`. Concurrent replacements allow one winner. Hard delete, reactivation,
partner identity creation, and Case-access grants are independently rejected.

## 8. Local Dev Verification

Backend permanent HTTP tests use disposable PostgreSQL 17, regenerated one-role baseline, Release1
seed, and real Next Dev. They prove role/capability matrix, current-primary Advisor restriction,
exact DTOs, duplicate names, fixed types, inactivation, snapshot preservation, replacement history,
inactive/ended/cross-tenant denial, stale/idempotency/concurrency, rollback, no partner Identity rows,
and PII-free errors/logs.

Frontend permanent browser tests prove capability-only source management and Case assignment,
active-only selection, authoritative refresh, historical display, reload/relogin persistence,
Admin source management without Case entry, denied direct APIs, keyboard/focus, desktop/mobile, and
zero sensitive browser logs.

Acceptance also requires focused TypeScript, ESLint, unit/contract/architecture tests,
`git diff --check`, no unmerged paths, clean migration replay, generated baseline no drift, and
cleanup of all disposable resources. Vercel Test remains `not_run (unverified)`.
