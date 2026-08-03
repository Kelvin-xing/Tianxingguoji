# P0-06 CRM Migration Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.2` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `passed`: approved local implementation and PostgreSQL 17.10 evidence complete |
| Migration | `db/migrations/202608021630_002_expand_crm.sql` |
| Runtime side effects | None remaining; disposable local test profile stopped after evidence capture |

## Problem And Stakeholder Outcome

Create the minimum authoritative CRM identity foundation for Release 1 without turning names, birth dates, email addresses, or phone numbers into identity keys. Founder/Admin and Advisors need ReferralSource, Student, Guardian, and historical contact relationships; the data/privacy owner needs legal-identity minimization, no automatic merge, reversible primary-contact handoff, and PII-safe deletion semantics.

Out of scope: ServiceCase or assessment data, DuplicateCandidate/MergeRevision execution, CRM routes/UI/services, real CustomerOrganization or EndClient data, legal-ID storage, audit/outbox delivery, retention-policy invention, database-role creation, RLS activation, staging/production migration, commit, push, cloud, or deployment. P1-02 owns the unprivileged application role and runtime tenant-policy activation; this migration still requires non-null tenant keys and composite tenant foreign keys.

## Business Rules And Identity Invariants

- ReferralSource is organization-owned reference data only. It has no User, membership, role, credential, session, or case-read relation.
- Student and Guardian use application-generated UUID identity. Display name, date of birth, email, and phone are nullable/non-unique attributes and never relationship keys.
- Guardian is independent from Student and may relate to multiple siblings. Student/Guardian similarity may create a future review candidate but never merges or aliases rows automatically.
- Release 1 stores no HKID, mainland identity-card number, passport number, legal-ID image, or generic government-ID field.
- An active Student must have exactly one current primary-contact relationship at transaction commit. Temporary zero-primary state is allowed only inside an atomic handoff transaction.
- Relationship history is append/close: tenant, Student, Guardian, relationship type, legal flag, purposes, consent, and start time are immutable. Closing a current row records end time, actor, reason, and the exact next `record_version`; correction creates a new relationship row.
- Student and Guardian lifecycle is `active -> pending_delete -> purged`. Reverse or skipped transitions fail. A purged tombstone retains only UUID, organization, lifecycle/version timestamps, and non-PII deletion receipts; all display/contact/date-of-birth values must be null.
- P0-06 does not decide retention duration or authorize purge. The pure deletion gate requires Founder approval plus retention, legal-hold, and referential checks; callers fail closed until those facts are supplied by later approved workflows.

## Exact Schema Payload

The additive migration creates four tables in `public`:

| Table | Principal columns and constraints |
| --- | --- |
| `crm_referral_sources` | UUID PK; `organization_id` FK; non-empty `display_name` and `source_type`; `active/inactive`; no auth/account FK; non-decreasing version/timestamps; no uniqueness on name/type. |
| `crm_students` | UUID PK; tenant composite key; nullable `display_name`, `date_of_birth`, `contact_email`, `contact_phone`; `active/pending_delete/purged`; deletion request/purge receipts; no legal-ID columns and no attribute uniqueness. |
| `crm_guardians` | UUID PK; tenant composite key; nullable `display_name`, `email`, `phone`; same lifecycle/deletion receipt contract; no global or tenant contact uniqueness. |
| `crm_student_guardian_relationships` | UUID PK; tenant-composite Student and Guardian FKs; non-empty free-text `relationship_type`; legal/primary/emergency/billing flags; notification consent; start/end receipt; one current row per Student/Guardian pair and one current primary per Student. |

Every table has `record_version bigint NOT NULL`, `created_at`, and `updated_at`. Mutable updates require the exact next `record_version`; timestamps cannot move backward. Tenant-owned relationships use `(id, organization_id)` composite keys and FKs.

## SQL Enforcement

- Ordinary DDL is used without `IF NOT EXISTS`; drift must fail visibly.
- Partial unique indexes enforce one current relationship per Student/Guardian pair and at most one current primary per Student.
- Deferrable constraint triggers check at transaction commit that every active Student has one current primary relationship to an active Guardian.
- Relationship INSERT locks and validates active Student/Guardian rows. Relationship UPDATE permits only one-way close; closed rows and DELETE are rejected so history is not erased.
- Student/Guardian state triggers reject reverse/skipped lifecycle transitions, require deletion receipts, require PII scrubbing on `purged`, and reject purge while current relationships remain.
- ReferralSource permits only `active -> inactive`, rejects hard delete, and has no path to Identity/User/session tables.
- Every update requires the exact next `record_version` and a non-decreasing `updated_at`; deletion and relationship receipts cannot predate creation or exceed `updated_at`.
- Email/phone checks reject blank strings but intentionally do not impose a format or uniqueness rule that the approved decisions did not define.

## Public Contract Payload

`modules/crm/contract.ts` exports immutable CRM states, stable denial codes, forbidden legal-identity field names, a pure primary-contact evaluator, a fail-closed deletion gate, and duplicate-match classification that can return only `distinct` or `review_required`, never `merge`.

The deletion gate inputs are actor role, approval receipt, retention clearance, legal-hold state, reference clearance, and current lifecycle state. It permits `active -> pending_delete` with a reason; `pending_delete -> purged` only with Founder approval and every external clearance; all other transitions are denied.

## Deterministic Evidence

`tests/integration/crm-schema.test.ts` is the public test seam. It will:

1. Apply P0-05 then P0-06 to empty PostgreSQL 17.10.
2. Prove the four tables, tenant-composite keys, and ordered migration receipt.
3. Prove ReferralSource has no auth relation and duplicate names remain representable.
4. Prove duplicate Student/Guardian names, dates, email, and phone remain representable, while forbidden legal-ID columns are absent.
5. Prove one Guardian may serve siblings and no identity match can auto-merge.
6. Prove an active Student without a primary fails at deferred-constraint evaluation.
7. Prove a valid Student/Guardian/primary relationship transaction passes, a second current primary fails, and close-plus-open handoff preserves history.
8. Prove relationship identity/history fields cannot be rewritten or deleted.
9. Prove lifecycle reversal/skipping fails and purge requires PII scrubbing, approval/clearance contract evidence, and no current relationships.

Adding the second migration also modifies the P0-05 planner assertion so it verifies the immutable P0-05 receipt by migration name instead of assuming the global migration directory will forever contain one file.

## Verification Result

- Migration receipt: SHA-256 `e1e8310a194d95848e063a42b1391076875e58a3dfac30fe024c621b54373b50`.
- Database: PostgreSQL `17.10` from `postgres:17.10-alpine3.22`; observed RepoDigest `postgres@sha256:b02d9b5bcf608c2719da32cdabee274a33841202487fd5dc9b065b63f886753f`.
- Focused P0-06 PostgreSQL test: 5 pass, 0 fail, 0 skip.
- Combined P0-05/P0-06 PostgreSQL test: 10 pass, 0 fail, 0 skip.
- Targeted strict TypeScript: pass for identity/access/CRM contracts, migration planner, and both integration seams.
- P0-04 migration regression: 10 pass, 0 fail, 0 skip.
- Complete Phase 0 suite: 43 pass, 1 fail, 8 skip. The only failure is `spawnSync opa ENOENT`; six policy cases skip without OPA and two database cases skip without `TEST_DATABASE_URL`, while both database cases pass in the dedicated combined run above.
- `pnpm lint` and `pnpm build` were not run because repository instructions prohibit them without separate explicit authorization.

## Harness, Budget, And Terminal States

- Test environment: dedicated `codex-p005` Colima profile, cached Docker Official Image `postgres:17.10-alpine3.22`, 2 CPUs, 2 GiB memory, enforced 20 GiB profile disk, one synthetic database, no host mount, no real credentials/data.
- Allowed writes: the migration, CRM contract/test, this plan, the P0-05 planner assertion compatibility change, and completion checkpoints only.
- Commands: focused Node tests, targeted strict TypeScript, P0-04 migration regression, full Phase 0 Node suite, and local container start/stop. `pnpm lint` and `pnpm build` remain prohibited without separate authorization.
- Retry limit: at most two implementation changes per deterministic failure class. A Colima startup/cleanup failure gets one status check and no external database fallback.
- Evidence: SQLSTATE and constraint name, test counts, PostgreSQL version/image digest, migration SHA-256, TypeScript result, full-suite residual failures, and final diff review.
- Terminal states: `passed`, `needs_human`, `blocked`, `budget_exhausted`, or `cancelled`. If local PostgreSQL is unavailable, retain focused non-DB evidence, mark `needs_human`, and do not claim AC-02 passed.

## Failure, Rollback, And Approval Boundary

- Before adoption, rollback is deletion of the unexecuted P0-06 candidate files and restoration of the planner assertion; no data cleanup is needed.
- After any approved real use, migration history is immutable. Correction requires a new reviewed migration or compatible application rollback.
- Deferred primary-contact failures roll back the whole transaction; no repair job may silently invent a Guardian or primary relationship.
- Purge, merge, and legal-ID expansion are never inferred from missing data or similarity.

Approval authorizes creation of `db/migrations/202608021630_002_expand_crm.sql`, `modules/crm/contract.ts`, `tests/integration/crm-schema.test.ts`, the narrow P0-05 planner assertion compatibility edit, and disposable local PostgreSQL verification under the limits above. It does not authorize staging/production/database-role/RLS changes, real data, purge, merge, commit, push, cloud resource, or deployment.
