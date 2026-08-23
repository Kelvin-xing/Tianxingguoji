# CRM-05 Student 与 Guardian 待删除审查纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_for_local_implementation` |
| Architecture contract | `CRM-PENDING-DELETE-REVIEW/v1` |
| Product sources | `DEC-032`, `DEC-042`, `DEC-044`, `DEC-045`, `P0-06` |
| Delivery owners | Frontend, Backend |
| Acceptance boundary | Local PostgreSQL 17 + real Next Dev HTTP + real browser |
| Remote boundary | Vercel Test and AWS Production are not required for this ticket |

## 1. Business Result

An authorized user can request that an active Student or Guardian enter `pending_delete`. A Founder
can review the queue and see the non-destructive lifecycle receipt. Once pending, the record remains
available to authorized readers as a visibly restricted record, but profile edits, new Guardian
relationships, duplicate merges, and new Case association are denied.

This slice never purges a record. The retention duration, legal-hold source, and cross-module
reference-clearance authority remain unresolved product decisions. The application therefore
exposes no purge route, command, button, worker, scheduled job, or manual SQL runbook.

## 2. Scope

Included:

- request `active -> pending_delete` for Student and Guardian;
- Founder review queue and exact lifecycle receipt;
- idempotency, optimistic concurrency, PII-free audit and outbox facts;
- authoritative reads that distinguish active and pending-delete state;
- fail-closed guards on later CRM writes against pending-delete records;
- Local PostgreSQL 17 HTTP and browser acceptance.

Excluded:

- `pending_delete -> purged`, retention calculation, legal hold mutation, reference cleanup, restore,
  cancellation, hard delete, bulk operation, or background processing;
- showing deletion reason text, user identity, Email, phone, or date of birth in the queue;
- Vercel/Neon business verification, AWS Production, or real personal data.

## 3. Authorization Contract

Add two capabilities to `WorkspaceCapability`:

- `students.deletion.request`: Founder and Advisor own it;
- `students.deletion.review`: Founder owns it.

Every request is re-authorized on the server:

- Founder may request pending delete for any visible active Student or Guardian in the organization;
- Advisor may request it only for a Student currently in the Advisor's manageable scope, or a
  Guardian with a current relationship to at least one manageable Student;
- Admin, Data Reviewer, and Contractor cannot request, list, inspect, or action deletion review;
- review capability is read-only in this slice and does not imply purge authority.

`CRM05-ADR-DENIED-ROLE-004` freezes the denied-role read boundary. CRM-05 does not add
`students.read` to Data Reviewer or Contractor. Admin keeps its existing `students.read` capability
and may read Student detail while all deletion-request and deletion-review commands stay hidden and
server-denied. Data Reviewer keeps only its independent CRM-04
`students.duplicates.review` access; that duplicate-review queue does not imply access to the
general Student list or detail. Therefore both Data Reviewer and Contractor receive the existing
Student denied state and `403 FORBIDDEN` from Student list/detail/current-relationship reads, and
also receive `403 FORBIDDEN` from deletion request and review-queue APIs. Frontend tests must verify
these existing capability boundaries instead of granting or inferring `students.read` from a role.

The frontend uses capabilities only. Requests never contain organization, actor, role, capability,
assignment, retention, legal-hold, or reference-clearance claims.

## 4. Page Flow

Student and Guardian detail pages show a capability-gated `Request pending deletion` command for an
active manageable record. The confirmation explains that access is restricted but the record is
not deleted. The command uses the fixed reason code `record.lifecycle.pending_delete_requested` and
accepts no free text.

`/students/deletion-requests` is Founder-only and shows safe rows containing entity type, record ID,
safe display label, requested timestamp, lifecycle status, and record version. It does not show
contact fields, date of birth, requester identity, request body, or a purge action.

Pending-delete detail views visibly disable profile edit, Guardian attach/handoff, duplicate merge,
and Case creation actions. Loading, empty, denied, stale, conflict, unavailable, success, and
already-pending states are distinct.

## 5. API Contract

All routes use the API v1 envelope, `Cache-Control: no-store`, strict DTOs, server session actor,
`Idempotency-Key` on writes, and PII-free errors.

### 5.1 Request Student pending delete

`POST /api/v1/students/{studentId}/deletion-requests`

Exact body:

```json
{
  "expected_record_version": 1,
  "reason_code": "record.lifecycle.pending_delete_requested"
}
```

Success `200` returns exactly `entity_type`, `entity_id`, `status`, `deletion_requested_at`, and
`record_version`.

### 5.2 Request Guardian pending delete

`POST /api/v1/guardians/{guardianId}/deletion-requests` uses the same body and success DTO.

### 5.3 Founder review queue

`GET /api/v1/crm/deletion-requests?entity_type=student|guardian`

The optional query is enum-only. Success returns at most 100 safe summaries ordered by request time
and opaque ID. It never returns contact fields or a purge-eligibility claim.

`CRM05-ADR-DTO-001` freezes the response contract. With no query parameter, the endpoint returns both
Student and Guardian requests; with `entity_type`, it returns only that type. `data` is one array of
at most 100 items ordered by `deletion_requested_at DESC, entity_id ASC`. Every item has exactly:

```json
{
  "entity_type": "student",
  "entity_id": "00000000-0000-4000-8000-000000000000",
  "display_label": "Safe display label",
  "status": "pending_delete",
  "deletion_requested_at": "2026-08-23T00:00:00.000Z",
  "record_version": 2
}
```

`entity_type` is only `student|guardian`; `status` is only `pending_delete`. Student and Guardian use
the same exact six-key shape. The response has no wrapper inside `data`, no request or actor ID, no
reason text, contact field, date of birth, relationship, Case, legal-hold, retention, reference, or
purge field. The two write receipts in sections 5.1 and 5.2 use the same shape without
`display_label`, exactly the five fields already listed there.

`CRM05-ADR-READ-002` freezes the authoritative read-model change. The existing Student detail DTO
already exposes the Student lifecycle status. Each Guardian item embedded in that detail now adds
exactly one required `status` field with enum `active|pending_delete`; its other keys and meanings do
not change. `purged` Student or Guardian records remain invisible. Frontend decoders fail closed when
the field is missing, extra lifecycle values appear, or another unapproved key is added.

Errors: `401 UNAUTHENTICATED`; `403 FORBIDDEN`; `404 NOT_FOUND` for missing, cross-tenant, purged, or
invisible records; `409 STALE_VERSION`; `409 CONFLICT` for already-pending or idempotency conflict;
`422 VALIDATION_FAILED`; `503 SERVICE_UNAVAILABLE`; unknown errors fail closed as
`500 INTERNAL_ERROR`.

No `/purge`, `/approve-purge`, restore, cancellation, `DELETE`, or lifecycle PATCH route exists.

## 6. Transaction And Schema Contract

The current Student and Guardian tables already carry deletion request receipt columns and enforce
`active -> pending_delete -> purged`. Backend may add one immutable migration only for supporting
indexes, RLS/grants, or idempotent review-query performance proven necessary by the implementation.
Historical migrations and generated baseline files are never hand-edited; any migration requires
repository baseline regeneration.

`CRM05-ADR-PRIMARY-003` freezes the primary-contact invariant for this lifecycle. A current primary
Guardian remains the Student's authoritative primary contact while that Guardian is `active` or
`pending_delete`; requesting review does not close or replace the relationship. An active Student
must therefore still have exactly one current primary relationship whose Guardian status is one of
those two readable states. `purged` Guardians never satisfy the invariant. The implementation uses
one additive immutable migration to replace only `crm_assert_student_primary_contact`, preserving
the exactly-one rule, relationship history, deferred constraint timing, RLS, ownership, and grants.
The source migration, manifest, generated one-role baseline, and baseline manifest must be produced
through repository tooling and replayed on disposable PostgreSQL 17 before the HTTP gate is rerun.

Each request executes in one tenant-scoped transaction:

1. set transaction-local organization and actor context;
2. claim idempotency;
3. re-authorize and lock the active record;
4. compare expected version;
5. write the fixed deletion receipt and `pending_delete` state;
6. append PII-free audit and outbox facts;
7. complete idempotency and commit once.

Any failure rolls back all effects. Same-key/same-payload returns the first result; same-key/different
payload returns `409 CONFLICT`. Concurrent requests allow one winner. All CRM write services must
deny pending-delete or purged records before mutation.

## 7. Local Dev Verification

Backend permanent HTTP tests use disposable PostgreSQL 17, the current one-role baseline, Release1
seed, and real Next Dev. They prove exact lifecycle transition, Founder/Advisor scope, every denied
role, cross-tenant invisibility, stale/idempotency/concurrency, rollback, write guards, queue privacy,
audit/outbox privacy, and absence of any purge path.

Frontend permanent browser tests prove capability-only commands and queue, confirmation, request,
authoritative refresh, reload and relogin persistence, restricted pending-delete commands, direct API
denial, keyboard/focus, desktop/mobile, and zero sensitive browser logs.

Acceptance also requires focused TypeScript, ESLint, unit/contract/architecture tests,
`git diff --check`, no unmerged paths, clean migration replay when applicable, no generated baseline
drift, and cleanup of all disposable resources. Vercel Test remains `not_run (unverified)`.
