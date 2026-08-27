# R1X-08 PlatformBilling Aggregate Overview

Status: local contract implementation complete; production integration pending  
Business authority: `txgj-doc/business-requirements/80-portal-billing.zh-CN.md` (`BR-061`, `BR-062`) and `70-notifications-audit.zh-CN.md` (`BR-071`)
Release boundary: source, focused tests, and local UI only; no production adapter, migration, deployment, or tenant activation

## Problem and scope

Platform operators need a quiet read-only overview for operational billing review without creating a cross-tenant case browser. This slice owns one GET route and one page. It does not implement contracts mutation, amount calculation, notices, receipts, exports, tenant drill-down, subscription enforcement, or second-tenant activation.

## Authorization and data invariants

- Authentication is a separate PlatformOperator identity. Tenant Founder or organization membership is never sufficient.
- The actor must be active and hold exactly one approved view role: `platform_admin`, `platform_finance`, or `platform_billing_approver`.
- The route consumes only a narrow PlatformBilling overview reader. It cannot query a database or import tenant modules.
- Returned organization facts are platform-owned aggregates: opaque organization ID, authorized operational name, lifecycle status, subscription status, count snapshot metadata, and opaque contract reference/status.
- Student, Guardian, case detail, notes, documents, contacts, exports, invoices, payable amounts, and contract monetary values are absent from the interface and response schema.
- Missing production platform auth or read adapters fail closed. The completed repository contract has no overview read method, so R1X-09 must install the local injectable dependency without bypassing the module boundary.

## Interface and error contract

`GET /api/v1/platform/billing/overview` returns:

- `200`: `{ generatedAt, organizations }`, with only the aggregate allowlist above.
- `401 PLATFORM_AUTHENTICATION_REQUIRED`: no separate PlatformOperator identity.
- `403 PLATFORM_BILLING_OVERVIEW_FORBIDDEN`: disabled actor or unapproved role.
- `503 BILLING_RUNTIME_UNAVAILABLE`: PlatformBilling read adapter is absent.
- `500 PLATFORM_BILLING_OVERVIEW_FAILED`: unexpected internal failure, without internal details.

Every response sets `Cache-Control: private, no-store, max-age=0` and `Pragma: no-cache`.

## Failure and UI states

The page has explicit loading, empty, denied, unavailable, generic error, and success states. It exposes no action controls, export link, tenant drill-down, notice workflow, amount, or activation affordance.

## Evidence plan

Focused Node tests must prove role and actor-state authorization, stable 401/403/503 responses, no-store headers, aggregate allowlisting, absence of forbidden keys, empty output, and presence of all UI states without prohibited controls. Browser/a11y/mobile evidence and the real platform identity/RDS reader remain R1X-09/R1X-10 gates.

## Local evidence

Command:

```text
node --test tests/integration/platform-billing-overview-route.test.ts \
  tests/unit/platform-billing-overview-page.test.ts
```

Result on 2026-08-13: 6 tests passed, 0 failed. The suite includes a maliciously widened reader result and verifies that the route rebuilds the response from its field allowlist rather than forwarding the extra audit, Student, or contract-value fields.

`git diff --check` passed for the owned files. Per repository policy, `pnpm lint` and `pnpm build` were not run.

## Residual integration gates

- R1X-09 must provide the independent PlatformOperator authentication adapter and the aggregate overview reader through the composition root. Until then, the default route returns typed `BILLING_RUNTIME_UNAVAILABLE` and exposes no fallback data.
- A real PostgreSQL/RDS contract test must prove the platform reader uses the platform role and cannot read tenant detail tables under connection reuse.
- R1X-10 must provide representative desktop/mobile browser, keyboard/focus, console/network, no-cache, and denied/unavailable-state evidence.
- No release may claim billing readiness until migration, deployment, rollback, audit, and human approval gates in the parent plan are complete.
