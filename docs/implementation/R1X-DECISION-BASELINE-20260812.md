# R1X Portal/Billing Decision Baseline

| Control | Value |
| --- | --- |
| Artifact | `R1X-DECISION-BASELINE-20260812` |
| Date | 2026-08-12 (Asia/Hong_Kong) |
| Status | `implementation_baseline_selected`; human gates below remain binding |
| Scope | `DP-01` through `DP-12` for Release 1 bounded External Portal and aggregate-only PlatformBilling |
| Authority | `DEC-060`, `DEC-064`, `DEC-065`, `DEC-066`; current implementation/production plans and existing module contracts/tests |
| Model / effort | `gpt-5.6-sol`; medium reasoning |
| Permitted consequence | Local contracts, tests, additive unused migrations, and feature-off implementation may use the selected baselines in dependency order |
| Not authorized | Migration execution, production data/resource changes, first use, notice delivery, second-tenant activation, commit, push, deploy, or amendment of an authority document |

## 1. Decision Contract

This record selects the smallest reversible Release 1 implementation behavior needed to stop open semantics from leaking into schema defaults, UI behavior, or runtime guesses. It does **not** amend the decision ledger and does not close `DEC-060`. Where legal, privacy, finance, product, or operational authority is absent, the implementation baseline is fail closed and the human gate remains.

The implementation must preserve these cross-cutting invariants:

- `ExternalPortalAccess` owns PortalViewer, PortalAccessGrant, PortalSession, secret/session policy, field allowlist, and request-time portal authorization. Internal case and relationship facts remain owned by Cases and CRM and are consumed only through public module interfaces or an owning transactional repository.
- `DEC-065` remains exact: pre-tenant secret discovery uses only the hardened function-only `portal_auth` capability; full authorization occurs in a later tenant-scoped transaction. Raw keys are never persisted, logged, placed in URLs, telemetry, screenshots, or evidence.
- `PlatformBilling` owns aggregate contract/metric/notice state and reads only PII-free Cases projection events. It does not query tenant detail tables or grant PlatformOperator tenant membership.
- `DEC-066` remains exact: platform mutations and separate append-only Platform Control audit commit atomically and fail closed; tenant audit invariants are not weakened.
- All mutable commands use expected version, idempotency, stable typed errors, and transaction-bound audit. Production runtime has no mock, local, Neon, or cross-plane fallback.
- Portal reads are `private, no-store`; every read rechecks current grant, session, relationship, case, organization, capability version, and time. New fields are denied until an approved allowlist version explicitly adds them.

`RTK.md` was requested as an input but is absent from the workspace. No semantics are inferred from it. If restored content conflicts with this record, the affected baseline returns to `needs_human` until reconciled.

## 2. Portal Decisions

### DP-01: Portal Grant Issuer And Revoker

**Selected baseline.** An active Founder in the same organization or the case's current active Primary Advisor may issue, rotate, list metadata for, or revoke a grant. No other Advisor, collaborator, contractor, PlatformOperator, or external viewer may do so. Founder authority is organization-scoped, not cross-tenant global authority.

**Rationale.** This matches the existing Access repository seam, avoids a new delegation model, and keeps authorization close to current case ownership. It is more restrictive than “any Advisor” and reversible by a later policy version.

**Business/security/data invariants.** The actor, active membership/role, case organization, current Primary Advisor assignment, active case, target viewer relationship, expected version, and idempotency record are read and the grant/audit/outbox mutation is committed in one repository transaction. Browser role claims are never authoritative. There is no absent-Primary-Advisor, break-glass, or bulk-grant path.

**State consequence.** Authorized issue creates `active` or `pending_approval` under the selected scope policy; rotate atomically creates a new grant and revokes the old grant and all its sessions; revoke transitions only an effective grant to `revoked` and denies immediately.

**Enforcement owner.** `ExternalPortalAccess` policy/interface; Access and Cases provide current actor/case facts through public interfaces; the production Portal repository owns the transaction.

**Deterministic evidence.** Founder/current-Primary-Advisor allow cases; former/wrong-case/disabled/non-Advisor/cross-tenant denies; concurrent reassignment and revoke tests; one-transaction audit/idempotency failure injection; route bypass and ID-guessing negatives.

**Approval gate.** Product and Security review remains before feature enablement; Founder exact-payload go/no-go remains before the first real grant.

### DP-02: Grant Duration

**Selected baseline.** `expires_at` is required, must be later than issue time, and may be at most **7 days** after issue and no later than the case's permitted access horizon. Renewal or extension creates a new grant; no in-place expiry extension exists.

**Rationale.** Seven days is already the repository's accepted collaborator maximum (`DEC-029`) and implemented Access policy. Reusing that tested bound is safer than introducing the plan's unapproved 90-day bearer credential.

**Business/security/data invariants.** Server time is authoritative; expiry is stored as an absolute UTC instant; null, past, overflow, over-maximum, and case-horizon violations fail closed. Expiry is evaluated with `now >= expires_at`; configuration may reduce but not exceed the policy maximum.

**State consequence.** `active -> expired` is an effective request-time transition; all sessions derived from an expired grant are denied. Renewal is `new grant + old grant revoked/expired`, preserving history.

**Enforcement owner.** `ExternalPortalAccess` policy plus database check constraints; repository validates the case horizon in the issue transaction.

**Deterministic evidence.** Exact 7-day boundary, one millisecond over, past/null/unsafe timestamps, case-horizon clipping/denial, clock-boundary read, and no-silent-renewal tests.

**Approval gate.** Security approval remains for policy/config review; Product approval is required to increase the maximum. First real grant remains Founder-gated.

### DP-03: Automatic Denial And Revocation Conditions

**Selected baseline.** Portal access is allowed only while all of the following remain effective: grant and session active/unexpired, viewer relationship active, case neither `closed` nor `pending_delete` nor any later approved ended/cancelled state, issuer still active and still authorized under DP-01, and organization active. Any failed predicate denies immediately. `past_due` has no effect in Release 1; `suspended`/`terminated` are not inferred and remain unavailable under DP-09/`DEC-060`.

**Rationale.** Closing access on loss of purpose is the least-disclosure baseline. Treating `past_due` as authorization would invent debt-enforcement semantics and risk locking customers out of their data.

**Business/security/data invariants.** Request-time checks, not stale cookie claims or asynchronous cleanup, enforce denial. Automatic cleanup may persist `expired`/`revoked` later but cannot be required for denial. Case reopen does not reactivate an old grant. Legal hold preserves records, not access.

**State consequence.** Effective access becomes denied immediately; persisted `active -> revoked/expired` may follow idempotently. Reopen, relationship restoration, issuer reactivation, or organization reactivation requires a new grant.

**Enforcement owner.** `ExternalPortalAccess` request-time policy; Cases, CRM, Identity/Access provide authoritative current facts; repository composes them in one tenant-scoped read transaction.

**Deterministic evidence.** Closed/pending-delete case, inactive relationship, issuer disable/reassignment, organization disable, revoke/expiry race, reopen/non-reactivation, and `past_due` no-effect tests; direct route and cache negatives.

**Approval gate.** Product and Legal must approve any future closed-case visibility. Founder/Product/Legal approval remains for cancellation/reopen semantics. DP-09 gates subscription effects.

### DP-04: Portal Visible Data

**Selected baseline.** Capability set `portal_case_read_v1` exposes only: case number; approved customer-facing case stage; last customer-visible update time; approved customer-visible SchoolTarget name/status; customer action-item title, deadline, and completion status; and messages explicitly marked `customer_visible`. Documents and downloads are denied, as are assessment answers, contacts, internal notes, audit, collaborators, Advisor private data, pricing, contract, export, comments, edits, and deletes.

**Rationale.** A versioned positive allowlist gives the smallest useful read-only surface and prevents new source fields from becoming visible by DTO drift.

**Business/security/data invariants.** Projection constructors select named fields rather than serialize domain objects. Each grant pins a capability-set version; a later version does not widen old grants. One grant covers exactly one viewer, one organization, and one case; no sibling or related-case expansion.

**State consequence.** Grant issue pins `portal_case_read_v1`; removed or newly unapproved fields disappear from subsequent reads without changing source facts. Adding data requires a new approved capability version and new grant.

**Enforcement owner.** `ExternalPortalAccess` visible-field policy and DTO builder; source modules own `customer_visible` facts.

**Deterministic evidence.** Snapshot tests for the exact keys; unknown-field/default-deny tests; documents/download/export/direct-source-route denial; cross-case/sibling tests; cache and serialized-response PII scans.

**Approval gate.** Product and Privacy approval remains for the v1 field catalogue and every later expansion; Legal approval remains where customer-facing wording or disclosure basis requires it.

### DP-05: Redemption And Portal Sessions

**Selected baseline.** A raw key may be redeemed more than once until revoked/expired, but each grant permits at most **3 active sessions**, matching the existing bounded internal session baseline. Sessions use a 15-minute idle timeout and an absolute expiry of the earlier of 8 hours or grant expiry. No second factor is added in Release 1 because the selected scope excludes documents and other high-sensitivity data; adding such scope remains blocked.

**Rationale.** Bounded repeat redemption supports normal multi-device use without inventing external identity recovery or MFA. Reusing existing session bounds is smaller and testable.

**Business/security/data invariants.** Each redemption creates a distinct opaque session secret/hash; it never reuses the raw grant key as a cookie. The fourth active redemption fails closed. Revocation/rotation/expiry invalidates all sessions immediately. Public invalid/expired/revoked responses have one constant-shape `401`; rate limiting does not reveal grant existence.

**State consequence.** `grant active + slot available -> session active`; session transitions to `revoked` or `expired`; no session refresh may exceed grant expiry. Logout revokes only the current session; grant revoke revokes all.

**Enforcement owner.** `ExternalPortalAccess` session policy/repository; `portal_auth` owns only pre-tenant discovery under `DEC-065`; the tenant-scoped Portal repository owns full authorization.

**Deterministic evidence.** Redeem/replay for slots 1-3, fourth denial, idle/absolute/grant boundary, logout versus grant revoke, generic error equivalence, keyed-hash/no-plaintext, rate-limit, cookie separation, and concurrent slot-allocation tests.

**Approval gate.** Security and Privacy approval remains before enablement. Product/Security/Privacy approval is required before any higher-sensitivity scope or second-factor policy is introduced.

## 3. Billing And Subscription Decisions

### DP-06: Advancing-Case Metric And Pricing

**Selected baseline.** Release 1 implements a versioned **count-only** monthly metric, not a charge formula. `advancing_case_count_v1` counts distinct active K12 ServiceCases whose cutoff state is one of `background_collection`, `school_selection_confirmed`, `interview_preparation`, `application_submitted`, `awaiting_result`, or `offer_confirmed`. `signed`, `closed`, `pending_delete`, and any unknown/unapproved pause/cancel state are excluded. The cutoff is the last instant of the calendar month in `Asia/Hong_Kong`; one case contributes 0 or 1, with no proration. No amount is generated from the count.

**Rationale.** The count can be reconstructed from accepted case states without inventing price, partial-month, pause, cancellation, or revenue semantics. It gives Finance useful deterministic evidence while failing closed on money.

**Business/security/data invariants.** Cases emits only organization ID, case ID, approved state, effective timestamp, event/version, and no PII. PlatformBilling snapshots a closed cutoff and pinned projection/policy version. Late/corrective events rebuild or create a new revision; they never silently rewrite an approved snapshot. Unknown states and incomplete projections block close.

**State consequence.** `open metric period -> closed count snapshot`; no `charge notice draft` transition is enabled by this DP alone. A corrected count supersedes by revision after review.

**Enforcement owner.** Cases owns lifecycle facts and PII-free projection events; PlatformBilling owns projection, cutoff policy, snapshot, and rebuild checkpoint.

**Deterministic evidence.** One test per included/excluded state; cutoff before/at/after boundaries and HK timezone; duplicate/out-of-order/late events; rebuild equivalence; unknown-state and incomplete-checkpoint denial; PII-schema rejection.

**Approval gate.** Finance and Product approval remains for any monetary formula, proration, pause/cancel treatment, or use of the count for charging. Data/Finance review remains for projection activation.

### DP-07: Contract Amount And Notice Legal Position

**Selected baseline.** Store immutable contract versions as approved source facts using integer minor units and ISO 4217 currency, but treat `contract_value_minor` as an opaque **reference contract value**, not a monthly fee, per-case rate, tax base, or calculable charge. Release 1 may create an internal `calculation_unavailable` preview containing pinned contract/count references and no payable amount. It must not create, number, label, render, approve, or deliver an invoice or charge notice.

**Rationale.** The legal/commercial meaning of the amount is unresolved. Preserving source facts while blocking calculation avoids inventing revenue, tax, rounding, or payment obligations and remains reversible.

**Business/security/data invariants.** Contract versions are append-only, effective periods do not overlap, amount uses non-negative integer minor units, currency is explicit, and source/approver/effective dates are required. `tax_minor`, subtotal, total, due date, invoice/notice number, and payable status are absent or unavailable until approved policy exists.

**State consequence.** Contract may transition `draft -> active -> superseded/terminated` only under DP-08. Billing period may close counts, but monetary notice state remains `unavailable`; no draft/approved/delivered state is reachable.

**Enforcement owner.** `PlatformBilling` contract policy/repository and schema constraints; Finance owns source approval; platform audit records mutations under `DEC-066`.

**Deterministic evidence.** Integer/currency/effective-range/overlap tests; forbidden monetary fields and terms; `BILLING_POLICY_UNAVAILABLE` for calculation/generate/approve/deliver; no PDF/outbox/delivery artifact; audit rollback tests.

**Approval gate.** Founder, Product, Legal, and Finance approval remains to define contract value meaning, pricing formula, currency/rounding/tax treatment, document title/numbering, and legal status. No first notice can be generated before that gate.

### DP-08: Billing Actor Segregation

**Selected baseline.** `platform_finance` may create a contract draft and a non-monetary monthly review preview. A distinct `platform_billing_approver` may activate/supersede/terminate a contract version. The creator and approver must be different stable platform actors. `platform_admin`, Founder acting only as tenant Founder, and organization users cannot mutate PlatformBilling. Generate/approve/send notice commands remain unavailable under DP-07/DP-12.

**Rationale.** Dual control is the smallest credible platform-control baseline and matches reconstruction's existing distinct-reviewer pattern. It avoids giving tenant or platform administration implicit finance authority.

**Business/security/data invariants.** Platform identity is separate from OrganizationMembership. Role, actor status, expected version, non-self-approval, contract period, idempotency, and platform audit are verified in one platform transaction. Neither role may query tenant detail or export PII.

**State consequence.** `contract draft -> active` only by a distinct approver; correction creates a new draft and later supersedes the prior version atomically. Notice workflow remains unavailable.

**Enforcement owner.** `PlatformBilling` policy/repository; platform identity adapter supplies actor facts; separate Platform Control audit owns append-only evidence.

**Deterministic evidence.** Role matrix, self-approval denial, tenant-Founder denial, disabled actor, stale/concurrent approval, atomic supersede/audit failure, no tenant-detail query, and export-denied tests.

**Approval gate.** Founder and Finance must approve named role holders and first contract activation. Legal/Product/Finance remain required before notice generation; Operations approval remains before enabling platform runtime.

### DP-09: Subscription-State Effects

**Selected baseline.** Subscription status is informational only in Release 1. `past_due` causes an aggregate-only PlatformBilling exception and **no** CRM, Portal, document, task, login, or export authorization change. `suspended` and `terminated` transitions and their effects are unavailable and fail closed until `DEC-060` is amended. Billing code must not write tenant authorization state.

**Rationale.** Debt collection must not be smuggled into access control. Keeping subscription and authorization separate prevents accidental data lockout and preserves a reversible policy seam.

**Business/security/data invariants.** PlatformBilling cannot mutate Access/Identity/Cases tables. Existing security/lifecycle denials still apply independently. No browser-provided or platform projection status is accepted as an authorization fact. `past_due` contains no tenant PII.

**State consequence.** `active -> past_due` changes only the billing exception projection. No `suspended`/`terminated` command is accepted and no access state transition follows.

**Enforcement owner.** PlatformBilling owns status projection; Access/Identity/Portal/Cases remain sole authorization owners; shared module ownership checks prevent cross-module writes.

**Deterministic evidence.** `past_due` no-effect matrix across login/CRM/Portal/documents/tasks/export; cross-module write rejection; suspended/terminated typed unavailable errors; no hidden UI lockout.

**Approval gate.** Founder, Product, Legal, Finance, Privacy, and Operations approval remains for suspension, termination, export, recovery, and customer-notice semantics. `DEC-060` remains open and blocks second-tenant activation.

### DP-10: Retention And Data-Subject Handling

**Selected baseline.** No purge is enabled for Portal or PlatformBilling records. Store only minimum metadata; clear grant/session secret hashes when no longer needed for authentication, while retaining non-secret immutable identifiers/status/timestamps needed for authorization and audit linkage. Revoked/expired sessions are ineligible immediately. Contracts, metric snapshots, previews, grants, and sessions remain under `retention_pending` with legal hold honored; backup expiry follows infrastructure policy but is not claimed as record purge.

**Rationale.** Deleting too early may violate legal/audit needs; retaining plaintext or usable credentials is unnecessary risk. A no-purge, no-usable-secret baseline is conservative and reversible once classification schedules are approved.

**Business/security/data invariants.** Raw secrets never persist. Purge jobs/routes/credentials are absent or disabled. Data-subject requests create a review case and must not directly delete records. Audit remains one year under `DEC-039`; legal hold blocks purge; tombstones contain no PII. Portal workspace data remains owned and handled by source modules, not copied into Portal retention stores.

**State consequence.** `active -> revoked/expired` denies use; authentication material becomes unusable/cleared through a bounded cleanup policy, but metadata remains `retention_pending`. Contract and notice-related records may be superseded/voided but not erased.

**Enforcement owner.** Privacy/Legal own classification schedules; Portal and PlatformBilling own minimization/disabled purge; AuditOperations owns audit retention; Operations owns approved cleanup execution.

**Deterministic evidence.** No-plaintext/no-workspace-copy tests; revoked/expired denial after hash clearing; legal-hold and purge-disabled tests; data-subject request produces review-only state; backup/audit separation; PII scan of metadata.

**Approval gate.** Legal and Privacy approval remains for every retention class, secret-hash cleanup interval, data-subject response, legal basis, purge schedule, and backup expiry. Founder/Operations exact-payload approval remains for any purge execution.

### DP-11: Second-Tenant Activation

**Selected baseline.** The existing single-active-organization database guard remains. A second active CustomerOrganization cannot be created or activated. Schema capability, PlatformBilling UI, RLS tests, or an empty tenant do not constitute activation authority.

**Rationale.** This is the smallest and most reversible interpretation of `DEC-060` and existing migration source. Removing the guard before commercial exit semantics are approved would make an architectural capability an unauthorized launch.

**Business/security/data invariants.** Migration `014` is not authored/executed under this baseline. Second-tenant activation additionally requires approved DP-09/DP-10 semantics, support grants, retention/legal hold/termination/export, RLS and pool-reuse negatives, S3/cache/search/job isolation, restore/reconciliation, budget/support ownership, and an exact cohort payload.

**State consequence.** `candidate organization -> active` is denied whenever another active organization exists. The only production state remains the separately approved first organization/empty-pilot state.

**Enforcement owner.** Access/Data own the unique active-organization guard; Security validates isolation; Release/Operations own activation gates.

**Deterministic evidence.** Constraint test against two active organizations; cross-tenant API/DB/S3/job/cache/search/export negatives; restore and support-access evidence manifest; exact go/no-go receipt verification.

**Approval gate.** Founder, Product, Legal, Privacy, Finance, Operations, Security, and Data approval remains. `DEC-060` must be amended and a separate exact-payload go/no-go must name the second organization before activation.

### DP-12: Manual Delivery And Receipt

**Selected baseline.** The platform does not send or orchestrate external delivery. After DP-07 is legally/commercially approved, an authorized Finance actor may manually mark an already approved artifact as delivered outside the platform by recording only an opaque receipt: artifact ID/revision, approved channel policy code, delivered-at timestamp, recorder platform actor, and idempotency key. No recipient address, message body, attachment, provider ID, or raw communication is stored. Until DP-07 is approved, even this receipt command is unavailable.

**Rationale.** This preserves Release 1's no-external-notification boundary while leaving a minimal audit point for a human process. It does not imply that a channel or message is lawful or approved.

**Business/security/data invariants.** Only an approved artifact revision may receive one current successful receipt; corrections require a new artifact revision and receipt. The platform has no email/SMS/WhatsApp credentials, outbox event, retry worker, or send button. A receipt is evidence supplied by a human, not proof of recipient receipt.

**State consequence.** Once all upstream gates pass, `approved -> delivery_recorded` records evidence only; it does not change payment, debt, subscription, or authorization state. Before then, delivery remains `unavailable`.

**Enforcement owner.** `PlatformBilling` owns receipt metadata and authorization; Finance owns the external act; separate Platform Control audit records the command. Notification module is not used.

**Deterministic evidence.** No-provider/no-credential/no-outbox inventory; unavailable-before-DP-07 test; approved-revision-only, duplicate/idempotency, correction/new-receipt, safe-field allowlist, and no subscription side-effect tests.

**Approval gate.** Founder, Legal, Privacy, Finance, and Operations must approve the exact channel policy and first delivery payload. Automated delivery remains out of Release 1 and requires a new decision plus provider/DPA/residency/retention approval.

## 4. Consequences And Remaining Gates

These baselines unblock local dependency work as follows:

- `R1X-01` may implement Portal contracts, policy, fakes, focused tests, and an additive unused migration against DP-01 through DP-05 and the fail-closed DP-10 retention state.
- `R1X-05` may implement Platform actor/contract/count-projection contracts, fakes, focused tests, and additive unused migrations. Monetary notice generation remains unavailable under DP-07; delivery remains unavailable under DP-12.
- `R1X-09` may implement production adapters only with DP-09's no-subscription-enforcement rule and DP-10's purge-disabled rule. Runtime feature wiring and production use remain separately gated.
- `R1X-11` remains blocked from second-tenant activation by DP-11 and open `DEC-060`. First Portal grant and first future charge-notice/delivery each retain their own exact-payload human go/no-go.

Unresolved human approval gates:

| Owner | Remaining approval |
| --- | --- |
| Founder | First real Portal grant; named platform finance roles; first contract activation; any first notice/delivery; second tenant; any purge or production action |
| Product | Portal v1 field catalogue; closed/cancelled case visibility; any price/proration/subscription access effect; notice semantics |
| Legal | Customer-facing disclosure basis; closed-case access; contract/notice/tax/legal position; suspension/termination/export; retention and delivery channel |
| Privacy | Portal field catalogue; session/metadata minimization; retention/data-subject handling; delivery channel/data flow; second tenant |
| Finance | Contract source/meaning; count-to-price formula; currency/rounding/tax; role holders; first notice/delivery; subscription effects |
| Operations | Runtime enablement, cleanup schedule, delivery procedure, support/restore/rollback evidence, second-tenant go/no-go |
| Security/Data | Portal/session policy and transaction/RLS evidence; platform-role isolation; migrations/adapters; cross-tenant and restore evidence |

## 5. Deterministic Acceptance For This Record

This documentation decision is complete only when:

1. every `DP-01` through `DP-12` appears exactly once with baseline, rationale, invariants, state consequence, enforcement owner, deterministic evidence, and approval gate;
2. Markdown headings, code spans, and table widths are structurally valid;
3. `DEC-060`, `DEC-064`, `DEC-065`, and `DEC-066` are preserved without contradiction;
4. the only repository content change is this new artifact;
5. no lint/build, migration, cloud/provider, network, data, release, commit, or push action is performed.
