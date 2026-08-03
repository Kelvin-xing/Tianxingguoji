# P0-05 Identity And Access Migration Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.3` |
| Date | 2026-08-02 (Asia/Hong_Kong) |
| Status | `passed`: approved local PostgreSQL 17.10 evidence complete; no external environment or real data used |
| Migration | `db/migrations/202608021330_001_expand_identity_access.sql` |
| Runtime side effects | None remaining; disposable container and Colima profile stopped after verification |

## Outcome And Scope

Create an additive Release 1 identity/access foundation that enforces provider identity, opaque session, version revocation, bounded collaborator grants, sensitive approval receipts, and collaborator export denial. The stakeholders are the Founder/Admin, Advisors, collaborators, security owner, privacy owner, and operations owner.

Out of scope: Cognito resource creation or calls, invite delivery channel/TTL defaults (`OD-01`), production or staging database connections, migration execution outside the disposable test database, application auth routes, audit/outbox delivery, subscriptions, a second active organization, commit, push, or deployment.

## Approved Session Policy

- Idle expiry: 15 minutes from the latest accepted activity.
- Absolute expiry: at most 8 hours from session creation; refresh never extends it.
- Concurrent sessions: at most three active slots per User.
- Fourth login: reject with `SESSION_LIMIT_REACHED`; never evict an existing session implicitly.
- Sensitive action: require TOTP re-authentication no more than five minutes old.
- Disable/revoke-all: increment `User.session_version`; every request compares the captured session version with the current User version.

## Exact Schema Payload

The migration creates these nine tables in `public`:

| Table | Owner | Principal invariants |
| --- | --- | --- |
| `identity_users` | Identity | UUID identity; normalized email unique; `invited/active/disabled`; non-decreasing `session_version`; disabling increments it exactly once. |
| `identity_provider_identities` | Identity | User FK; provider is `cognito`; unique `(provider, provider_subject)`; one identity per User/provider. |
| `access_organizations` | Access | UUID identity; `active/disabled`; partial unique constant permits at most one active Release 1 organization. |
| `access_organization_memberships` | Access | Organization/User composite ownership; `invited/active/disabled`; one current membership per Organization/User. |
| `access_role_bindings` | Access | Membership FK; roles limited to `founder/admin/advisor/data_reviewer/contractor`; one active binding per membership/role. |
| `identity_sessions` | Identity | 32-byte unique secret hash only; active organization/membership; captured session version; slot `1..3`; active slot unique per User; encrypted provider token fields required while active; idle/absolute/re-auth/revoke timestamps. |
| `identity_invites` | Identity | Organization/User/inviter FKs; 32-byte unique secret hash only; `created/redeemed/expired/revoked`; one created invite per Organization/User; caller must supply expiry because `OD-01` remains open. |
| `access_case_collaborators` | Access | Organization/case/advisor membership; linked role binding must be `advisor`; one active row per Organization/case/User; case FK deferred to `P0-07`. |
| `access_scope_grants` | Access | Collaborator/case composite FK; approved scope and `view/comment/edit` only; expiry after start and no later than seven days; sensitive active grant requires distinct approver, reason, and approval time; one active equivalent grant. |

All authoritative mutable rows receive `record_version bigint NOT NULL`, `created_at`, and `updated_at`. Tenant-owned access rows receive `organization_id NOT NULL` and composite foreign keys. UUIDs are application-generated; no database extension is introduced.

## SQL Enforcement

- Use ordinary `CREATE TABLE`, constraints, indexes, and triggers without `IF NOT EXISTS`, so drift fails rather than being hidden.
- Store secret hashes as `bytea` with `octet_length(...) = 32`; raw invite/session secrets have no column.
- Use a partial unique index on active `(user_id, session_slot)` and a `1..3` check to enforce the concurrent-session ceiling.
- Use a User update trigger to enforce `invited -> active -> disabled`, reject `session_version` decreases, and require an exact one-step version increase when disabling.
- Require active session provider-token ciphertext/key version, a current active User/Organization/Membership under row locks, `idle_expires_at <= last_seen_at + 15 minutes`, and `absolute_expires_at <= created_at + 8 hours`.
- Keep session identity, secret hash, slot, captured version, creation time, and absolute expiry immutable; allow only `active -> revoked/expired`.
- Keep invite and grant terminal states irreversible; a ScopeGrant may move only `pending_approval -> active -> revoked/expired`.
- Keep ScopeGrant tenant, case, collaborator, scope, capability, duration, requester, and active approval receipt immutable; renewal or scope changes require a new decision.
- Limit grant scopes to `case_summary`, `education_profile`, `school_targets`, `task_workspace`, `communications`, `identity_contact`, and `internal_notes`.
- Limit capabilities to `view`, `comment`, and `edit`; there is no `export` value.
- Require every grant to expire within seven days and no later than its case/collaborator boundary once `P0-07` adds the case FK.
- Require `identity_contact` and `internal_notes` grants to begin `pending_approval`; activation requires a non-empty reason, approval time, and approver different from the requester.

## Public Contract Payload

`modules/identity/contract.ts` exports immutable policy constants, User/Session states, stable denial codes, active-slot allocation, and a pure session evaluator. It denies non-active Users, revoked/expired sessions, stale `session_version`, idle/absolute expiry, inactive organization/membership, slot exhaustion, and stale/missing TOTP re-authentication.

`modules/access/contract.ts` exports the approved scope/capability catalogues, sensitive-scope classification, seven-day expiry calculation, stable denial codes, and a pure grant evaluator. It denies non-active Users/Organizations/Memberships/advisor roles/collaborations/grants, organization/case mismatch, expiry, unapproved sensitive access, and every collaborator export request.

## Deterministic Evidence

`tests/integration/identity-access-schema.test.ts` is the approved public test seam. It will:

1. Apply the SQL to an empty PostgreSQL 17 database.
2. Prove provider-subject and secret-hash uniqueness/length constraints.
3. Prove three sessions remain active and a fourth allocation is rejected without eviction.
4. Prove disabling without the exact version bump fails, old captured versions are denied, and immutable session identity/lifetime fields cannot be rewritten.
5. Prove idle, absolute, and five-minute sensitive re-authentication decisions.
6. Prove export is not representable, grants over seven days fail, sensitive grants cannot start active, and activation without a distinct approval receipt fails.
7. Prove organization/case/collaborator composite references reject mismatches.
8. Run the P0-04 migration planner against the new ordered SQL file.

The local integration environment is a dedicated Colima profile named `codex-p005`, using containerd and the Docker Official Image `postgres:17.10-alpine3.22`. Limits are 2 CPUs, 2 GiB memory, Colima's enforced 20 GiB minimum disk, one container, one synthetic database, no real credentials or data, and no host directory mount. The test profile and container are stopped after evidence is captured; profile deletion is a separate cleanup action.

## Verification Result

- Migration receipt: SHA-256 `fd3ebd439502eb570882a4daca910dd6dd124810d4a3764c511b05b5db5a5457`.
- Database: PostgreSQL `17.10` from `postgres:17.10-alpine3.22`; observed RepoDigest `postgres@sha256:b02d9b5bcf608c2719da32cdabee274a33841202487fd5dc9b065b63f886753f`.
- Focused P0-05 command: `TEST_DATABASE_URL=<local synthetic URL> node --test tests/integration/identity-access-schema.test.ts`; result 5 pass, 0 fail, 0 skip.
- Targeted strict TypeScript: pass for identity/access contracts, migration planner, and P0-05 integration test.
- P0-04 migration regression: 10 pass, 0 fail, 0 skip.
- Complete Phase 0 suite: 39 pass, 1 fail, 7 skip. The only failure is `spawnSync opa ENOENT`; six policy cases skip without OPA and the database case skips without `TEST_DATABASE_URL`, while the latter passes in the dedicated run above.
- `pnpm lint` and `pnpm build` were not run because repository instructions prohibit them without separate explicit authorization.

## Failure And Rollback

- Test failure: preserve SQLSTATE, failing invariant, expected/actual result, image tag, migration SHA-256, and test command; make at most two implementation retries without new evidence.
- Partial container startup: stop the disposable profile; do not retry a database write against any other target.
- Before adoption: remove the unexecuted SQL/contracts/tests and dependency references.
- After any approved real use: never edit migration history; use a reviewed corrective migration or compatible application rollback.
- Terminal states: `passed`, `needs_human`, `blocked`, `budget_exhausted`, or `cancelled`.

## Approval Payload

Re-approval authorizes creation of the four ticket files, the package test script, restarting the bounded `codex-p005` profile with its enforced 20 GiB minimum disk, downloading the pinned PostgreSQL test image, and executing the migration only inside that disposable local database. It does not authorize any staging/production database connection, Cognito action, real data, commit, push, cloud resource, or deployment.
