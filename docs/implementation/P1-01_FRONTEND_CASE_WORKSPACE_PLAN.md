# P1-01 Frontend Case Workspace Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-04 (Asia/Hong_Kong) |
| Status | `implemented_ui_runtime_adapter`: Case-first UI and repository-side Cognito/Neon seams are in place; cloud configuration, migrations, and supporting resource modules remain gated |
| Primary users | Founder/Admin and Advisor |
| Reference | next-forge app shell, package boundaries, opinionated and safe defaults |

## Problem And Outcome

Release 1 has identity, CRM, CaseWorkflow, school, task, document, and audit
contracts, but the current ERP exposes only crawler, student mock, and school
pages. The frontend needs one operational workspace where a Founder/Admin or
Advisor can find a Student, create a valid K12 ServiceCase, and work through
assessment, school targets, tasks, documents, and audit history.

The first vertical slice is Case-first with Student 360 context. The UI must
make the domain rules visible without pretending that a mock interaction is a
durable database write.

## Stakeholders And Roles

- Founder/Admin: organization administration, user invitations, all permitted
  case operations, sensitive approvals, and review queues.
- Advisor: assigned-case work, assessment, school targets, tasks, documents,
  and ordinary case notes within granted scope.
- Data Reviewer: school overlay and evidence review surfaces when the role is
  present.
- Engineering/Operations: explicit adapter and deployment gates; no secrets or
  real data in UI fixtures.

## Scope

In scope for this UI slice:

1. Invite-only login entry and session-expired/error states as a Cognito adapter
   boundary. No local password fallback or fake production session.
2. Protected app-shell design with a role-aware navigation and a `Today`
   worklist.
3. Student list and Student 360 context with a clear separation between Student
   identity and ServiceCase identity.
4. Case list, case detail workspace, and a new-case wizard that starts from an
   existing active Student.
5. Assessment semantic states, school-target status/outcome, task/document
   entry points, and audit timeline placeholders tied to P0 contracts.
6. Typed client seams and empty/loading/error/denied/stale states so real APIs
   can replace the preview adapter without changing the page contract.

Out of scope for this slice:

- Cognito resource creation, provider callback exchange, secret configuration,
  or production session issuance.
- Neon migration execution, RLS activation, or production data
  synchronization.
- Direct stage transitions, outcome corrections, document activation, or school
  overlay approvals without their owning P1 service and receipt contracts.
- Replacing this repository with a next-forge Turborepo. We borrow its app
  boundary and component-workshop ideas while keeping the existing Next app,
  Neon integration, and crawler handoff.

## Business Rules And UI Invariants

- Only active Students can be selected for a new case.
- A new case is K12 only and requires an active Founder/Advisor primary role in
  the same organization.
- The UI must prevent a duplicate non-closed case for the same organization,
  Student, intake year, and admission type, while still handling a server `409`
  if a concurrent request wins.
- A case requires an approved assessment manifest; no manifest means a visible
  blocked state, not an invented form schema.
- Assessment answers expose exactly `provided`, `unknown`,
  `not_applicable`, or `declined_to_provide`; empty strings are not substituted
  for semantic state.
- Advisor visibility is assignment/grant scoped. Founder/Admin sees the
  organization-level controls allowed by the access contract.
- No route or mutation is considered protected until the server-side session
  adapter and owning-module authorization check are active.

## Information Architecture

```text
/login
  /today
  /students
  /students/[id]
  /cases
  /cases/new
  /cases/[id]
    /assessment
    /schools
    /tasks
    /documents
    /activity
  /admin/access
  /admin/schools
```

The app shell uses a dense left navigation, a compact top bar with global
search and current-user menu, breadcrumbs on detail pages, table-first lists,
drawers for short edits, and full pages for workflows that have blockers or
approval receipts.

## Case Creation Flow

```text
Existing Student
  -> Case identity (K12, intake year, admission type)
  -> Primary Founder/Advisor
  -> Approved manifest
  -> Review duplicate/blocker warnings
  -> Submit through the typed cases command
  -> Case workspace
```

The wizard does not create a Student inline. A missing Student links to the
Student creation flow so the two UUID identities remain separate.

## API And Adapter Boundaries

- `auth`: Cognito proves identity; the Hong Kong runtime owns opaque sessions
  and authorization. The browser receives no provider token as an application
  authorization decision.
- `cases`: page loaders read a minimal case DTO; the create command accepts the
  typed P0 creation payload and maps stable denials to `401`, `403`, `409`, or
  `422` without exposing SQL errors.
- `students`: the Student selector reads active organization-scoped records;
  it never accepts a free-form Student identity for case creation.
- `case workspace`: assessment, targets, tasks, documents, and activity are
  separate resource panels. Each panel owns its loading, stale-version, and
  permission-denied state.

The Case list, new-case wizard, and case detail read now use the repository
runtime adapter and must not fall back to synthetic data when Neon or the
session is unavailable. Remaining legacy surfaces may still use clearly marked
preview fixtures until their owning APIs are implemented.

## Acceptance Criteria

1. Unauthenticated access has a login entry and never renders protected case
   data once the server session adapter is enabled.
2. Founder/Admin and Advisor navigation differs only by server-confirmed
   capability; hiding a link is not the authorization control.
3. `/cases/new` cannot submit without an existing active Student, K12 identity,
   primary role, and approved manifest.
4. Duplicate-case `409`, stale-write `409`, permission `403`, expired session
   `401`, validation `422`, loading, empty, and network-error states are
   visible and actionable.
5. Student 360 links to its cases without treating a case as a Student field.
6. Desktop and mobile layouts preserve table readability, stable controls,
   keyboard focus, and non-overlapping error/help text.
7. Focused type checks and UI/browser checks are recorded; `pnpm lint` and
   `pnpm build` remain subject to the repository approval rule.

## Risks And Gates

- Cognito configuration and callback URLs are external inputs. Missing or
  mismatched configuration is `blocked`, not a reason to add local passwords.
- P0 migrations have not authorized production Neon execution. The UI cannot
  silently create tables or downgrade to local JSON for authoritative case
  data.
- Existing Student mock data has a legacy study-abroad assessment shape. It is
  displayed as legacy context and cannot be used as the P0 four-layer manifest
  without an explicit mapping decision.
- A next-forge migration would change dependency, workspace, deployment, and
  auth boundaries. It is deferred unless a measured limitation in the current
  Next app justifies that expansion.

## Release Boundary

This plan authorizes repository-side frontend/auth/data adapter work and the
user-approved commit/push release boundary. It does not authorize Cognito
resource changes, Neon writes/migrations, snapshot sync, or Vercel
configuration changes.

## Implementation Evidence

The approved frontend slice now includes:

- `/login`, `/today`, `/cases`, `/cases/new`, and `/cases/[id]` for the Case-first
  daily workflow.
- Student list and Student 360 entry points that carry an existing Student into
  the case wizard without merging Student and Case identity.
- Read-only `/tasks`, `/documents`, and `/admin/access` surfaces, using the same
  synthetic Case fixture and clearly labelled adapter states.
- A typed `previewCaseWorkspaceAdapter` read boundary so the page contract does
  not depend directly on the fixture source.
- A responsive app shell, icon rail at mobile widths, desktop table views,
  stage timeline, semantic assessment status, blocker banners, and disabled
  mutation controls where backend receipts are not yet available.
- A server-only Cognito authorization-code + PKCE adapter, JWT/JWKS checks,
  invite-only identity reconciliation, opaque Neon-backed sessions, and
  role-scoped guards for existing mutable API routes.
- Neon-backed `/api/cases` list/options/create paths. Case creation rechecks the
  active Student, primary Founder/Advisor binding, approved manifest, and
  duplicate constraint inside one transaction.

Verification recorded for this slice:

- `pnpm test:p0-12`: 4 passed.
- `pnpm test:identity-access-schema`: 4 passed, 1 skipped because
  `TEST_DATABASE_URL` is not configured.
- `pnpm test:migration`: 10 passed.
- `pnpm test:auth`: 4 passed, including configuration, PKCE, encrypted token,
  JWT signature/claims, and future-`iat` rejection checks.
- Combined contract, architecture, migration, release-harness, and auth suite:
  37 passed.
- Focused Bun server/browser bundle checks passed for auth routes, case routes,
  legacy guards, and the case UI.
- A prior focused `git diff --check` passed; the final staged diff check exceeded
  the bounded filesystem timeout and was not completed.
- Full and scoped TypeScript checks did not return within bounded timeouts, and
  the local Next dev server did not bind to the requested port after the local
  dependency install became incomplete; browser visual evidence is therefore
  still pending.
- `pnpm lint` and `pnpm build` were not run because the repository instruction
  requires explicit user authorization for those commands.
