# CASE-FLOW-DELTA-01 K12 Case Workflow Implementation Delta

| Control | Frozen value |
| --- | --- |
| Programme | `CASE-FLOW-DELTA-01` replaces the superseded eight-stage Case workflow |
| Date | 2026-08-24 (Asia/Singapore) |
| Status | `accepted_for_local_implementation` |
| Authority | `txgj-doc/business-requirements/30-cases.zh-CN.md` (`BR-030`–`BR-034`, `BR-039`), `40-tasks.zh-CN.md` (`BR-035`–`BR-037`), and `70-notifications-audit.zh-CN.md` (`BR-038`) |
| Acceptance | Local-only: disposable PostgreSQL 17, current one-role baseline, Release 1 synthetic seed, isolated Next Dev, system Chrome, independent QA |
| Remote state | Vercel Test, Neon and AWS Production are outside this programme and remain `not_run (unverified)` |

## 1. Outcome And Supersession

This programme closes the difference between the adopted K12 workflow and the
current implementation. It does not treat the current source as authority when
that source still implements the superseded eight-stage Case flow, terminal
`waitlisted|accepted` SchoolTargets, persisted `overdue|approved` Task states, or
manual-only Tasks.

The accepted end-to-end customer path is:

1. an offline-signed service creates one K12 ServiceCase and automatically enters
   `background_collection`;
2. the Primary Advisor completes the approved 15-field Assessment;
3. the Primary Advisor submits a versioned candidate-school list, the Founder
   approves or rejects that exact version, and the Primary Advisor records the
   Guardian's off-platform confirmation of the approved version;
4. confirmed targets enter independent application processing, with one
   idempotent prepare-and-submit Task per target and an optional interview Task;
5. SchoolTargets retain independent state and append-only outcome/Guardian offer
   decisions;
6. all terminal targets and no open Tasks make a Case eligible for, but never
   automatically cause, Founder close;
7. whole-service termination withdraws active targets and cancels open Tasks in
   one transaction before Founder close; re-signing always creates a new Case.

This programme does not implement pre-sign Lead, Quote or sales Contract,
Guardian writes, external email/SMS/WhatsApp, production billing amounts,
Document deletion/purge, cloud infrastructure or deployment.

## 2. Verified Current-State Gaps

The 2026-08-24 `origin/main` baseline has 34 source migrations and 35 generated
one-role files. The following gaps are source-proven and must not be described as
complete before their owning slice passes:

| Area | Current implementation | Required delta |
| --- | --- | --- |
| ServiceCase | old eight-stage constraint and narrow `signed <-> background_collection` function | five milestones, automatic entry, pause/resume overlay, termination and Founder-only manual close |
| Assessment | approved manifest/answers exist, but the workspace and permission boundary still reflect earlier role assumptions | exact 15-field blockers and Primary Advisor/collaborator write, Founder/Admin read-only |
| Candidate list | candidate SchoolTargets are created one at a time with no immutable list version | append-only list versions, Founder decision and Guardian confirmation bound to the same version |
| SchoolTarget | `waitlisted` and `accepted` are treated as terminal and offer decisions are absent | `offer_confirmed|offer_declined`; only four terminal states; retained target facts across list revisions |
| Task | OD-06 persists `reassigned`, `approved` and `overdue`; TASK-01 is manual create | same-Task reassignment to `assigned`, completion without Founder approval, computed overdue, two automatic target Task types |
| Submission evidence | old route requires a generic official reference | type-specific completion fact with submitted time/channel/actor/checklist plus reference number or a clean Case Document |
| Notifications | worker accepts only legacy Task/Case effects and has no live runtime | exact in-app effects, recipient resolution, 3-day/1-day/daily cadence and daily deduplication |
| Close/count | old target-terminal and `offer_confirmed -> closed` assumptions | all-target/no-open-Task eligibility, Founder decision, termination branch and `advancing_case_count_v1` |

No historical migration or generated baseline SQL may be edited. Every database
change is additive and regenerated with repository tooling.

## 3. Shared Invariants

All slices obey these invariants:

- one organization role is selected by the server session; browsers never send
  organization, role, capability, ownership, lifecycle or authorization claims;
- every write uses `Idempotency-Key`, `expected_record_version` where a mutable
  aggregate is involved, strict request parsing and a non-PII acknowledgement;
- an acknowledgement is not authoritative UI state; every browser write is
  followed by the exact authoritative GET before success is rendered;
- the repository reauthorizes current membership, capability and resource scope
  after taking the owning row locks in the same tenant transaction;
- the business fact, immutable history, idempotency receipt, PII-free audit and
  PII-free outbox effect commit once or roll back together;
- missing, cross-tenant, ended, pending-delete and out-of-scope resources are
  resource-invisible; unknown failures fail closed;
- exact replay returns the first acknowledgement without new effects; the same
  key with a changed semantic payload returns conflict;
- client DTOs reject missing, extra, malformed or unknown-enum fields. No dual
  decoder, preview fallback, raw UUID input or role-derived UI matrix is allowed;
- all application tables remain tenant-keyed with `FORCE ROW LEVEL SECURITY`,
  minimum one-role grants and append-only protections for history;
- audit/outbox may contain the required tenant-scoped opaque IDs only in their
  typed identifier columns and approved identifier payload keys, but contain no
  names, contacts, dates of birth, school names, Case numbers or other private
  business values; public errors, logs and QA evidence additionally emit no raw
  UUIDs, request bodies, cookies, tokens, connection details, SQL text or database
  messages.

## 4. Canonical Domain Contract

### 4.1 ServiceCase

`ServiceCase.stage` is exactly:

```text
signed | background_collection | school_selection_confirmed |
application_in_progress | closed
```

New Cases preserve the `signed` fact and atomically finish creation at
`background_collection`; no manual `signed -> background_collection` button is
rendered. `signed` remains readable only for immutable history and a transaction
that has not yet completed.

The operational overlay is exactly:

```text
active | paused | termination_pending | closed
```

Pause retains the milestone. Only the assigned Primary Advisor or Founder may
pause/resume; pause requires trimmed free text of 1-1000 characters. Resume has
no business reason field and records `reason=null`. Pause is
denied once any target is `submitted` or later. Paused Cases cannot normally
advance, create/approve/confirm a list, add/remove a target, change target state or
create an ad-hoc Task. Existing Tasks and deadlines remain unchanged.

`termination_pending` is written only by the whole-service termination command
after every non-terminal target is changed to `withdrawn` and every open Task is
cancelled with history. It is excluded from advancing count and blocks every
normal workflow write. It still requires a separate Founder close command.

`closed` is irreversible. Re-signing is normal Case creation and never reopens or
overwrites an old Case.

### 4.2 Assessment

The immutable approved v1 manifest remains the sole field catalogue: 15 fields,
with blockers and semantic-state rules taken from its approved receipt. No page
may maintain a separate 16-field contract.

- Primary Advisor: read/write assigned Case Assessment;
- active CaseCollaborator: `education_profile:view` reads only the granted scope;
  `education_profile:edit` edits only that scope;
- Founder and Admin: read-only;
- every other principal: denied.

`unknown` and `declined_to_provide` never satisfy blockers. `not_applicable`
satisfies a blocker only when that immutable manifest field explicitly permits it;
the current v1 permits none. `background_complete` enables candidate-list work and
does not cause a Case-stage transition.

The Assessment GET keeps its current exact fields and adds exact
`access:{mode,can_edit,editable_field_ids,can_complete_background}`. `mode` is
`full|education_profile`. A Primary Advisor receives all 15 fields with all field
IDs editable and may complete background blockers. Founder/Admin receive all 15
read-only. An active collaborator with `education_profile:view|edit` receives only
the three `education_profile` schema fields and matching answers; edit exposes only
those three IDs and never grants background completion. Other Advisors are
resource-invisible.

Assessment PATCH keeps exact request
`{field_id,semantic_state,value,value_type,expected_record_version}`. Background
completion keeps exact request `{expected_record_version}`. Both successes become
direct exact non-PII `{id,record_version}` acknowledgements inside the normal API
envelope, followed by mandatory authoritative GET. Their idempotency receipts
store an immutable safe `id:result_version` reference and exact response hash;
replay never reconstructs an acknowledgement from a later mutable answer or
Assessment row.

For PATCH, acknowledgement `id` is the Assessment ID and `record_version` is the
mutated answer's version; request `expected_record_version` is that answer version,
with `0` meaning insert. The authoritative GET must match the same Assessment ID
and the requested field's exact answer version/value semantics before success.
For background completion, acknowledgement `id` is the Assessment ID and
`record_version` is the Assessment aggregate version; its request version is also
the Assessment version, and GET must show `background_complete`. The immutable
receipt reference encodes the acknowledgement pair itself, so later answer or
Assessment mutations cannot change replay.

The strict GET decoder locks the manifest projection, not merely a range:
`mode=full` contains the canonical ordered 15 schema fields; `education_profile`
contains the canonical ordered three education-profile fields. When `can_edit` is
true, `editable_field_ids` exactly equals every visible schema field ID in that
same order; when false it is empty. `can_complete_background=true` is valid only
for full mode with all 15 fields editable. Every visible field descriptor must
match the approved v1 JSON exactly: ID, layer, module ID/version, label, value type,
ordered enum values when present, visibility and ordered blocker stages. Answers
are a canonical ordered subset of those exact IDs. Browser code reuses a small
immutable browser-safe catalogue boundary generated from or importing those same
approved JSON resources; it does not trust counts or maintain a second hand-written
field schema.

Background completion locks the Assessment, approved manifest fields and current
answers. Every required current-v1 blocker must have a manifest-matching answer in
semantic state `provided`; row existence alone is not sufficient. Migration `036`
must replace the existing Assessment write trigger/function so this condition is
also enforced for a direct `tianxing_app` status update. The database derives the
complete blocker set from the Assessment's current approved manifest; a caller
cannot weaken it with an empty or partial field-ID array. Real PostgreSQL boundary
tests prove `unknown`, `declined_to_provide` and `not_applicable` are rejected for
every v1 blocker and that the fully `provided` set succeeds.

### 4.3 Candidate-School List

The existing individual SchoolTarget rows cannot prove approval and Guardian
confirmation of one immutable set, so additive persistence is required:

- `cases_school_selection_versions`: one append-only numbered version per Case;
- `cases_school_selection_entries`: the exact ordered target membership of that
  version, referencing preserved SchoolTargets;
- `cases_school_selection_decisions`: append-only Founder
  `approved|changes_requested` and Guardian `confirmed|changes_requested` facts.

A version is `draft -> founder_review -> guardian_confirmation -> confirmed`, or
`changes_requested`. Only the Primary Advisor edits a draft and submits it. Only
Founder decides Founder review. Only the Primary Advisor records the off-platform
Guardian result for an already Founder-approved same version. Confirmation method
is exactly `phone|wechat|meeting`; confirmation timestamp must not be in the
future; an optional evidence reference must resolve to an authorized Case Document
but is not required.

Changing a confirmed set always creates the next version. Unchanged targets and
Tasks keep their identity. Newly added targets remain `candidate` until the new
version is confirmed. Removed non-terminal targets become `withdrawn` and their
open Tasks are cancelled; terminal targets remain unchanged.

Confirming a non-empty version appends two ordered Case milestone facts in the same
transaction: `background_collection -> school_selection_confirmed`, then after all
new target/Application Assignee/automatic Task facts succeed,
`school_selection_confirmed -> application_in_progress`. The authoritative Case
therefore finishes at `application_in_progress`; the intermediate milestone is
retained in immutable history rather than exposed as a partially committed state.

### 4.4 SchoolTarget And Outcome

SchoolTarget state is exactly:

```text
candidate | preparing | submitted | interview | waitlisted | accepted |
offer_confirmed | offer_declined | rejected | withdrawn
```

Only `offer_confirmed|offer_declined|rejected|withdrawn` are terminal.
`waitlisted` and `accepted` retain an append-only current outcome but cannot satisfy
close eligibility. Guardian offer decisions are recorded by the Primary Advisor
with `confirmed|declined`, `phone|wechat|meeting`, occurred time, actor and optional
Case Document evidence. They append the new outcome revision and move the target
to `offer_confirmed|offer_declined` in one transaction.

Each confirmed target entering `preparing` receives a current Application
Assignee: the Primary Advisor or an active Advisor CaseCollaborator with required
case scope. Assignment changes append history. A Contractor is never an
Application Assignee.

### 4.5 Task

Canonical persisted Task state becomes exactly:

```text
assigned | accepted | completed | cancelled
```

Rejection or reassignment closes the current assignment, appends the reason and a
new assignment, and leaves the same Task in `assigned`. `overdue` is computed from
`due_at` while state is neither completed nor cancelled. There is no Founder
`approved` state or transition.

Task type is exactly `ad_hoc|application_submission|interview_support`.
`application_submission` and `interview_support` require one SchoolTarget and an
immutable automation key. One active Task per target, type and application round
is enforced at the database boundary. Background collection, list decisions,
offer decisions and close create no automatic Task.

Application completion appends a structured completion fact containing submitted
time, channel, submitting actor, checklist-complete state and either a school
reference number or an authorized clean Case Document reference. Interview
completion appends its bounded type-specific record. Evidence does not create a
parallel Material or SubmissionEvidence aggregate.

Contractor access is only the current `interview_support` assignment and its
redacted workspace. It expires immediately on reject, complete, cancel, reassign
or Case close and never grants Assessment, Guardian/contact, internal note,
Document, other target or Case access.

### 4.6 Notification And Count

Release 1 creates in-app notices only. The fixed visible text remains the generic
pending-item copy. Recipient resolution is authoritative at delivery time.

Events are: Task assignment/reassignment to the new assignee; Task rejection to
Primary Advisor; list pending review to Founder; Founder decision and pending
Guardian confirmation to Primary Advisor; all targets terminal and no open Tasks
to Primary Advisor and Founder. Due reminders are at 3 days and 1 day to assignee
and Primary Advisor; overdue is daily to assignee, Primary Advisor and Founder.
Pause does not stop deadlines or reminders. `(recipient,effect,HK-date)` is unique.

`advancing_case_count_v1` counts `background_collection`,
`school_selection_confirmed` and `application_in_progress`, including paused Cases
and all-rejected-not-closed Cases. It excludes transient `signed`,
`termination_pending`, pending-delete and closed. One Case contributes zero or one
at the Hong Kong month-end cutoff; no amount is calculated.

## 5. Capability And Resource Matrix

New coarse capabilities are frozen as follows. They control entry only; repository
scope remains authoritative.

| Capability | Founder | Advisor | Admin | Data Reviewer | Contractor |
| --- | --- | --- | --- | --- | --- |
| existing `cases.read` | allow | allow | deny | deny | deny |
| `cases.workflow.manage` | allow | allow | deny | deny | deny |
| `cases.school_selection.review` | allow | deny | deny | deny | deny |
| `cases.assessments.read` | allow | allow | allow | deny | deny |
| `cases.assessments.manage` | deny | allow | deny | deny | deny |
| existing `tasks.read` | allow | allow | deny | deny | allow, task-only |
| existing `tasks.create` | allow | allow | deny | deny | deny |
| existing `tasks.transition` | allow | allow | deny | deny | allow, assigned task-only |
| existing `documents.download` | allow | allow | deny | deny | deny |

Founder read access does not imply Assessment write; Advisor capability does not
replace current-Primary or collaborator-grant checks. Admin retains the prior
Case-workspace denial and gains only the bounded Assessment read endpoint; this
does not grant Case list/detail navigation, Student, Guardian, Task or Document
read/write access.

## 6. Delivery Slices

### Slice 1 — `CASE-FLOW-01` Case Foundation, Assessment And Pause

Add immutable migration `036` after the current `035`: replace the Case stage
constraint, add the operational overlay and append-only lifecycle facts, replace
the old narrow transition function, and update immutable transition-fact guards.
The existing transition-fact table CHECK is dropped and replaced so Slice 1
accepts only forward `signed -> background_collection` facts; direct insertion of
the legacy reverse fact is rejected without changing historical migration files.
The shared Release 1 ServiceCase transition guard is narrowed to that same enabled
edge; no exported domain/shared guard retains the superseded reversible eight-stage
graph. Platform Billing/count does not reinterpret the new stages in Slice 1 and
remains explicitly fail-closed until the Slice 5 count addendum is implemented.
The schema has no authoritative synthetic/business discriminator, so migration
`036` must fail closed if **any** `cases_service_cases` row already exists. Empty
baselines are migrated before Release 1 synthetic seed. A populated environment
requires a separate reviewed business-data migration; this programme never guesses
an old Case mapping from its stage alone. Migration `008` already enabled the
exact `tianxing_tenant_boundary` policy on this table, but did not force RLS.
Migration `036` must verify and retain that policy, perform the owner-only
full-table existence check before forcing RLS, and then force RLS on the accepted
empty path; the one-role owner remains `NOBYPASSRLS`. A raised populated-data
error rolls the whole transaction back to the pre-`036` state of RLS enabled but
not forced, and blocks release until a separate reviewed business-data migration
is supplied. Real PostgreSQL 17 tests must prove that a Case owned by another
tenant is detected with no GUC and leaves migration ledger/schema unchanged,
while the empty path finishes with RLS enabled and forced.

Because the one-role owner is `NOBYPASSRLS` and every tenant table is forced,
the transition-fact and lifecycle-fact tables each keep an exact tenant-scoped
`FOR SELECT` policy and a separate exact tenant-scoped `FOR INSERT ... WITH
CHECK` policy. They must not receive a `FOR ALL`, `FOR UPDATE` or `FOR DELETE`
policy. Table grants are limited to `SELECT, INSERT`; `UPDATE` and `DELETE`
remain revoked, append-only mutation triggers remain in force, and application
writes remain reachable only through the approved command
repositories/functions. This is the minimum insert path required for
the same-owner `SECURITY DEFINER` functions under `FORCE ROW LEVEL SECURITY`;
it does not relax tenant isolation or make fact updates/deletes legal.

The one-role Case table keeps only the existing `UPDATE(id)` FK-lock grant plus
column-level `UPDATE(stage, workflow_status, record_version, updated_at)` for
the approved stage/workflow functions. No identity, ownership, intake or
application column is writable. The Case write trigger still requires the
matching authorized transition/workflow boundary and exact one-step version
advance, while tenant RLS remains forced.

New Case creation accepts only an active Advisor `primary_role_binding_id`.
Founder may create by selecting an Advisor; an Advisor may select only their own
active Advisor binding. Founder-as-primary is rejected by options, service and
database contract. Migration `036` must replace the legacy
`cases_service_cases_primary_role_check` and the Case actor/binding trigger
boundary so a direct SQL insert or update with `primary_role<>'advisor'` is also
rejected; a repository-only filter is insufficient.
Because migration `036` accepts only an empty Case table, Case list/detail and the
exported domain creation decision also narrow `primaryRole` to exact `advisor`;
`founder` is not retained as a legacy decoder enum or valid internal creation
value.

The Backend HTTP matrix proves Primary Advisor full read/write/complete; Founder
and Admin full read-only with PATCH `403`; collaborator view-only three-field read,
collaborator edit three-field write, outside-scope write/completion `404`; other
Advisor and cross-tenant `404`; Data Reviewer/Contractor coarse `403`. Admin's
known synthetic Assessment direct GET is `200` even though Admin Case list/detail
remain `403`.

Assessment reads remain authorized historical reads for a closed,
termination-pending or pending-delete-linked Case; those states do not grant any
new reader. PATCH requires an active Student and an active workflow Case whose
milestone is `background_collection|school_selection_confirmed|
application_in_progress`. Completion additionally requires milestone
`background_collection`. Paused, termination-pending, closed, transient signed or
pending-delete-linked writes are resource-invisible `404` with zero effects. The
repository order is receipt claim -> locked Case/current Student scope -> locked
Assessment/answer/approved manifest -> effects -> receipt completion, and migration
`036` enforces the same lifecycle write boundary against direct `tianxing_app`
Assessment updates. Historical/pending/paused GETs project
`can_edit=false`, `editable_field_ids=[]` and
`can_complete_background=false`, so the UI never advertises a write that authority
will reject.
Direct Assessment INSERT is allowed only for the normal Case-creation boundary:
an active Student and `signed/active` Case in the same tenant with an approved
manifest. A later or inactive/pending Case cannot acquire a replacement Assessment
through direct SQL.

The existing Case list/detail API already exposes camelCase item keys. Slice 1
preserves that single shape and extends both list and detail items with the three
exact camelCase fields below (list now also includes `recordVersion`):

```json
{
  "stage": "background_collection",
  "workflowStatus": "active",
  "recordVersion": 2,
  "availableWorkflowActions": ["pause"]
}
```

The action array is canonical, server-projected and ordered
`pause,resume,terminate,close`; a client never derives it. Other existing exact
Case item keys remain unchanged and are listed in the slice route contract tests.
In Slice 1 the array can contain only `pause` or `resume`. Future action names
remain reserved and must not be projected until their owning slice is implemented.
For an active Case, `pause` is projected only when no target is `submitted`,
`interview`, `waitlisted`, `accepted`, `offer_confirmed`, `offer_declined` or
`rejected`; `candidate|preparing|withdrawn` do not trigger the Slice 1
current-state guard. A pre-submission target may be withdrawn by a later list
revision and must not permanently block pause. From Slice 3 onward immutable
target transition history, rather than current `withdrawn` alone, proves whether
the target ever reached submission or a later state; post-submission withdrawal
therefore still blocks pause.

An authorized Case list/detail remains a historical read when its Student is
`pending_delete`, but projects no workflow actions. A workflow command locks the
current Student after the Case and requires `student.status=active`; pending-delete
or purged/cross-tenant targets are resource-invisible `404` and add no receipt,
lifecycle fact, audit or outbox effect.

Writes are:

- `POST /api/v1/cases/{caseId}/workflow-actions` exact body
  `{action:"pause|resume",expected_record_version,reason}` where `pause` requires
  a trimmed 1-1000 string and `resume` requires `reason:null`;
- success `200` exact `{id,record_version}` followed by authoritative Case GET;
- Case create changes from the legacy `{case:{...nine fields...}}` success payload
  to direct exact non-PII acknowledgement `{id,record_version}` inside the normal
  API `data` envelope. The creation transaction inserts the
  `signed` Case at version 1, appends the automatic signed-to-background fact and
  finishes at `background_collection/active` version 2; the browser must read that
  exact authoritative version before rendering success.

The create idempotency `result_reference` points to the immutable automatic
signed-to-background transition fact, not the mutable Case row. Replay reconstructs
the first `{id,record_version:2}` and verifies its exact response hash even after
later pause/resume commands.

Slice 1 also corrects the Assessment capability/resource boundary and proves the
approved 15-field blockers. It decommissions the superseded non-versioned
`GET|POST /api/cases` and `GET /api/cases/options` surfaces as well as the write surfaces
`POST /api/v1/cases/{caseId}/transitions`, `POST
/api/v1/cases/{caseId}/school-targets`, SchoolTarget `/transitions` and
`/outcomes`. The non-versioned GET list requires `cases.read`; its POST/options
require `cases.create`. The four v1 legacy workflow/target writes require
`cases.workflow.manage`. After normal session validation, a missing capability
returns `403 FORBIDDEN`, while an
authorized request returns fixed `409 CONFLICT` with zero runtime/business
effects. Error ordering is session `401`, coarse capability `403`, malformed path
UUID `422`, then fixed `409`; the disabled endpoints do not parse a legacy request
body or require an idempotency key. This fixed decommission response does not query the Case or reveal
whether a supplied Case/target UUID exists. Their old create/transition/outcome UI
controls are removed, while existing SchoolTargets remain readable. Their owning
later slices reopen only the newly frozen contracts. The obsolete legacy
server-service exports are removed or made fail-closed when no active caller
remains; no internal caller may retain a second Case create/list/options path.
The one-role owner cannot decommission a legacy PostgreSQL function by revoking
its own `EXECUTE` privilege alone. Migration `036` therefore replaces the
legacy candidate-SchoolTarget function body, preserving its historical
signature only to return a fixed `42501` with zero effects; Slice 2 may reopen
selection only through its newly frozen versioned contract.

Until Slice 2 reopens the versioned selection workflow, the existing SchoolTarget
GET keeps one strict response shape but never advertises the retired writer:
`can_create=false`, `create_blocked_reason="selection_workflow_required"` and
`school_options=[]`. Browser code does not retain an unused legacy create adapter
or idempotency attempt for that fixed-`409` POST surface.

Existing TASK-01 ad-hoc Task creation remains available only while the locked
Case has `workflowStatus=active`. The Task repository must lock the Case and prove
that condition before insert/effects; a paused Case returns `409 CONFLICT` with
zero Task, assignment, receipt, audit or outbox effects. Case detail keeps existing
Tasks readable but hides the ad-hoc create command while paused. Founder may use
the existing `tasks.create` capability on any Case visible to Founder; an Advisor
may create only on the Case for which they are current Primary Advisor. Options
and create enforce the same scope. A completed same-key Task-create replay by the
still-authorized actor returns its original acknowledgement even if the Case was
subsequently paused; the active-workflow guard applies only to a newly claimed
command. Slice 1 does not
create lists, new target transitions, automatic Tasks, notifications, termination
or close commands.

### Slice 2 — `CASE-FLOW-02` Versioned Selection And Confirmation

Add the three append-only selection tables, exact bounded read DTO and commands for
draft creation/change, submit, Founder decision and Advisor-recorded Guardian
confirmation. Confirmation atomically changes the Case milestone to
`school_selection_confirmed`, then promotes added targets to `preparing`, installs
Application Assignee history, creates exactly one application Task per added target
and finishes the Case at `application_in_progress` with both milestone facts.

Slice 2 prerequisites therefore include the minimum complete Task persistence
needed for safe creation: `task_type`, SchoolTarget/application-round ownership,
immutable automation key, one-active-auto-Task uniqueness, Application Assignee
history, the canonical four-state policy storage, and an architecture-reviewed
Cases-to-Tasks transaction port. It may create an `assigned` automatic Task but
does not yet expose transitions. A detailed exact route/DTO addendum must be
appended to this plan and pass architecture review before Slice 2 product edits.

### Slice 3 — `CASE-FLOW-03` Target Progress, Submission And Offer

Extend SchoolTarget/outcome vocabularies and Task completion facts. Reopen only the
new target transition/outcome contracts. Implement the minimum
`application_submission` Task `assigned -> accepted -> completed` route/policy,
submission evidence, optional interview branch, Guardian offer decision, corrected
terminal logic and authoritative target history. The Case milestone is already
`application_in_progress` from Slice 2 and is not advanced again. Exact route/DTO
addendum and Document authorization seam are mandatory before edits.

### Slice 4 — `CASE-FLOW-04` Task Policy, Contractor Workspace And Notices

Complete the adopted Task lifecycle around the Slice 2/3 foundation; migrate only
synthetic/empty data, never reinterpret business history. Implement same-Task
reject/reassign/cancel, computed overdue, interview-support completion,
automatic-task idempotency, redacted interview workspace, recipient resolution and
exact in-app effects/cadence. Existing TASK-01 ad-hoc creation remains but cannot
progress Case or Target. Exact Task/notification DTO and worker schedule addendum
is mandatory before edits.

### Slice 5 — `CASE-FLOW-05` List Change, Termination, Close And Count

Implement confirmed-list replacement reconciliation, whole-service termination,
Founder manual close with `success|no_offer|service_terminated` result and required
reason, all-target/no-open-Task eligibility, advancing count projection and the
integrated customer journey. Termination, close and count snapshots are immutable
and idempotent. Exact close/count DTO addendum is mandatory before edits.

Slices are strictly ordered. A later slice may prepare static code but cannot run
its formal browser gate until every preceding Backend HTTP/DTO/baseline gate and
architecture compatibility review passes.

## 7. Error And Transaction Contract

Public errors remain fixed: invalid session `401`; coarse capability denial `403`;
missing/cross-tenant/out-of-scope/pending-delete resource `404`; command validation
`422`; stale `409 STALE_VERSION`; illegal state/idempotency conflict `409 CONFLICT`;
runtime/database unavailable `503`; unknown error redacted `500`.

Assessment stale responses may expose the safe current numeric record version but
omit `diff_token` when it would embed an Assessment/answer UUID. Recovery always
uses the mandatory authorized GET; no public error detail needs a reversible
resource identifier.

Known errors use `Error.name` plus allowlisted code rather than constructor identity
alone so Next Dev/HMR cannot turn a stable denial into `500`. No database message,
detail, SQLSTATE, stack or query enters a response. Permanent test observability may
emit only fixed stage names and allowlisted safe booleans/counts/status/code.

Multi-aggregate commands — list confirmation, submission completion, offer
decision, termination and close — execute in the Cases-owning transaction and use
Tasks/Documents/Notifications only through approved server boundaries or an
architecture-reviewed transaction port. Cross-module internal imports and nested
independent commits are forbidden.

Lock order is fixed as idempotency receipt claim/lock -> Case -> SchoolTarget and
current transition history -> Task and assignment -> document evidence -> append
audit/outbox -> complete receipt. Claiming the receipt is not resource
authorization; current membership, capability and resource scope are rechecked
after taking the owning aggregate locks, and a denial rolls the claim back with the
transaction. A completed replay follows the same current reauthorization and
owning-resource lock path before returning its immutable acknowledgement; role or
membership revocation denies replay with zero effects. Pause locks the Case and then all current targets before checking the
no-submission guard. Every target
transition introduced in Slice 3 must take the same Case lock first and append an
immutable target transition fact. From Slice 3 onward pause proves “ever submitted
or later” from that history. Until then Slice 1 keeps every legacy Case/target/
outcome transition POST fail-closed and no production target-transition writer is
enabled. The legacy individual SchoolTarget create POST is fail-closed as well.
Ad-hoc Task creation uses the same Case-first lock boundary and rejects a paused
Case before any Task-family effect; existing Task reads and deadlines remain
unchanged. Every architecture-reviewed cross-module transaction port receives the
same already-open tenant transaction and must not open an internal
`database.transaction`/runner transaction.

## 8. Owner Workflow And Gates

For every slice:

1. Architect appends/freezes the exact slice contract and files/owners.
2. Backend owns Access, application/domain, PostgreSQL/runtime/routes, additive
   migration/baseline/seed, focused tests and one permanent real PG17 HTTP gate.
3. Frontend owns strict clients, capability-only UI, accessibility/responsive
   behavior, focused tests and one permanent Local Dev browser gate. Its formal
   browser command waits for Backend HTTP/DTO/baseline pass.
4. Independent QA modifies no product or test code. After both owners pass, QA
   runs the existing architect-approved permanent Local Dev command once and
   reports redacted `passed/failed/not_run` evidence. Failure stops without retry.
5. Architect audits shared DTOs, permissions, transactions, privacy, migration
   drift, temporary-resource cleanup and all unverified claims.
6. With owner and QA gates green, Architect may commit, push, open/update the PR,
   wait for checks and merge under the user's standing Git/PR/merge authorization.

Static gates are Node 22 TypeScript, targeted ESLint, focused unit/contract/
migration tests, architecture 15/15, deterministic baseline check and
`git diff --check`. Full lint, production build, full suite, cloud tests and remote
deployment are not programme gates unless separately authorized; if not run, they
remain explicitly unverified.

## 9. Stop Conditions

Stop and return to architecture if any slice requires rewriting historical SQL,
inventing legacy business values, weakening RLS/permissions, accepting a second
DTO shape, emitting PII/private content, making Guardian/Portal writable, turning
a close prerequisite into auto-close, rebuilding unchanged target/task identity,
adding an unapproved automatic Task, or making a remote-runtime claim from Local
Dev evidence.

Current completion claim after this plan is only:

```text
Business semantics: confirmed
Implementation delta: frozen and sequenced
CASE-FLOW-01..05 product acceptance: not_run (unverified)
Vercel Test: not_run (unverified)
AWS Production: not_run (unverified)
```
