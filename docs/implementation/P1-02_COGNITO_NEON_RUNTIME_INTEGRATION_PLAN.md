# P1-02 Cognito And Neon Runtime Integration Plan

| Control | Value |
| --- | --- |
| Plan version | `v0.1` |
| Date | 2026-08-04 (Asia/Hong_Kong) |
| Status | `repository_adapter_implemented_cloud_gates_pending`: server-side adapters and focused checks are in place; Cognito/Neon cloud configuration and migrations remain pending |
| Primary users | Founder/Admin and Advisor |
| Deployment boundary | Git push triggers Vercel; no direct Vercel CLI operation |

## Problem And Outcome

The Case-first UI exists, and Vercel already supplies a Neon connection for
the current crawler/knowledge paths. The runtime still lacks the seam that
turns a Cognito identity into an authorized organization-scoped application
session. The outcome is an invite-only sign-in flow, an opaque session cookie,
Neon-owned role and organization authorization, and server-only data access for
Case/Student APIs.

## Scope

In scope:

- Cognito managed-login authorization-code + PKCE callback adapter.
- Verification of Cognito issuer, signature, token use, client ID, expiry, and
  immutable `sub` provider identity.
- Provisioning/reconciliation of `identity_users` and
  `identity_provider_identities` after a successful callback.
- Opaque HttpOnly session cookie backed by `identity_sessions`, including idle,
  absolute, session-version, organization, membership, and role checks.
- Server-only authorization helpers and guards for existing mutable API routes.
- Neon application adapter using `DATABASE_URL`; migration execution remains a
  separate `MIGRATION_DATABASE_URL` process.
- Deterministic tests for missing configuration, token claims, session policy,
  and stable `401`/`403`/`409` error mapping.

Out of scope until explicit cloud/data approval:

- Creating or changing a Cognito User Pool, domain, app client, MFA, SES, or
  invite policy.
- Writing to production Neon, executing migrations, or backfilling existing
  customer records.
- Treating Cognito groups as the authoritative organization authorization.
- Logging raw JWTs, refresh tokens, database URLs, customer data, or provider
  error payloads.

## Invariants And Ownership

- Cognito `sub` is the provider identity; email is not a primary identity key.
- Neon owns organization membership, active role bindings, session revocation,
  and Case/Student scope.
- The browser receives only an opaque session cookie; it does not decide the
  organization or role and does not store provider tokens in local storage.
- Every server data query receives actor context and filters by the actor's
  organization. Client-supplied `organization_id` is ignored or rejected.
- A missing/disabled user, membership, organization, or stale session returns
  `401`/`403`; it never falls back to mock data for an authoritative route.
- Case creation rechecks active Student, Founder/Advisor binding, approved
  manifest, and the database duplicate constraint inside the owning transaction.

## Required Runtime Configuration

Server-only variables:

```text
DATABASE_URL
MIGRATION_DATABASE_URL
COGNITO_REGION
COGNITO_USER_POOL_ID
COGNITO_APP_CLIENT_ID
COGNITO_DOMAIN
COGNITO_REDIRECT_URI
COGNITO_LOGOUT_URI
SESSION_ENCRYPTION_KEY
```

Only non-secret Cognito domain/client metadata may be exposed to a browser if
the implementation requires it. No database URL, client secret, token, or
encryption key may use a `NEXT_PUBLIC_` prefix.

## Sequencing And Gates

1. Finish repository adapters and focused tests without cloud writes.
2. Re-authenticate AWS and identify the existing User Pool/region, or obtain a
   separate approved payload for creating one.
3. Configure exact production and stable staging callback/logout URLs.
4. Verify the existing Neon database target, region, schema ledger, and current
   customer tables. Create a Neon branch before any candidate migration.
5. Apply/verify migrations and backfill only through the approved migration role
   and a reviewed mapping; never use the application `DATABASE_URL`.
6. Run staging login, invite, revoke, role, cross-organization, duplicate-case,
   stale-version, and expired-session tests.
7. Commit and push the reviewed code. Vercel deployment is a consequence of the
   push, not evidence that Cognito or Neon runtime gates passed.

## Acceptance Evidence

- Callback rejects invalid state, PKCE mismatch, wrong issuer, wrong token use,
  wrong app client, expired token, unknown provider subject, and missing active
  membership.
- Session tests prove 15-minute idle expiry, 8-hour absolute expiry, stale
  `session_version` denial, three-slot maximum, sign-out revocation, and secure
  cookie attributes.
- API tests prove unauthenticated `401`, cross-organization `403`, duplicate
  case `409`, validation `422`, and no raw provider/SQL error leakage.
- Neon migration plan and schema/count/backfill evidence are retained before
  any production data mutation.
- Vercel deployment health is checked after push, but deployment health is not
  treated as authorization or migration evidence.

## Current Blocker

The local AWS CLI profile currently returns `InvalidClientTokenId` and is set to
`us-east-1`. No Cognito resource creation or lookup has been attempted after
that failed identity check. The next cloud action requires a valid AWS
authentication method and a confirmed target region; no secret should be
posted in chat.

## Repository Implementation Evidence

The repository-side slice is implemented without cloud writes:

- `/api/auth/login` creates state and PKCE cookies and redirects to the Cognito
  managed-login endpoint.
- `/api/auth/callback` validates state, exchanges the authorization code,
  verifies both Cognito JWTs against issuer/JWKS claims and signatures, then
  creates an opaque Neon-backed session only for an invited/active user with an
  active organization membership.
- `/api/auth/me` and `/api/auth/logout` expose the session boundary without
  returning provider tokens to the browser.
- `/api/cases`, `/api/cases/options`, and the case detail loader use actor
  context and organization-scoped Neon queries. Case creation performs the
  Student, primary binding, approved manifest, and duplicate checks in its
  transaction.
- Existing crawler, knowledge, and review mutations now require an authenticated
  role; their success response shapes remain unchanged.
- `tests/unit/auth/runtime.test.ts` and the combined contract/architecture/
  migration/release-harness/auth suite pass. Focused Bun server/browser bundle
  checks pass for the changed route and UI boundaries.

No Cognito resource was created or changed, no Neon migration was executed, and
no production row was written. The local AWS identity check returned
`InvalidClientTokenId`, and the local dependency directory is currently
incomplete after an offline/network install could not fetch the existing Neon
package. `pnpm lint`, `pnpm build`, and a browser run remain unexecuted under
the repository rules and environment constraints.
