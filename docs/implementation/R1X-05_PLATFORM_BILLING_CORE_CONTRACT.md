# R1X-05 PlatformBilling Core Contract

| Control | Value |
| --- | --- |
| Ticket | `R1X-05` pure-logic core only |
| Run ID | `R1X-05-PLATFORM-BILLING-CORE-20260813` |
| Date | 2026-08-13 (Asia/Hong_Kong) |
| Status | `implemented_local_contract`; runtime and production use remain unavailable |
| Authority | `R1X-DECISION-BASELINE-20260812`, DP-06 through DP-12, `DEC-060`, `DEC-064`, `DEC-066` |
| Git repository | `erp-frontend/` |

## 1. Outcome And Scope

This ticket establishes the smallest pure TypeScript boundary that lets later
PlatformBilling work consume PII-free case lifecycle facts, validate opaque
contract values, and apply the approved fail-closed policy. It gives Finance a
deterministic count contract without creating a price, payable amount, invoice,
notice, delivery receipt, or tenant access effect.

In scope:

- `advancing_case_count_v1` stage and Hong Kong month-cutoff policy;
- strict lifecycle projection event validation and distinct-case counting;
- immutable opaque contract-value validation and effective-period decisions;
- platform Finance/approver segregation and unconditional export denial;
- fail-closed subscription, retention, second-tenant, notice, and receipt policy;
- stable typed errors and focused pure-logic tests.

Out of scope: database schema or migrations, repositories, transactions, RLS,
routes, UI, fakes, adapters, runtime wiring, shared registries, package changes,
audit persistence, notice artifacts, delivery, cloud operations, and production
activation.

## 2. Domain Contract And Invariants

### DP-06: monthly count

`advancing_case_count_v1` counts each distinct active K12 ServiceCase once when
its latest accepted state at the cutoff is one of:

`background_collection`, `school_selection_confirmed`,
`interview_preparation`, `application_submitted`, `awaiting_result`, or
`offer_confirmed`.

`signed`, `closed`, and `pending_delete` contribute zero. Unknown states fail
closed. The cutoff is the final millisecond of the named calendar month in
`Asia/Hong_Kong`, represented as a UTC ISO instant. Events after the cutoff do
not affect the snapshot. `projectionComplete: false` blocks snapshot creation.

The event allowlist is exactly `eventId`, `organizationId`, `caseId`, `stage`,
`effectiveAt`, and `caseVersion`. Missing or malformed fields are rejected;
every extra field is rejected as potentially PII-bearing. An event from another
organization is rejected. No proration or amount is computed.

Cases owns lifecycle facts and event production. PlatformBilling owns event
validation, cutoff selection, latest-state reduction, and count policy.
Exact duplicate event IDs with identical payloads are idempotent. A reused
event ID with different facts, or different event IDs carrying conflicting
facts for the same case/version, fails closed with `BILLING_EVENT_CONFLICT`.
The accepted result is invariant under event permutation.

### DP-07: contract values and notices

`CustomerContractVersion.contractValueMinor` is a non-negative safe integer.
It is an opaque approved source value with no monthly-fee, per-case, tax,
subtotal, total, or payable meaning. Currency is a strict Release 1 ISO 4217
allowlist: `HKD`, `USD`, and `CNY`. Expanding this allowlist requires a reviewed
contract change; arbitrary three-letter strings are denied.

Contract identity, organization, source, creator, approver, approval time,
effective start, and record version are required. A version is frozen after
construction. Effective ranges must be valid and must not overlap existing
ranges; adjacent millisecond ranges are allowed. A future repository must
re-evaluate overlap under lock and enforce append-only versions atomically.
The approved-version constructor itself rejects equal creator and approver IDs,
so callers cannot bypass segregation by skipping the policy helper.

Payable calculation and notice generate/approve/deliver operations return
`BILLING_POLICY_UNAVAILABLE`. The contract contains no monetary-notice fields.

### DP-08: actor segregation

An active `platform_finance` actor may create contract source facts. Only an
active `platform_billing_approver` may activate a version, and the approver's
stable actor ID must differ from the creator's. `platform_admin`, tenant Founder,
organization users, disabled actors, and malformed identities are denied.
PlatformBilling export is always denied.

The future repository owns expected-version, idempotency, overlap, platform
identity freshness, mutation, and separate Platform Control audit in one
transaction. These pure decisions do not claim transaction or audit evidence.

### DP-09 through DP-12

- `past_due` produces only an aggregate `past_due` exception with
  `authorizationEffect: none`; Billing cannot mutate Access or tenant state.
- `suspended` and `terminated` remain unavailable.
- PlatformBilling records remain `retention_pending`; purge is denied.
- second-tenant activation remains unavailable and the existing single-active-
  organization guard remains authoritative.
- manual delivery receipt recording remains unavailable because DP-07 notice
  authority is not approved. No provider, notification, outbox, or send behavior
  exists in this ticket.

## 3. State And Error Contract

Reachable pure decisions are limited to count snapshot construction, contract
source validation, Finance draft permission, distinct-approver activation
permission, and active/past-due aggregate projection. This ticket does not make
any persisted state transition.

Stable error codes:

- contract/event input: `BILLING_CONTRACT_VALUE_INVALID`,
  `BILLING_CONTRACT_CURRENCY_INVALID`,
  `BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID`,
  `BILLING_CONTRACT_EFFECTIVE_PERIOD_OVERLAP`, `BILLING_EVENT_INCOMPLETE`,
  `BILLING_EVENT_PII_FORBIDDEN`, `BILLING_EVENT_STAGE_UNKNOWN`, `BILLING_EVENT_CONFLICT`,
  `BILLING_EVENT_CONTEXT_MISMATCH`, `BILLING_MONTH_INVALID`, and
  `BILLING_PROJECTION_INCOMPLETE`;
- authorization: `BILLING_COMMAND_DENIED`, `BILLING_SELF_APPROVAL_DENIED`, and
  `BILLING_EXPORT_DENIED`;
- unresolved policy: `BILLING_POLICY_UNAVAILABLE`,
  `BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE`,
  `BILLING_RETENTION_PENDING`, and `BILLING_SECOND_TENANT_UNAVAILABLE`.

`BillingContractError` carries one of these codes. Policy decisions use the same
typed code catalogue so later routes can map failures without parsing messages.

## 4. Risks And Release Boundary

The pure reducer assumes the supplied event set/checkpoint is complete when the
caller asserts `projectionComplete`. R1X-06 must establish durable ordering,
deduplication, rebuild checkpoints, correction revisions, and late-event
handling. R1X-05 does not prove those repository properties.

Concurrent contract activation could violate non-overlap if a future repository
uses this pure check without locking and a database constraint. Actor role and
status must also be re-read in that same platform transaction. Production must
fail closed until those owners, RLS, separate platform audit, and runtime
adapters exist.

No second tenant, payable amount, notice, manual receipt, purge, subscription
suspension/termination, export, migration execution, or production action is
authorized by this artifact.

## 5. Verification Evidence

Focused seam: public exports from `modules/platform-billing/contract.ts` and
`modules/platform-billing/policy.ts`.

Command:

```text
node --test tests/unit/platform-billing/contract-policy.test.ts
```

Result after the bounded counterexample correction: 8 tests passed, 0 failed.
Coverage includes exact-duplicate idempotency, same-ID and same-case/version
conflict rejection, permutation-stable rebuilds, and constructor-level
self-approval rejection in addition to the original contract and policy cases.

`pnpm lint` and `pnpm build` were not run, as prohibited by repository and task
instructions. No database, network, cloud, commit, push, or deployment command
was run.
