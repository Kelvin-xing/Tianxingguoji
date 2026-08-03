# P0-07 Case And Assessment Migration Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_database_evidence`: v0.1 payload implemented; PostgreSQL runtime gate remains unverified because the bounded Colima attempt became `Broken` |
| Candidate migration | `db/migrations/202608021830_003_expand_cases.sql` |
| Migration SHA-256 | `9bc3064eb8bbc82613b11a7627754b074eb5a13c905d4fdc1e5319039f9774b6` |
| Runtime side effects | None |

## Problem And Stakeholder Outcome

Create the minimum authoritative CaseWorkflow foundation for Release 1 so a K12 ServiceCase can pin an immutable four-layer assessment manifest, preserve semantically explicit answers, track independent SchoolTargets, and require an authoritative CaseOutcome for every terminal target fact. Founder, Advisors, data owners, and later API/UI implementers need one structural contract that fails closed instead of copying the demo assessment or inventing non-K12 behavior.

Out of scope: production K12 field catalogues, real school or crawler data, School/overlay tables, route-specific DDL/material/evidence rules, ServiceGoalOutcome, case collaboration services, task/document/audit/outbox tables, routes/UI, live state-transition commands, case purge, real CustomerOrganization or EndClient data, database-role/RLS activation, staging/production migration, commit, push, cloud, or deployment. `OD-09` remains the Phase 2 production catalogue gate and `OD-05` remains the route-policy gate.

## Business Rules And Identity Invariants

- `Student` and `ServiceCase` remain separate UUID identities. One Student may have multiple historical cases, but at most one non-closed case exists for the same organization, Student, intake year, and admission type.
- Release 1 case creation is K12 only. The structural registry may name future application types, but the public contract and ServiceCase constraint reject every non-K12 creation request.
- `case_number` is human-readable and unique within an organization; it is not the database identity.
- Every ServiceCase references one active Student and one active Founder/Advisor role binding in the same organization at creation. The initial primary role binding is immutable in P0-07; historical advisor transfer is a later additive contract and cannot silently overwrite this field.
- The eight approved ServiceCase stage values are representable, but P0-07 does not enable direct stage mutation. Transition execution remains fail closed until stage blockers, actor receipts, rollback approval, and audit ownership are implemented together.
- A schema manifest is a composition of exactly one K12 base, education-stage, school-system, and admission-route module. Module IDs, versions, field definitions, composition version, and content SHA-256 are immutable. Only `candidate -> approved -> retired` status receipts may change.
- P0-07 JSON modules are visibly synthetic candidates. They prove composition and validation only; they are not a production K12 field catalogue and cannot be silently promoted.
- An Assessment belongs to one ServiceCase and one approved manifest. One `(case, manifest)` assessment is allowed. Assessment status is structural only; stage advancement remains fail closed until the approved blocker catalogue exists.
- Every Answer references its Assessment's exact manifest field and stores the manifest/module version, field ID, source, visibility, updater, timestamp, and exact `record_version`.
- Answer semantics are exactly one of `provided`, `unknown`, `not_applicable`, or `declined_to_provide`. `provided` requires non-null JSON plus a value-type tag matching the manifest field; the other semantic states require no value. P0-07 validates the type tag, not the still-open production type/enum catalogue.
- Live SchoolTarget creation starts at `candidate`. SchoolTarget uses a UUID `school_id` as an opaque future School reference. P0-07 cannot add the physical School FK because `P0-08` owns and creates that table; P0-08 must add the tenant-composite FK before the application role can write targets.
- A case cannot contain duplicate `(school_id, intake_year, admission_type)` targets. Target state remains independent from ServiceCase stage and uses its own exact record version.
- Terminal target facts are `waitlisted`, `accepted`, `rejected`, and `withdrawn`. At transaction commit each terminal target has exactly one current matching CaseOutcome. Non-terminal targets have no current outcome.
- CaseOutcome core facts are append-only. A correction atomically closes the current revision and inserts the next revision; prior outcome code/date/evidence/source/actor values and hard deletes are rejected.
- `not_submitted` and `aborted` remain reserved CaseOutcome codes from `DEC-058`, but P0-07 does not invent SchoolTarget transitions for them while `OD-05` is open.
- All tenant-owned relations use non-null `organization_id` plus composite keys/FKs. Every mutable row requires exact `record_version + 1` and non-decreasing timestamps.

## Exact File Payload

Approval authorizes creating or modifying only these files:

1. Create `db/migrations/202608021830_003_expand_cases.sql`.
2. Create `modules/cases/contract.ts`.
3. Create `schema/k12/base.synthetic.v1.json`.
4. Create `schema/k12/education-stage.synthetic.v1.json`.
5. Create `schema/k12/school-system.synthetic.v1.json`.
6. Create `schema/k12/admission-route.synthetic.v1.json`.
7. Create `tests/integration/case-schema.test.ts`.
8. Modify `tests/integration/identity-access-schema.test.ts` and `tests/integration/crm-schema.test.ts` only if their migration-planner assertions need the same narrow future-migration compatibility already used for P0-05.
9. Update this plan and the two workspace Phase 0 checkpoint documents only after deterministic evidence is available.

Any additional source file, table, field category, state transition, destructive action, or changed migration content requires a new payload version and approval.

## Exact Schema Payload

The additive migration creates seven tables in `public`:

| Table | Principal columns and constraints |
| --- | --- |
| `cases_service_cases` | UUID PK; tenant-composite Student FK; tenant-scoped unique `case_number`; `application_type='k12'`; positive intake year; non-empty admission type; immutable active Founder/Advisor role tuple; eight allowed stage values; exact version/timestamps; partial unique non-closed Student/intake/admission tuple; no hard delete. |
| `cases_schema_manifests` | UUID PK; application/composition identity; exactly four module IDs/versions; lowercase SHA-256 content hash; `candidate/approved/retired` receipts; tenant-neutral immutable content; unique composition and hash; no hard delete. |
| `cases_schema_manifest_fields` | Composite manifest/module/field identity; non-empty value-type tag, source visibility, and blocker metadata; FK to manifest; immutable and not independently deletable. |
| `cases_assessments` | UUID PK; tenant-composite Case FK; approved manifest FK; `draft/background_complete/selection_ready`; one assessment per Case/manifest; exact version/timestamps; no hard delete. |
| `cases_assessment_answers` | UUID PK; tenant/Assessment/manifest-field composite FKs; semantic state; tagged JSON value; source/visibility/updater; derived rule version when applicable; exact version/timestamps; no hard delete. |
| `cases_school_targets` | UUID PK; tenant-composite Case FK; opaque future `school_id`; intake/admission tuple; independent approved state values; optional pinned resolved revision UUID and required pin hash when present; exact version/timestamps; unique Case/school/intake/admission; no hard delete. |
| `cases_case_outcomes` | UUID PK; tenant/Case/Target composite FKs; controlled outcome code/date; non-empty source; JSON evidence; actor; revision number and previous revision; one current outcome per target; one-way supersession receipt; exact version/timestamps; no hard delete. |

## SQL Enforcement

- Ordinary DDL is used without `IF NOT EXISTS`; schema drift remains visible.
- INSERT/UPDATE triggers lock and validate tenant-consistent active Student, active organization membership, and active Founder/Advisor role binding for ServiceCase creation.
- ServiceCase identity, application classification, intake/admission identity, initial primary role tuple, creation time, and stage are immutable in P0-07. Only a later approved migration may enable stage or advisor-transfer commands.
- Manifest core content and field rows are immutable. Candidate approval and approved retirement require actor/time receipts; referenced manifests cannot be deleted or rewritten.
- Answer triggers validate Assessment/manifest consistency, semantic-state exclusivity, provided value-type tags, exact versions, monotonic timestamps, and immutable identity/version references.
- Target triggers enforce immutable tenant/case/school/intake/admission identity and status, exact versions, monotonic timestamps, and complete pin tuples. P0-07 does not authorize route transitions. The pure contract requires `candidate` for live creation and returns a fail-closed route-policy denial for mutation; local PostgreSQL evidence may insert a synthetic historical terminal fact only to exercise the deferred outcome invariant.
- Deferrable constraint triggers evaluate terminal target/outcome consistency at transaction commit so target plus outcome creation and outcome correction can be atomic.
- Outcome triggers require exact sequential revisions, one previous current revision for corrections, immutable core facts, one-way supersession receipts, and matching tenant/case/target identity.
- DELETE triggers reject hard deletion of every authoritative P0-07 row. Retention duration and purge remain unimplemented rather than guessed.

## Public Contract Payload

`modules/cases/contract.ts` exports:

- approved structural application, case stage, assessment status, target state, outcome code, answer semantic-state, and K12 module-layer constants;
- typed JSON-module parsing and `composeK12Manifest`, requiring exactly four layers, K12-only modules, unique field IDs, deterministic canonical content, and a SHA-256 receipt;
- `evaluateServiceCaseCreation`, denying non-K12, inactive Student, cross-organization context, inactive/non-Founder-or-Advisor primary role, or an unapproved manifest;
- `evaluateAssessmentAnswer`, enforcing semantic-state exclusivity and the manifest value-type tag;
- `evaluateAssessmentStatus`, returning a blocker denial unless the caller supplies an approved manifest and complete blocker evidence;
- `evaluateSchoolTargetCreation`, requiring `candidate` for live creation, plus `evaluateSchoolTargetTransition`, returning `TARGET_ROUTE_POLICY_REQUIRED` in P0-07 because `OD-05` is open;
- `evaluateTargetOutcome`, requiring exactly one matching current outcome for terminal target facts and none for non-terminal targets;
- stable denial codes suitable for later `409`/`422` API mapping without exposing raw SQL errors.

## Synthetic K12 Module Payload

Each JSON file contains only ASCII fixture data with this common contract:

- `applicationType: "k12"`;
- one unique `layer` from `base`, `education_stage`, `school_system`, `admission_route`;
- immutable `moduleId`, `version`, and `catalogueStatus: "synthetic_candidate"`;
- `productionEnabled: false`;
- one namespaced synthetic field with a value-type tag, visibility, and blocker stages;
- no copied demo labels, customer data, school data, legal IDs, production enum choices, or real PII.

## TDD Seams And Deterministic Evidence

`tests/integration/case-schema.test.ts` is the approved public seam. TDD proceeds one vertical slice at a time through exported contract behavior and PostgreSQL constraints:

1. Parse and compose the four exact JSON modules; reject a missing/duplicate/non-K12 layer and duplicate field IDs; assert a known canonical SHA-256.
2. Deny non-K12 ServiceCase creation and inactive/cross-tenant/non-Advisor primary ownership.
3. Validate `provided`, `unknown`, `not_applicable`, and `declined_to_provide` answers; reject mixed/missing value semantics and mismatched type tags.
4. Require approved manifests and explicit blocker evidence; keep live case/target transition execution fail closed.
5. Publish the exact migration name and SHA-256 through the migration planner.
6. Apply P0-05, P0-06, then P0-07 to empty PostgreSQL 17.10 and prove all seven tables and tenant-composite constraints.
7. Prove duplicate non-closed Student/intake/admission cases fail while a synthetic historical `closed` row and a distinct new live case remain representable without reopening the old row.
8. Prove duplicate target tuples fail and target facts remain independent from case stage.
9. Prove manifest/module fields cannot be rewritten or deleted after insertion, retirement preserves existing references, and no new Assessment selects a retired manifest.
10. Prove stale Answer/Target writes and timestamp rollback fail, while exact next versions pass.
11. Prove a synthetic historical terminal target without a current matching CaseOutcome fails at deferred-constraint evaluation.
12. Prove atomic synthetic historical terminal target plus outcome passes; a second current outcome fails; atomic supersede-plus-next-revision passes; prior outcome facts and all hard deletes remain immutable.

Focused TypeScript checks cover only the new contract/test plus imported Phase 0 contracts. The complete Phase 0 `node --test` suite is rerun after focused checks. Repository-prohibited `pnpm lint` and `pnpm build` remain unrun.

## Current Evidence

- Focused P0-07 Node suite: `11 pass`, `0 fail`, `1 skip`; the skip is the PostgreSQL case with no `TEST_DATABASE_URL`.
- Complete Phase 0 Node suite: `61 pass`, `0 fail`, `3 skip`; the three skips are the P0-05, P0-06, and P0-07 PostgreSQL cases without a database URL.
- OPA residency policy: `7/7 pass` with OPA `1.19.0`; the previous `spawnSync opa ENOENT` failure is resolved.
- Migration planner: P0-07 name and SHA receipt pass; no migration was executed against any database.
- Targeted TypeScript command was attempted twice but produced no output and was terminated after the bounded wait with exit `130`; no TypeScript pass is claimed.
- PostgreSQL evidence is pending: starting `codex-p005` resulted in Colima profile status `Broken`, so no container, database, or synthetic SQL execution was claimed or retried.

## Local Database Evidence Boundary

One bounded local attempt may start the existing stopped `codex-p005` Colima/containerd profile and use only the cached PostgreSQL 17.10 image with a synthetic database and synthetic credentials. No host mount, real secret, real data, cloud, Neon, RDS, or staging/production connection is authorized. The profile is stopped after evidence. If the container attempt fails for infrastructure reasons, the failure is recorded and P0-07 continues without claiming PostgreSQL evidence, following the user's prior stopping instruction.

## Rollback And Approval Boundary

Before any use, rollback is deletion of the unreferenced P0-07 candidate files while preserving this approval/evidence record. After any migration use, ordered migration content and referenced manifest/outcome history are immutable; rollback is a new corrective migration, retiring an unreferenced candidate manifest, or disabling later application use. No referenced manifest version or CaseOutcome revision may be rewritten.

Approval must explicitly identify plan version `v0.1` and candidate migration `202608021830_003_expand_cases.sql`. Approval permits local synthetic implementation and bounded verification only. It does not authorize migration execution against Neon/RDS/staging/production, real-data writes, case/answer/outcome purge, commit, push, deployment, or cloud changes.
