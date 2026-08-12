# P2-02 Approved K12 Catalogue Plan

| Control | Value |
| --- | --- |
| Ticket | `P2-02` Approved K12 field catalogue resolves all four-layer manifests |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_locally_pending_hk_rds_manifest_adapter` |
| Decision inputs | `OD-09`, `DEC-003`, `DEC-012`, `DEC-013`, `DEC-026`, `DEC-043`, `DEC-044` |
| External state | No migration, RDS/Neon write, cloud call, real PII, commit, push, deployment, or release action |

## Scope And Boundary

This ticket publishes one approved, immutable K12 catalogue composition. It is the only local source for the four selected modules, their field identifiers, types, enum values, default visibility, and case-stage blocker declarations. The existing synthetic structural modules remain unchanged as P0-07 evidence; they are not promoted or modified.

The scope includes deterministic parsing/composition, resolver DTO projection, server-side typed-value validation, the existing assessment editor's controls, and focused synthetic tests. It does not create a manifest database row, choose a real case's manifest, migrate existing answers, enable assessment status or case-stage transitions, change field-level access policy, write an RDS adapter, or alter non-K12 routes. The established server-side K12-only case guard remains the enforcement owner for `DEC-003`.

## Immutable Manifest And Version Strategy

- The four files are `student-profile.v1.json`, `education-profile.v1.json`, `school-preferences.v1.json`, and `family-context.v1.json`; each is version `1.0.0`, `catalogueStatus: "approved"`, and `productionEnabled: true`.
- P0-07's stable composition-slot names remain `base`, `education_stage`, `school_system`, and `admission_route`, because those identifiers are already present in the immutable database contract. The selected logical module IDs map to those slots as `student_profile -> base`, `education_profile -> education_stage`, `school_preferences -> school_system`, and `family_context -> admission_route`. A slot is a version-resolution key, not a claim that family data is an admission-route datum.
- A composition containing all four approved modules is `k12-catalogue-v1`. Its canonical field/module content SHA-256 is `41ccf1d4782bd245eb94b8760d17fa4c927696bdf9aaecce9dd89a125ad9caac`. Any field, enum, module version, visibility, or blocker change must be a new file/module version and a new composition receipt; existing answers retain their pinned manifest/module versions.
- A composition may contain either all legacy synthetic candidates or all approved catalogue modules. Mixed modes are rejected, so a synthetic field cannot become live through accidental composition.

## Field Catalogue

All listed fields are visible to Advisors by default. This is display metadata, not a field-level ACL grant: the CaseWorkflow/Access service still authorizes the assessment read or update. Every module declares both case-stage blocker sets. A field in both sets must remain semantically resolved for both gates.

| Module / slot | Field ID | Type / validation enum | Visibility | `background_collection` | `school_selection_confirmed` |
| --- | --- | --- | --- | --- | --- |
| `student_profile` / `base` | `student_profile.date_of_birth` | `date` ISO calendar date | `advisor` | yes | yes |
| | `student_profile.residency_status` | `enum`: `hk_permanent_resident`, `hk_non_permanent_resident`, `dependent_visa`, `other` | `advisor` | yes | yes |
| | `student_profile.primary_languages` | `enum_set`: `cantonese`, `mandarin`, `english`, `other` | `advisor` | yes | no |
| `education_profile` / `education_stage` | `education_profile.current_stage` | `enum`: `kindergarten`, `primary`, `secondary` | `advisor` | yes | yes |
| | `education_profile.current_year_level` | non-empty `text` | `advisor` | yes | yes |
| | `education_profile.current_curriculum` | `enum`: `hk_local`, `ib`, `cambridge`, `other` | `advisor` | yes | no |
| `school_preferences` / `school_system` | `school_preferences.target_stage` | `enum`: `kindergarten`, `primary`, `secondary` | `advisor` | yes | yes |
| | `school_preferences.preferred_systems` | `enum_set`: `hk_local`, `hk_international` | `advisor` | no | yes |
| | `school_preferences.preferred_districts` | `enum_set`: `hong_kong_island`, `kowloon`, `new_territories`, `any` | `advisor` | no | yes |
| | `school_preferences.preferred_admission_route` | `enum`: `entry`, `transfer` | `advisor` | yes | yes |
| | `school_preferences.fee_band` | `enum`: `government_aided`, `private`, `international`, `undecided` | `advisor` | no | yes |
| `family_context` / `admission_route` | `family_context.primary_contact_language` | `enum`: `cantonese`, `mandarin`, `english`, `other` | `advisor` | yes | yes |
| | `family_context.education_priority` | `enum`: `academic`, `balanced`, `language_immersion`, `supportive_environment`, `other` | `advisor` | yes | yes |
| | `family_context.transport_arrangement` | `enum`: `family_transport`, `school_bus`, `public_transport`, `undecided` | `advisor` | no | yes |
| | `family_context.fee_preference` | `enum`: `government_aided`, `private`, `international`, `undecided` | `advisor` | no | yes |

The catalogue intentionally excludes legal identity numbers/images, medical details, household income, exact address, and copied legacy mock values.

## State, Enforcement, And Errors

`provided` answers have a typed envelope whose type exactly matches the manifest field. `text` is non-empty; `date` is a real ISO calendar date; `enum` is one declared value; and `enum_set` is a non-empty, duplicate-free subset of its declared enum. `unknown`, `not_applicable`, and `declined_to_provide` remain value-free P0-07 semantic states. This preserves `DEC-043` without encoding blanks or free-text sentinels.

The resolver projects field type, enum choices, default visibility, and derived case-stage blockers only from the case-pinned manifest. The assessment service is the server-side validation owner. The route remains an adapter: malformed framing is `400`, known-but-invalid field/type/value is `422 VALIDATION_FAILED`, an unauthorized actor is `403`, a stale answer version is `409 STALE_VERSION`, and unavailable runtime remains `503`. No client-side select control is an authorization decision.

The approved blockers are case-stage terms. P1-07's independently stored assessment status still uses `background_complete` / `selection_ready`; no status or stage command is enabled or remapped by this ticket. P2-03 must use the pinned catalogue blockers when it implements transitions.

## Concurrency And Reversible Boundary

The existing P1-07 answer command keeps optimistic compare-and-set by `expected_record_version`. Its future HK RDS adapter must read the pinned manifest, current grant/ownership, current answer, and idempotency receipt in the same transaction before applying server validation and the atomic answer/audit/outbox update. This local catalogue does not provide an in-memory, Neon, or JSON runtime fallback.

Before a catalogue is referenced, rollback is disabling its selection and removing the unreferenced local candidate under a reviewed change. After a manifest is referenced, correction is a new approved module/composition version and new manifest receipt; no field or historical answer is rewritten.

## Deterministic Evidence

Focused evidence run on 2026-08-07:

- `node --test tests/integration/k12-catalogue.test.ts tests/integration/assessment-workflow.test.ts tests/integration/case-schema.test.ts`: `20` pass, `0` fail, `1` PostgreSQL skip because `TEST_DATABASE_URL` is intentionally absent.
- `./node_modules/.bin/tsc --noEmit --pretty false`: pass with no diagnostics.
- `node --check` for the contract, resolver, assessment service, and assessment route, plus `git diff --check`: pass.

The catalogue test asserts the exact 15-field receipt, four selected modules, immutable SHA-256, blocker membership, non-K12/mixed-mode denial, and value validation. The retained P1-07 suite proves semantic states, authorization, optimistic concurrency, idempotency, and atomic answer/audit/outbox behavior. `pnpm lint` and `pnpm build` remain prohibited without separate authorization.
