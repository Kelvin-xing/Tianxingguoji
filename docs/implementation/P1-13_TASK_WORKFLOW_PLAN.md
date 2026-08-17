# P1-13 Task Workflow

| Control | Value |
| --- | --- |
| Ticket | `P1-13` Assignee advances Task through completion and separate approval |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | User-approved `OD-06` matrix; `DEC-008`, `DEC-028`, `DEC-041`, `DEC-044` |
| External state | No RDS write, migration execution, Cognito call, worker schedule, deployment, commit, or push action performed |

## Resolved OD-06 Matrix

The user supplied the following binding Release 1 decision on 2026-08-07.
`assigned` is the only initial Task state. No policy with another initial state
or a different rule set can be approved by `approveTaskTransitionPolicy`.

| From | To | Authorized actor | Reason | Other guard |
| --- | --- | --- | --- | --- |
| `assigned` | `accepted` | Current Assignee | No | Current assignment and version match |
| `assigned` | `rejected` | Current Assignee | Required | Current assignment and version match |
| `accepted` | `completed` | Current Assignee | Required | Current assignment and version match |
| `assigned` or `accepted` | `reassigned` | Current Primary Advisor | Required | A valid next Assignee is required |
| `assigned` or `accepted` | `cancelled` | Current Primary Advisor | Required | Current Primary Advisor relation and version match |
| `completed` | `approved` | Founder, distinct from current Assignee | Required | Completion must already be durable |

All other states, source/target pairs, roles, and actor relationships deny.
`completed` and `approved` are permanently different states. The `reassigned`
state records the completed handoff of this Task and appends the new assignment;
it has no unapproved follow-on transition in Release 1.

Founder is permitted in the Primary Advisor rows only when the case's current
Primary Advisor relation names that Founder, preserving `DEC-008` temporary
Founder cover without treating every Founder as a Primary Advisor.

## Ownership And Enforcement

`modules/tasks/domain/release1-policy.ts` owns the immutable Release 1 policy shape.
`modules/tasks/domain/transition-policy.ts` permits a candidate to become approved
only when it carries an `OD-06: resolved` receipt and exactly that policy.

`TaskWorkflowService.transitionTask` creates a new receipt ID and constructs
the redacted audit/outbox effect bundle. It accepts an expected version and an
idempotency key. The raw transition reason participates only in the
idempotency request hash and authoritative transition receipt; it is never put
in audit or outbox metadata.

The `TaskTransitionRepository` is the one transaction boundary. A production
HK RDS adapter must lock and re-read the Task, active policy, current
assignment, current case Primary Advisor, active actor role, reassign target,
and idempotency record before it writes the Task update, immutable receipt,
assignment history, audit event, outbox event, and idempotency result. It must
re-evaluate the exact matrix after those reads; a cached or UI-supplied
Primary Advisor is not authority.

`owner` in the P0-09 policy representation is only the transaction-local
projection of the current Primary Advisor. The production adapter must verify
the underlying `ServiceCase.primary_advisor` binding in the same transaction.
That keeps the existing P0-09 contract compatible without inventing another
business role.

`app/api/v1/tasks/:taskId/transitions` is a thin BFF adapter. It requires the
opaque session and invokes Identity with `sensitiveAction: true`, which applies
the existing five-minute TOTP freshness policy. It uses the P0-03 versioned
envelope and maps stale versions to `409 STALE_VERSION`, malformed framing to
`400 INVALID_REQUEST`, policy failures to `503 SERVICE_UNAVAILABLE`, and
authorization denials without internal state disclosure.

`modules/tasks/infrastructure/runtime.ts` has no local, JSON, mock, Neon, or cloud fallback.
Without a configured approved RDS transaction adapter, all task transition
routes fail closed with `503 SERVICE_UNAVAILABLE`.

## Error Contract

| Internal condition | Public result |
| --- | --- |
| Invalid task ID, command, key, target, or required reason | `400 INVALID_REQUEST` or `422 VALIDATION_FAILED` |
| Missing/invalid/freshness-failed session | `401 UNAUTHENTICATED` |
| Non-assignee, non-Primary Advisor, non-Founder approver, or self-approval | `403 FORBIDDEN` |
| Hidden/nonexistent task | `404 NOT_FOUND` |
| Unsupported state transition or idempotency conflict | `409 CONFLICT` |
| Stale expected version | `409 STALE_VERSION` |
| Missing/mismatched task runtime policy or RDS composition | `503 SERVICE_UNAVAILABLE` |

## Local UI Boundary

`components/tasks/TaskTransitionControls.tsx` is a small client control for a
task detail surface. It offers only transitions legal from the Task's current
state, collects the reason and reassign target when needed, sends the expected
version and a fresh idempotency key, and updates its local version/state after
the API succeeds. The server remains authoritative; the component makes no
role or Primary Advisor determination. P1-16 owns integration into the full
case workspace and its browser accessibility journey.

## Deterministic Evidence

`node --test tests/unit/tasks/transitions.test.ts tests/integration/task-workflow.test.ts`
passes `15/15` tests. The focused suite covers:

1. Assigned initial state, assignee accept/reject, reason-required completion, and redacted effects.
2. Primary Advisor-only reassign/cancel with a valid next assignee and immutable assignment history.
3. Founder-only, distinct-actor approval after completed with a required reason.
4. Stale version, unsupported actor/transition, and missing reassign target denials with no effect.
5. Idempotent replay and a pre-commit failure with no receipt, audit, outbox, assignment, or idempotency partial fact.
6. Rejection of every policy shape except the resolved Release 1 matrix.

`./node_modules/.bin/tsc --noEmit --pretty false` passed with no diagnostics.
`pnpm lint` and `pnpm build` were not run because `erp-frontend/AGENTS.md`
forbids them without separate explicit authorization.

## External Execution Gate

Before this route can process a real task, the data, security, and operations
owners must approve and install the RDS adapter that implements the one
transaction port, RLS/cross-organization negative cases, Primary Advisor lock
order, idempotency retention, task assignment target validation, audit/outbox
permissions, and timeout/retry behavior. No local source or test authorizes a
migration run, RDS write, Cognito action, deployment, or live task transition.
