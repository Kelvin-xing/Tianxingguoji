# TASK-01 Case Task Workflow

| Control | Frozen value |
| --- | --- |
| Ticket | `TASK-01` authoritative Case-linked Task create, read, assign and transition workflow |
| Date | 2026-08-23 (Asia/Singapore) |
| Acceptance | Local-only: disposable PostgreSQL 17, current one-role baseline, Release 1 synthetic seed, isolated Next Dev and system Chrome |
| Remote state | Vercel, Neon and AWS are outside this ticket and remain unverified |

## Outcome And Boundary

TASK-01 replaces the `/tasks` preview adapter and completes the existing P0-09/P1-13
Task state machine. It does not invent another Task aggregate. The authoritative
records remain `tasks_tasks`, append-only `tasks_task_assignments`, and append-only
`tasks_task_transition_receipts` under the approved OD-06 Release 1 matrix.

In scope:

- authoritative internal and assigned-Contractor Task list/detail reads;
- Case-scoped Task creation and initial assignment;
- existing assignee, current Primary Advisor, and separate Founder transitions;
  automatic application-submission Tasks may be assigned to an Advisor or
  Contractor, while Founder remains outside the assignee list;
- a Case detail Task panel, `/tasks`, and `/tasks/{taskId}`;
- strict client DTOs, idempotent writes, authoritative refresh and stale recovery;
- additive schema completion, local Release 1 policy fixture, real PostgreSQL HTTP
  evidence, and real browser evidence.

Out of scope: comments, reminders, recurring Tasks, attachments, notification
delivery, bulk commands, deletion, arbitrary Task editing, cloud execution, and
changes to the OD-06 transition matrix. Contractor access remains task-only and
must not disclose Case, Student, Guardian, contact, assessment, note, document, or
internal identity data.

## Access Contract

Three capabilities are authoritative. UI code may only use the Access snapshot and
server-projected actions; it must never infer permissions from a role string.

| Capability | Founder | Advisor | Contractor | Admin | Data Reviewer |
| --- | --- | --- | --- | --- | --- |
| `tasks.read` | allow | allow | allow | deny | deny |
| `tasks.create` | allow | allow | deny | deny | deny |
| `tasks.transition` | allow | allow | allow | deny | deny |

Capabilities are coarse entry permissions. The Task repository reauthorizes the
resource relationship in the same transaction:

- Founder may read all organization Tasks. Advisor may read a Task only when they
  are the current assignee or the Case's current Primary Advisor.
- Contractor may read only the current Task assignment with
  `redaction_profile=task_only`; its projection has no Case identifier.
- Create requires the actor to be the Case's current Primary Advisor. A Founder is
  allowed only when the Case binding actually names that Founder.
- Transition authority is exactly OD-06: current assignee accepts/rejects/completes;
  current Primary Advisor reassigns/cancels; a Founder distinct from the assignee
  approves a completed Task.
- Missing, inactive, cross-tenant, pending-delete Case, stale assignment, revoked
  role, and invisible resource conditions fail closed.

## Data Contract

Additive migration `033` may complete `tasks_tasks` with immutable, required
`task_brief` (1-4000 trimmed characters) and `due_at` (ISO instant) fields. Because
no approved runtime could previously create real Tasks, the migration must fail
closed if it encounters a legacy Task that cannot be migrated without inventing
business content. Historical migrations are immutable. Regenerate the one-role
baseline only with repository tooling.

The Release 1 synthetic seed installs one approved OD-06 policy per synthetic
organization using distinct synthetic requester/reviewer principals and the exact
matrix in `modules/tasks/domain/release1-policy.ts`. It must be deterministic and
must reject a different existing policy rather than overwrite it.

Task creation writes, in one tenant transaction:

1. idempotency claim and actor reauthorization;
2. active, non-pending Case and current Primary Advisor lock;
3. approved exact OD-06 policy lock;
4. active Advisor/Contractor assignee validation;
5. `tasks_tasks` in initial state `assigned` and one immutable assignment fact;
6. PII-free audit/outbox effects and completed idempotency receipt;
7. one commit, or no durable effects.

Task transition keeps the existing P1-13 transaction boundary and adds a real
PostgreSQL adapter. It locks the receipt, Task, Case/Primary Advisor, current
assignment, target assignee when applicable, approved policy and actor binding,
then appends the transition receipt/assignment fact, updates the Task, appends
PII-free audit/outbox, completes idempotency, and commits once. Exact replay returns
the first acknowledgement; a changed payload with the same key returns conflict.

## HTTP And DTO Contract

All responses use the existing versioned API envelope. Unknown or extra DTO keys
fail closed in clients and contract tests.

### Reads

- `GET /api/v1/tasks?case_id={uuid?}` returns exact
  `{audience, tasks}`. `audience` is `case_workspace` or `assigned_task`.
- A `case_workspace` item has exact keys
  `{id,case_id,case_number,title,task_brief,due_at,state,assignee,record_version,updated_at,available_transitions}`.
- An `assigned_task` item has exact keys
  `{id,title,task_brief,due_at,state,record_version,updated_at,available_transitions}`
  and never contains Case or assignee data.
- `assignee` is exact `{id,role,label}` with role `advisor|contractor` and a safe
  organization display label.
- An available transition is exact `{to,requires_reason,requires_assignee}` and is
  computed from current server authority, not only from the state matrix.
- `GET /api/v1/tasks/{taskId}` returns exact `{audience,task}` with the matching
  item shape.
- `GET /api/v1/tasks/options?case_id={uuid}` returns exact `{assignees}` where each
  item is `{id,role,label}`. It is bounded to 100, canonical role/label/id order,
  excludes inactive principals, and is unavailable to Contractors.

### Writes

- `POST /api/v1/tasks` request is exact
  `{case_id,title,task_brief,due_at,assignee_user_id}` plus `Idempotency-Key`.
- `POST /api/v1/tasks/{taskId}/transitions` request is exact
  `{to,expected_record_version,reason,next_assignee_user_id}` plus
  `Idempotency-Key`. `next_assignee_user_id` is required only for `reassigned` and
  otherwise must be `null`; reason requirements remain OD-06.
- Both success bodies are exact non-PII acknowledgements `{id,record_version}`.
  The browser must follow every success with authoritative GET before claiming or
  rendering the new state.
- Same semantic attempt, including an uncertain network retry, reuses one key.
  Changing any command field or expected version rotates it. Synchronous duplicate
  clicks produce one request.

Public errors are fixed: unauthenticated `401`; capability denial `403`; hidden,
cross-tenant, invalid-scope, ended/pending Case or Task `404`; validation `422`;
stale version `409 STALE_VERSION`; unsupported transition or idempotency conflict
`409 CONFLICT`; unavailable policy/database/runtime `503`. Error mapping uses
`Error.name` plus allowlisted codes so Next Dev/HMR constructor identity cannot
turn a known denial into `500`.

## UI Contract

- `/tasks` is the first operational surface, with an unframed responsive list,
  bounded state filters, explicit empty/denied/unavailable states, and links to
  `/tasks/{taskId}`. The preview adapter and preview notice are removed.
- `/tasks/{taskId}` displays the authoritative Task. Internal users may follow the
  Case link; Contractor projection has no Case link or surrounding Case data.
- The Case detail page embeds `CaseTasksPanel`, which reads only that Case's Tasks.
  `tasks.create` exposes a compact create form using bounded assignee options; no
  raw UUID entry is permitted.
- Transition controls use the server's `available_transitions`. Reassignment uses
  the options endpoint, never a raw ID input. Required confirmation/reason fields
  are explicit, keyboard accessible, and preserve focus on cancel/success/error.
- All loading, validation, stale, conflict and unavailable states are truthful.
  No role-based UI matrix, optimistic authoritative state, fabricated history, or
  raw server error is allowed.
- Desktop and mobile checks require zero horizontal overflow, out-of-bounds
  controls, overlapping controls and clipped text.

## Permanent Local Gates

Backend HTTP gate uses disposable PostgreSQL 17, current generated one-role
baseline, Release 1 seed, provisioned synthetic principals, isolated Next Dev and
safe allowlisted evidence. It must prove:

- strict DTO/query validation, capability matrix and cross-tenant invisibility;
- Founder/Advisor reads, current-Primary-Advisor create, Advisor and Contractor
  assignee transitions, Primary Advisor reassign/cancel, and distinct-Founder
  approval;
- unassigned Advisor, ordinary Founder, Admin and Data Reviewer direct denials;
- exact acknowledgement, authoritative reads, exact replay, changed-key conflict,
  stale version, concurrent write, injected rollback and immutable history;
- exact Task/assignment/transition/idempotency/audit/outbox deltas, FORCE RLS,
  one-role safety, no private matches and complete cleanup.

Frontend browser gate uses the same disposable stack plus system Chrome. It must
prove capability-filtered navigation and commands, validation with zero POST,
idempotency lifecycle, create/list/detail/refresh/relogin persistence, the legal
transition journey, stale recovery, direct role denials, Contractor redaction,
keyboard/focus, desktop/mobile layout, zero page errors, zero sensitive log
matches, and cleanup of every temporary resource.

Static gates are Node 22 TypeScript, targeted ESLint, focused unit/contract/
migration tests, architecture boundaries, deterministic baseline check, and
`git diff --check`. Full `pnpm lint`, production build, cloud tests, deployments,
and the full suite are not TASK-01 gates.
