# CRM-04 Student 与 Guardian 疑似重复资料人工纠正纵向切片

| Control | Value |
| --- | --- |
| Status | `accepted_for_local_implementation` |
| Architecture contract | `CRM-DUPLICATE-REVIEW-MERGE-UNDO/v1` |
| Product sources | `DEC-004`, `DEC-005`, `DEC-032`, `DEC-042`, `DEC-044`, `P2-05` |
| Delivery owners | Frontend, Backend |
| Acceptance boundary | Local PostgreSQL 17 + real Next Dev HTTP + real browser |
| Remote boundary | Vercel Test and AWS Production are not required for this ticket |

## 1. Business Result

An authorized reviewer can record that two visible Student records or two visible Guardian records
are potential duplicates, compare the two profiles, and leave the candidate for human review. A
Founder can approve one record as canonical, preserve the other UUID as a source alias, record
field-level provenance, and later undo the merge through a new corrective revision.

Matching attributes never decide identity. No candidate creation, merge, or undo deletes a Student,
Guardian, relationship, Case, audit event, outbox event, alias, or provenance revision.

School duplicate correction remains owned by School Intelligence and is excluded from this CRM
vertical slice even though the older domain service contains a future-compatible `school` entity
type.

## 2. Scope

Included:

- review queue for Student and Guardian duplicate candidates;
- server-derived exact normalized match-signal names;
- human comparison and explicit canonical/source selection;
- Founder-only merge and corrective undo;
- append-only alias, merge, field-provenance, correction, audit, outbox, and idempotency facts;
- authoritative Student/Guardian reads resolved through the active alias and field-provenance view;
- Local PostgreSQL 17 HTTP and browser acceptance.

Excluded:

- fuzzy scoring, phonetic matching, AI, background auto-detection, auto-selection, or auto-merge;
- School merge, relationship handoff, profile editing, deletion, purge, bulk import, or legal IDs;
- hiding or hard-deleting the source record;
- Vercel/Neon business verification, AWS Production, or real personal data.

## 3. Authorization Contract

Add two capabilities to `WorkspaceCapability`:

- `students.duplicates.review`: Founder, Advisor, and Data Reviewer own it;
- `students.duplicates.merge`: Founder owns it; every other role is denied.

Candidate creation and review still re-authorize record visibility:

- Founder and Data Reviewer may review visible organization-wide Student/Guardian records;
- Advisor may create or read a candidate only when both records are in the Advisor's current
  manageable Student scope. For Guardians, each Guardian must have a current relationship to at
  least one manageable Student;
- Admin and Contractor cannot list, create, inspect, merge, or undo candidates.

The frontend uses capabilities only for entry and command visibility. Every API independently
checks the session actor, organization, active role binding, candidate state, and record visibility.
The request never supplies organization, actor, role, capability, or assignment claims.

## 4. Candidate And Resolution Model

Candidate entities are exactly `student` and `guardian`.

Server-side normalized match signals:

- Student: `display_name`, `date_of_birth`, `email`, `phone`;
- Guardian: `display_name`, `email`, `phone`.

At least one exact normalized signal must match. The browser does not submit signal names or values;
the repository computes them after locking and reading both records. Only signal names are stored in
the candidate, audit, and outbox. Match values, profile values, and request bodies never enter logs,
audit metadata, or outbox metadata.

Candidate state is `review_required`, `merged`, or `dismissed`. This slice exposes create, read,
merge, and merge undo; dismissal is intentionally deferred to avoid inventing a reason catalogue.

An approved merge:

- preserves both UUID records and their original profile columns;
- appends one active source-to-canonical alias revision;
- appends one field-provenance revision for every supported profile field;
- makes authoritative reads of either UUID resolve to one canonical identity and the selected
  field sources;
- increments candidate and merge versions exactly once;
- never rewrites a prior alias or provenance revision.

Corrective undo appends a new revision that maps the source back to itself and restores the
pre-merge resolved view. It does not update or delete the original merge history.

## 5. Page Flow

`/students/duplicates` provides a quiet work queue with entity type, safe display labels, signal
names, candidate status, and version. It never displays a confidence score or labels two people as
the same person before approval.

`/students/duplicates/{candidateId}` provides:

1. side-by-side current profile comparison;
2. explicit canonical and source selection;
3. one explicit source choice for every supported profile field;
4. a confirmation explaining that source UUID/history remain and no record is deleted;
5. merge result, current alias state, and Founder-only corrective undo.

Loading, empty, denied, stale, conflict, unavailable, success, and corrected states are distinct.
PII drafts or profile comparison data are not stored in browser storage, URLs, analytics, or logs.

## 6. API Contract

All routes use the API v1 envelope, `Cache-Control: no-store`, server session actor, strict DTO
decoders, and PII-free errors.

### 6.0 Candidate record search

`POST /api/v1/crm/duplicate-records/search`

The browser must not place a name, Email, phone number, or date of birth in a URL. Record selection
therefore uses this non-mutating POST endpoint with no `Idempotency-Key` and the exact body:

```json
{
  "entity_type": "student",
  "query": "Synthetic"
}
```

`query` is a trimmed 2-100 character search term. Success data is exactly an array of at most 20
items. Each item is exactly `id`, `entity_type`, `display_label`, and `contact_hint`; `contact_hint`
is a masked string or `null`. Results never contain a full Email, phone number, date of birth,
status, organization ID, relationship, Case, or match decision. The endpoint is capability- and
visibility-scoped exactly like candidate creation. It does not create a candidate or persist the
query.

### 6.1 Candidate list

`GET /api/v1/crm/duplicate-candidates?entity_type=student|guardian&status=review_required|merged`

The query is enum-only and contains no PII. Success returns at most 100 safe summary items with
candidate ID, entity type, left/right record IDs, safe display labels, matching signal names,
status, merge ID or null, and record version.

Each summary is exactly:

```json
{
  "id": "opaque UUID",
  "entity_type": "student",
  "left_record": { "id": "opaque UUID", "display_label": "Safe label" },
  "right_record": { "id": "opaque UUID", "display_label": "Safe label" },
  "matching_signals": ["display_name"],
  "status": "review_required",
  "merge_id": null,
  "record_version": 1
}
```

`matching_signals` is a unique array in server canonical order and contains only the entity's
supported signal names. List success data is exactly an array of these summaries.

### 6.2 Candidate create

`POST /api/v1/crm/duplicate-candidates` with `Idempotency-Key`.

Exact request:

```json
{
  "entity_type": "student",
  "left_record_id": "opaque UUID",
  "right_record_id": "opaque UUID"
}
```

The repository derives matching signals. Success `201` returns the exact candidate summary. No
match signal means `422 VALIDATION_FAILED` and zero writes.

### 6.3 Candidate detail

`GET /api/v1/crm/duplicate-candidates/{candidateId}`

Success returns candidate metadata plus two exact entity-specific profile DTOs and the supported
field names. It never returns audit/outbox payloads, aliases from another candidate, or unrelated
relationships/cases.

Success data is exactly:

```json
{
  "candidate": { "...": "the exact candidate summary" },
  "left_profile": {
    "id": "opaque UUID",
    "display_name": "Synthetic Student",
    "date_of_birth": "2012-06-01",
    "contact_email": "student@example.invalid",
    "contact_phone": null,
    "record_version": 1
  },
  "right_profile": {
    "id": "opaque UUID",
    "display_name": "Synthetic Student Two",
    "date_of_birth": null,
    "contact_email": null,
    "contact_phone": "synthetic-phone",
    "record_version": 1
  },
  "supported_fields": ["display_name", "date_of_birth", "contact_email", "contact_phone"],
  "merge": null
}
```

For `guardian`, each profile instead contains exactly `id`, `display_name`, `email`, `phone`, and
`record_version`, while `supported_fields` is exactly `display_name`, `email`, `phone` in that
order. `supported_fields` is server-authored and must equal the frozen canonical order; the client
does not accept missing, duplicate, reordered, or extra fields.

After a merge, `merge` is exactly:

```json
{
  "id": "opaque UUID",
  "source_record_id": "opaque UUID",
  "canonical_record_id": "opaque UUID",
  "provenance_revision_id": "opaque UUID",
  "status": "active",
  "record_version": 1,
  "correction_id": null
}
```

After corrective undo, `status` is `corrected`, `record_version` is incremented exactly once, and
`correction_id` is the opaque correction UUID. Candidate `status` remains `merged`: correction is
an append-only revision of that completed human decision, not a deletion or reopening of history.
The detail response is the only browser authority for the current merge version after refresh or
re-login.

The comparison profiles remain bound to the candidate pair in every state: `left_profile.id` must
equal `candidate.left_record.id`, and `right_profile.id` must equal `candidate.right_record.id`
before merge, after an active merge, and after corrective undo. They expose the current columns of
the two preserved source records for human comparison; the detail API must not collapse both
profiles into the canonical UUID. Alias/provenance resolution belongs to the normal authoritative
Student and Guardian read paths. Those read paths must resolve either member UUID to the selected
canonical profile while the merge is active and restore independent reads after correction.

### 6.4 Merge

`POST /api/v1/crm/duplicate-candidates/{candidateId}/merges` with `Idempotency-Key`.

Exact request:

```json
{
  "source_record_id": "opaque UUID",
  "canonical_record_id": "opaque UUID",
  "expected_candidate_record_version": 1,
  "expected_source_record_version": 1,
  "expected_canonical_record_version": 1,
  "field_selections": [
    { "field_name": "display_name", "source_record_id": "opaque UUID" }
  ],
  "reason_code": "duplicate.confirmed"
}
```

`reason_code` is fixed to `duplicate.confirmed`; no free text is accepted. Every supported field
must appear exactly once and select one of the two candidate record IDs. Success `200` returns merge
ID, candidate ID, entity type, source/canonical IDs, provenance revision ID, and record version.

### 6.5 Corrective undo

`POST /api/v1/crm/duplicate-merges/{mergeId}/corrections` with `Idempotency-Key`.

Exact request:

```json
{
  "expected_merge_record_version": 1,
  "reason_code": "duplicate.merge.corrected"
}
```

Success `200` returns corrective revision ID, merge ID, source/canonical IDs, restored alias target,
and correction record version.

Error mapping: `401 UNAUTHENTICATED`; `403 FORBIDDEN`; `404 NOT_FOUND` for invisible or missing
records/candidates/merges; `409 STALE_VERSION`; `409 CONFLICT` for pair/state/alias/idempotency
conflicts; `422 VALIDATION_FAILED`; `503 SERVICE_UNAVAILABLE`; unknown errors fail closed as
`500 INTERNAL_ERROR`.

## 7. Transaction And Schema Contract

Backend adds one immutable corrective migration for candidate, merge, alias-revision,
field-provenance-revision, and merge-correction tables, tenant RLS policies, indexes, grants, and
safe trigger functions. Historical migrations and committed generated baseline files are not
edited by hand; the baseline is regenerated through the repository tool.

Candidate create, merge, and undo each run in one tenant-scoped transaction:

1. set transaction-local organization and actor context;
2. claim idempotency;
3. re-authorize and lock all relevant records;
4. compare expected versions and compute/validate the pair;
5. append only the approved candidate/alias/provenance/correction facts;
6. append PII-free audit and outbox facts;
7. complete the idempotency receipt;
8. commit once.

Any failure rolls back every effect. Same-key/same-payload returns the first result; same-key
different payload returns `409 CONFLICT`. Concurrent merges or undo commands allow one winner and
return `409 STALE_VERSION` or `409 CONFLICT` to the loser.

## 8. Local Dev Verification

Backend permanent HTTP gate uses disposable PostgreSQL 17, the regenerated one-role baseline,
Release1 seed, and real Next Dev. It proves candidate-only behavior, server-derived signals,
visibility/tenant denial, Founder-only merge/undo, exact DTOs, stale/idempotency/concurrency,
append-only history, resolved reads through both UUIDs, rollback, and PII-free errors/logs.

Frontend permanent browser gate proves capability-only queue/commands, manual comparison and field
selection, no auto-choice, merge and resolved refresh, logout/login persistence, corrective undo,
denied direct APIs, keyboard/focus, desktop/mobile, and zero sensitive browser logs.

Local acceptance also requires focused TypeScript, ESLint, unit/contract/architecture tests,
`git diff --check`, no unmerged paths, clean migration replay, generated baseline no drift, and
cleanup of all disposable resources. Vercel Test remains `not_run (unverified)`.
