# P1-05 Atomic Student And K12 Case Creation

| Control | Value |
| --- | --- |
| Ticket | `P1-05` Advisor atomically creates Student + K12 Case + Primary Advisor |
| Date | 2026-08-06 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapter` |
| Decision inputs | `DEC-003`, `DEC-004`, `DEC-008`, `DEC-032`, `DEC-040` |
| External state | No RDS write, migration execution, Cognito call, worker schedule, deployment, commit, or push action performed |

## Scope And Boundary

This ticket implements the F03 command seam for a newly captured Student and
the first K12 ServiceCase. It creates the Student, the `signed` K12 case, its
assessment reference, the Primary Advisor assignment, redacted audit event,
and outbox effect through one repository operation.

It does not create an identity User or an access role binding. The current
authenticated Advisor becomes the Primary Advisor only when their pre-existing
active Advisor role binding passes the repository's transaction-local check.
Identity/access owns that binding and the database's composite FK preserves
the boundary. It also does not infer a Student identity from profile fields or
merge records automatically.

The public route is `POST /api/v1/cases`. It accepts a caller-supplied opaque
`case_number` because no business numbering rule is approved. It requires an
approved manifest ID and an `Idempotency-Key`; the session determines the
actor and organization, never the request body.

## Invariants And Enforcement

| Invariant | Enforcement owner |
| --- | --- |
| Release 1 can create only K12 cases in `signed` stage | `CaseService` command shape; `cases_service_cases` checks |
| A primary Advisor is an authenticated Advisor with an active binding in the same organization | transaction-local repository lookup; composite binding FK |
| Student, ServiceCase, Assessment, audit, outbox, and idempotency result are all committed or none are | `CaseCreationRepository.createStudentAndK12Case` one-transaction contract |
| Same actor/org/operation/key with same request returns the original result; altered payload is rejected | idempotency request hash and `shared_idempotency_records` scope key |
| A Student cannot have two active same-year/same-route cases | `cases_service_cases_one_active_student_case_idx` partial unique index |
| Student profile fields are not written into audit/outbox payloads | `buildAuditEvent`, `buildOutboxMessage`, and audit metadata allowlist |

The production RDS adapter must perform the Advisor binding lookup, manifest
approval lookup, idempotency evaluation, all inserts, and effect writes inside
one transaction. The test adapter proves the port contract only; it is not a
runtime storage fallback.

## Failure Contract

- Missing/invalid command: `VALIDATION_FAILED`.
- Missing session: `UNAUTHENTICATED`; non-Advisor session: `FORBIDDEN`.
- Reused idempotency key, in-progress command, or active-case uniqueness
  conflict: `CONFLICT`.
- Inactive Advisor binding or unapproved manifest: `VALIDATION_FAILED` with
  no row or effect created.
- No configured HK Case runtime: `SERVICE_UNAVAILABLE`; the API has no local
  JSON, Neon, or mock write fallback.

## Deterministic Evidence

`tests/integration/case-creation-workflow.test.ts` passes 5/5 focused tests:

1. Advisor creates Student, signed case, assessment, audit, and outbox.
2. Exact idempotency replay returns the first result without another effect.
3. Altered key reuse and a second active case for the same Student are denied.
4. Inactive Advisor binding, unapproved manifest, and non-Advisor actor are denied.
5. A simulated pre-commit failure leaves every durable fact count at zero.

`node --check` passed for the four new runtime/module/route files. A TypeScript
check was invoked without diagnostics. `pnpm lint` and `pnpm build` were not
run because the repository instructions prohibit them without separate
explicit authorization.

## External Execution Gate

Before making this command usable against an RDS environment, the migration,
data, security, and operations owners must approve the exact RDS repository
implementation, transaction/isolation and duplicate-key mapping, RLS and
cross-tenant negative tests, app-role permissions, timeout/retry limits, and
the environment-specific runtime composition payload. No document or local
test authorizes an RDS data write, migration run, deployment, or real client
case creation.
