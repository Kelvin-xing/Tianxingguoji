# P1-03 Identity Onboarding Plan

| Control | Value |
| --- | --- |
| Ticket | `P1-03` Founder invite -> Cognito TOTP -> opaque BFF session |
| Date | 2026-08-06 (Asia/Hong_Kong) |
| Local status | `implemented_with_synthetic_adapters` |
| DEC / decision inputs | `DEC-007`, `DEC-020`, `DEC-040`, `DEC-041`, resolved `OD-01`, resolved `OD-08` |
| External state | No Cognito, RDS, email provider, migration, deployment, commit, or push action performed |

## Problem And Scope

Founder-only onboarding must create one invited User, establish a Cognito
identity without Cognito sending an email, deliver the application activation
secret through the approved policy class, require TOTP through Cognito Managed
Login, and issue only an opaque BFF session. The implementation is local and
synthetic: it establishes interfaces and fail-closed adapters, not an approved
cloud runtime.

In scope: Founder `POST /api/v1/auth/invites`, invite credential
creation/claiming, Cognito `SUPPRESS` payload construction, immutable
delivery-proof receipt persistence, TOTP completion gate, opaque session
creation/revocation, route boundaries, and activation UI.

Out of scope: concrete channel/provider selection, sender identity, delivery
network call, Cognito user pool/app-client/MFA configuration, RDS connection
driver/IAM token generation, schema execution, initial Founder seeding,
provider revoke reconciliation (`P1-04`), local passwords, and any production
or staging data.

## Confirmed Policy And Invariants

- `OD-01` is resolved at policy level: a single HK-processed, DPA-reviewed
  transactional channel supplies an opaque delivery receipt; the secret is
  displayed once, is single-use, expires in 24 hours, and is never logged.
- The credential is `v1.<organization UUID>.<invite UUID>.<target User UUID>.<32-byte secret>`.
  Only the 32-byte entropy portion is hashed and retained. The UUID metadata
  constrains an unauthenticated lookup to the intended tenant/user row; it is
  not authorization evidence.
- A Founder may create an invite. The command creates no browser-visible raw
  secret; only the delivery-channel port receives it.
- Cognito user creation is fixed to `AdminCreateUser` semantics with
  `MessageAction: SUPPRESS`, an internal UUID username, and immutable
  organization/User custom attributes. Cognito's invitation messaging,
  SMS MFA, email MFA, self-registration, and self-service recovery stay out
  of scope.
- Claiming a valid credential transitions `created -> redeemed` before Managed
  Login. A failed Cognito journey requires a new, audited invite; there is no
  silent retry or second display of the same secret.
- The callback needs a PKCE state match and an HMAC-signed, short-lived pending
  activation cookie. It then accepts only a provider identity whose subject,
  organization, and User UUID match the redeemed invite and whose TOTP is
  verified by the managed-login adapter.
- A successful callback produces a 32-byte random HttpOnly/Secure opaque
  cookie. The cookie contains no User, email, organization, role, provider
  token, or invite value. Session policy remains 15-minute idle, 8-hour
  absolute, maximum three sessions, no implicit eviction, and five-minute
  sensitive reauthentication.

## Ownership And State

```text
Founder command
  -> Identity service: User + Membership + Invite facts (RDS adapter port)
  -> Cognito adapter: provision UUID username with SUPPRESS
  -> Delivery channel: one display + opaque delivery receipt
  -> Identity service: record receipt

Recipient activation credential
  -> Identity service: verify hash/tenant/target/expiry, mark Invite redeemed
  -> Cognito Managed Login: initial password and required TOTP
  -> Identity service: provider match + session fact
  -> Browser: opaque cookie only
```

The Identity module owns `User`, `Invite`, and `Session`. `access` owns the
Organization/Membership/Role facts that the repository must recheck. Route
Handlers only validate HTTP/cookies and map typed failures; they do not decide
roles or compose raw SQL.

`POST /api/v1/auth/invites` accepts only normalized email and an approved
internal role. It requires an `Idempotency-Key`, generates the target User UUID
server-side, requires a current Founder session with fresh TOTP, and returns
only invite UUIDs, expiry, and receipt metadata.

`identity_invite_delivery_receipts` is additive migration `009`. It records
only organization/invite UUIDs, `hk_dpa_reviewed_transactional`, a safe opaque
receipt reference, and timestamp. It has tenant RLS and no raw recipient,
activation secret, message body, or provider token column.

## Failure And Recovery Rules

| Boundary | Fail-closed behavior | Recovery owner |
| --- | --- | --- |
| Duplicate or replayed credential | No Cognito redirect/session; generic invalid invite result | Founder issues a new invite under policy |
| 24-hour expiry | Persist `expired`; no retry of original credential | Founder issues a new invite |
| Cognito provisioning failure | No delivery attempt; invite remains non-redeemable without provider link/receipt | Identity/Operations reconciliation in `P1-04` |
| Delivery failure | No browser copy; no receipt; invite remains non-redeemable | Founder revokes/reissues after reviewed failure evidence |
| Missing/invalid activation cookie or PKCE state | Callback rejects before identity/session action | Recipient restarts with a new invite if it was consumed |
| No TOTP proof or provider-attribute mismatch | No session | Identity owner investigates provider configuration; no local fallback |
| RDS/Cognito runtime composition absent | New `/api/v1/auth/**` returns/redirects to an unavailable state | Exact HK runtime payload and adapter installation |

## Deterministic Evidence

`tests/integration/identity-onboarding.test.ts` exercises the public
`IdentityService` seam with deterministic Cognito, delivery, clock, IDs, and
repository adapters. It proves:

1. Founder issuance emits `SUPPRESS`, gives the delivery port one credential,
   persists a policy-constrained receipt, returns no secret/email, and fixes a
   24-hour expiry.
2. A credential is claimable once; matching TOTP identity creates an opaque
   session with the approved actor/session version facts.
3. Missing TOTP and expired credentials are denied before session issuance.

The real RDS repository composition is intentionally not claimed as complete:
P1-02 provides the TLS/IAM/RLS contract but not a production PG client/IAM
token provider. `modules/identity/runtime.ts` therefore has no Neon/local
fallback and causes the HTTP adapters to fail closed until an exact, separately
approved HK runtime payload is composed. This is also why no live Cognito TOTP,
RDS policy, browser, PII-log scan, Terraform, lint, or build evidence is
claimed for this ticket.

## External Execution Gate

Before a real Founder invite or Cognito test, approve one payload containing:

- Cognito User Pool, app-client, managed-login domain, callback/logout URLs,
  passwordless/self-registration and TOTP-only settings, custom-attribute
  schema, IAM role/policy, DPA and audit/deletion/export evidence;
- named HK-processed DPA-reviewed transactional provider/channel, sender
  identity, exact recipient template fields, raw-secret handling, receipt
  format, retention, retry/idempotency and failure reconciliation rules;
- HK RDS endpoint/CA/IAM authentication and the reviewed migration `009`
  execution plan, including session-policy and cross-tenant negative tests.

No approval in this document authorizes any of those actions.
