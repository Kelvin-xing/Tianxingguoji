# CRM-03 Student 与 Guardian 基础资料维护纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_for_local_implementation` |
| Architecture contract | `CRM-STUDENT-GUARDIAN-PROFILE-MAINTENANCE/v1` |
| Product sources | `DEC-004`, `DEC-005`, `DEC-006`, `DEC-032`, `DEC-042`, `DEC-044`, `DEC-045` |
| Delivery owners | Frontend, Backend |
| Acceptance boundary | Local PostgreSQL 17 + real Next Dev HTTP + real browser |
| Remote boundary | Vercel Test and AWS Production are not required for this ticket |

## 1. Business Result

An authorized Founder or Advisor can edit the basic profile of an active Student and the basic
profile of an active Guardian that the actor is allowed to manage. Successful changes remain
visible after refresh, logout, and login. A stale browser cannot overwrite a newer update.

Student and Guardian remain independent UUID identities. Names, dates of birth, Email addresses,
and phone numbers are attributes only. Matching attributes may later produce a CRM-04 review
candidate, but CRM-03 never joins, merges, aliases, or automatically links records.

## 2. Scope

Included:

- edit Student `display_name`, `date_of_birth`, `contact_email`, and `contact_phone`;
- edit Guardian `display_name`, `email`, and `phone`;
- exact API v1 request and response DTOs;
- optimistic concurrency using `expected_record_version`;
- idempotent update receipts, audit, and outbox in the same PostgreSQL transaction;
- capability-controlled UI and independent server authorization;
- Local Dev HTTP and browser verification with PostgreSQL 17.

Excluded:

- changing UUID, organization, status, lifecycle, relationship type, relationship flags, or primary
  contact;
- creating or removing a Student-Guardian relationship;
- duplicate candidate creation, merge, merge undo, deletion, purge, or retention decisions;
- legal identity numbers or document images;
- bulk import, cloud deployment, shared database writes, or real personal data.

## 3. Authorization Contract

Add `students.profiles.manage` to `WorkspaceCapability`.

- `founder`: owns the capability and may update any active Student or Guardian in the organization.
- `advisor`: owns the capability, but may update a Student only when the Advisor is the current
  primary Advisor on at least one non-ended ServiceCase for that Student. A Guardian is manageable
  only when the Guardian has a current relationship to at least one such manageable Student.
- `admin`, `data_reviewer`, and `contractor`: do not own the capability.
- `students.read` remains the separate read capability.

The frontend uses the capability only to show edit entry points. Each update route independently
authorizes the current session actor, tenant, record status, and Advisor assignment. Client-supplied
organization IDs, actor IDs, roles, capabilities, or assignment claims are rejected. A direct
request by a denied actor returns `403 FORBIDDEN` and performs zero writes.

## 4. Page Flow

The Student detail page keeps its existing read view and adds:

1. `Edit Student profile`, visible only with `students.profiles.manage`.
2. `Edit Guardian profile` on each current Guardian card only when the same capability is present.
3. A focused edit surface with existing values, explicit Save and Cancel, a visible saving state,
   and distinct validation, stale-version, denied, unavailable, and success states.

The user never edits an opaque ID or record version. A stale response presents a conflict and asks
the user to reload the authoritative record; it never silently reapplies the local draft. Unsaved
PII drafts are not written to localStorage, sessionStorage, URLs, analytics, or logs.

## 5. Field Contract

Student request fields:

- `display_name`: required trimmed string, 1-512 characters;
- `date_of_birth`: valid `YYYY-MM-DD` calendar date or `null`;
- `contact_email`: valid lower-cased Email, maximum 320 characters, or `null`;
- `contact_phone`: trimmed string, maximum 64 characters, or `null`;
- `expected_record_version`: positive safe integer.

Guardian request fields:

- `display_name`: required trimmed string, 1-512 characters;
- `email`: valid lower-cased Email, maximum 320 characters, or `null`;
- `phone`: trimmed string, maximum 64 characters, or `null`;
- `expected_record_version`: positive safe integer;
- at least one of `email` or `phone` must remain non-null.

The server accepts the exact field set only. Unknown and nested extra fields return
`400 INVALID_REQUEST`. Known invalid values return `422 VALIDATION_FAILED`. The server performs the
same normalization and validation regardless of browser behavior.

## 6. API Contract

All routes use the existing v1 success/error envelope, `Cache-Control: no-store`, the authenticated
server-side actor, and an `Idempotency-Key` header. No request includes organization or role data.

### 6.1 Student update

`PATCH /api/v1/students/{studentId}`

Exact request:

```json
{
  "display_name": "Synthetic Student",
  "date_of_birth": "2012-06-01",
  "contact_email": "student@example.invalid",
  "contact_phone": null,
  "expected_record_version": 1
}
```

Success `200`, exact non-PII acknowledgement data:

```json
{
  "student": {
    "id": "opaque UUID",
    "record_version": 2,
    "updated_at": "ISO-8601 UTC"
  }
}
```

The client must then refresh the authoritative Student GET before rendering the saved profile.
The PATCH acknowledgement intentionally excludes profile fields so the existing bounded
idempotency receipt can preserve an exact replay without duplicating PII.

### 6.2 Guardian update

`PATCH /api/v1/guardians/{guardianId}`

Exact request:

```json
{
  "display_name": "Synthetic Guardian",
  "email": "guardian@example.invalid",
  "phone": null,
  "expected_record_version": 1
}
```

Success `200`, exact non-PII acknowledgement data:

```json
{
  "guardian": {
    "id": "opaque UUID",
    "record_version": 2,
    "updated_at": "ISO-8601 UTC"
  }
}
```

The client must then refresh the authoritative Student/Guardian GET view before rendering the saved
profile. The PATCH acknowledgement intentionally excludes profile fields for the same bounded,
PII-free idempotency reason.

Read DTOs used by the edit surface must expose Student and Guardian `record_version` values as
positive integers. The client decoder remains exact and fails closed on missing, malformed, or
extra fields.

Error mapping:

- `401 UNAUTHENTICATED`: no valid session;
- `403 FORBIDDEN`: capability or assignment denial;
- `404 NOT_FOUND`: invalid, missing, cross-tenant, purged, or otherwise invisible record;
- `409 STALE_VERSION`: current record version does not equal the expected version;
- `409 CONFLICT`: idempotency key reused with a different canonical payload or record is not active;
- `422 VALIDATION_FAILED`: known field validation failure;
- `503 SERVICE_UNAVAILABLE`: runtime or database unavailable;
- unknown errors fail closed as the standard `500 INTERNAL_ERROR` envelope.

No error response contains names, dates of birth, Email addresses, phone numbers, request bodies,
SQL, PostgreSQL messages, stack traces, cookies, or connection data.

## 7. Idempotency And Concurrency

- Student and Guardian updates use separate operation namespaces.
- One Save attempt and an uncertain network retry reuse the same `Idempotency-Key` and exact
  canonical payload.
- Editing any field after a Save attempt rotates the key before the next submission.
- Synchronous double-clicks issue at most one request.
- Same key plus same canonical payload returns the first exact non-PII acknowledgement without a
  second update, audit, or outbox row. The receipt stores only target ID, resulting version, and
  first update time; profile values are always refreshed through an authorized GET.
- Same key plus different payload returns `409 CONFLICT` with zero new effects.
- The repository compares `expected_record_version`; zero updated rows after authorization and lock
  maps to `409 STALE_VERSION`. There is no last-write-wins behavior.

## 8. PostgreSQL Transaction Contract

Each update runs in one tenant-scoped transaction:

1. set transaction-local organization and actor context;
2. claim and validate the idempotency receipt;
3. authorize role/capability and, for Advisor, the current case assignment;
4. lock the active target row and compare `expected_record_version`;
5. update only the approved profile columns, increment `record_version` exactly once, and update
   `updated_at`;
6. append one PII-free audit event and one PII-free outbox message;
7. complete the idempotency receipt with the exact non-PII acknowledgement reference;
8. commit once.

Any failure rolls back the profile update, idempotency receipt, audit, and outbox together. Audit
and outbox metadata contain only opaque IDs, operation, resulting version, status, and request ID.
They never contain changed PII values or before/after payloads.

The existing CRM table and trigger contract is expected to support this slice. If a real local
PostgreSQL test reveals a missing index, policy, or authorization primitive, Backend must stop and
propose a new additive migration. Historical migrations and generated baseline files are never
edited in place.

## 9. Local Dev Verification

Backend permanent HTTP gate:

- disposable PostgreSQL 17 built from the current one-role baseline and Release1 synthetic seed;
- real Next Dev routes, not direct service-only calls;
- Founder allowed Student and Guardian updates;
- assigned Advisor allowed; unassigned Advisor denied with zero writes;
- Admin denied by direct PATCH with zero writes;
- exact DTO and strict extra-field rejection;
- exact replay, changed-payload conflict, stale version, cross-tenant, inactive record, unavailable,
  and local-only forced transaction failure;
- profile/idempotency/audit/outbox aggregate deltas and rollback state;
- PII-free errors and logs.

Frontend permanent browser gate:

- real local browser over the same disposable PostgreSQL 17 and Next Dev runtime;
- capability-driven entry visibility;
- current values, client validation with zero PATCH, synchronous lock, uncertain retry key reuse,
  and field-change key rotation;
- Student update and Guardian update, authoritative refresh, logout/login persistence;
- stale-version recovery without silent overwrite;
- denied role hidden entry and direct PATCH denial;
- loading, success, validation, conflict, denied, unavailable, desktop, mobile, keyboard, focus,
  overflow, page-error, and sensitive-log checks;
- complete cleanup of temporary containers, volumes, processes, profiles, and directories.

Local acceptance requires focused TypeScript, ESLint, unit/contract/architecture tests, the real
HTTP gate, the real browser gate, `git diff --check`, no unmerged paths, and migration/baseline
no-drift evidence. Passing those Local Dev and security gates authorizes the architect to publish
and merge the exact reviewed Git scope under the standing project authorization.
