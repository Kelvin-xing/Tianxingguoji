# P1-03 Internal Email Identity and Founder Invitations

## Confirmed boundary

- No public registration and no third-party identity login.
- Only an active Founder can create an internal user invitation.
- The invitation creates an invited Identity, Membership, EmployeeProfile and
  active base RoleBinding, but the user cannot log in until activation.
- A one-time email link is sent through the independent Email module. The
  plaintext activation credential is never persisted or returned by an API.
- The recipient sets an initial password and nickname. Activation atomically
  enables the Identity and Membership and creates an internal session.
- Email delivery receipts remain replayable audit facts; email failures keep
  the account pending and Founder can resend a newly rotated one-time link.

## Code scope

- `modules/email`: policy, invitation message composition, deterministic fake
  transport for local/test, the official Resend SDK transport, and encrypted
  organization-level provider settings and Admin-managed invitation template.
- `modules/identity`: internal-email password verifier, invite activation,
  session resolution, PostgreSQL repository and runtime composition.
- `app/(auth)` and `app/api/v1/auth`: internal login, activation and Founder
  invite entrypoints; no registration route is added.
- Migration `055` adds internal credentials and the `internal_email` session
  kind while preserving the previous provider session kinds. Migration `056`
  adds the encrypted organization-level Resend configuration. Migration `057`
  adds the versioned organization-level internal invitation template.
- During the one-time runtime switch, migration `055` copies only an existing
  active Founder's compatible `scrypt-v1` verifier from database-test Identity.
  It never copies or creates a plaintext password and does not provision any
  non-Founder account.

## Required environment

- `AUTH_MODE=internal-email`
- `APP_BASE_URL`
- Local/test fake delivery: `EMAIL_TRANSPORT=deterministic-fake` and `EMAIL_FROM`
- Database-backed Resend: `EMAIL_TRANSPORT=resend`; an Admin saves the Resend
  API key and sender profile in the application. The API key is encrypted with
  `EMAIL_SETTINGS_MASTER_KEY` and its version is identified by
  `EMAIL_SETTINGS_MASTER_KEY_VERSION`. The sender must belong to a verified
  Resend domain.

## Acceptance evidence

1. A non-Founder invite attempt is forbidden.
2. An invite email contains only the one-time link, expiry and neutral account
   wording; no password, token log or business PII is emitted.
3. The activation link can be used once, sets password/nickname, and creates an
   internal session; replay and expiry fail closed.
4. Email delivery failure leaves no active account; the pending invite remains
   visible to Founder and can be resent with a newly rotated link.
5. Typecheck, focused identity/email tests, migration manifest and baseline
   checks pass. Real Resend delivery and deployed browser UAT remain separate evidence.
6. Only Admin can edit the invitation subject and body text at
   `/admin/email/templates`; the activation link, expiry and call-to-action
   remain system-rendered and cannot be removed by template content.

The focused PostgreSQL test also starts a real local Next development server
and real headless Chrome. It verifies Founder invitation and resend, link
activation, initial password and nickname, first login, self nickname update,
role replacement and visibility, logout, authenticated invite creation,
delivery receipt persistence, and the pending user directory projection.

## Cloud rollout gate

1. Create a restricted sending API Key in the organization-owned Resend account;
   do not install a deployment-platform integration.
2. Verify an organization-controlled sending domain in Resend.
3. Dry-run and apply migrations `055`, `056` and `057` to the target database. Migration `055`
   retains the existing active Founder's compatible password verifier.
4. Set `AUTH_MODE=internal-email`, `APP_BASE_URL`, `EMAIL_TRANSPORT=resend`,
   `EMAIL_SETTINGS_MASTER_KEY`, and `EMAIL_SETTINGS_MASTER_KEY_VERSION`; an
   Admin then saves the Resend API Key and sender profile at `/admin/email`,
   and may edit the invitation template at `/admin/email/templates`.
5. Browser-UAT one real invitation, link activation, first login, resend/old-link
   denial, role visibility, and logout before calling the module deployed.

Steps 1–4 write external state and require action-time approval. Secrets and
connection strings are never copied into this document or test evidence.
