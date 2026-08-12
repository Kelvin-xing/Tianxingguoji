# P2-12 Future Scope Contract

| Control | Value |
| --- | --- |
| Ticket | `P2-12` Future AI/import/multi-tenant adapters remain disabled by contract |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_as_disabled_contract_only` |
| Decision inputs | `DEC-025`, `DEC-047`, `DEC-048`, `DEC-049`, `DEC-051` through `DEC-060`; `OD-14` |
| External state | No route, job, credential, data write, migration, cloud action, commit, push, or deployment was performed |

## Scope And Invariants

`modules/future/feature-contracts.ts` is an immutable Release 1 boundary for
non-K12 services, AI reports, data import, multi-tenant operation,
subscriptions, and retention/support workflows. Every listed feature has the
single `disabled_by_contract` state. Its only permitted surface is a visible
navigation placeholder; routes, jobs, credentials, and authoritative data
writes are prohibited.

The visible placeholders are limited to non-K12 services, AI reports,
Excel/CSV import, and multi-organization management. Each says
`正在開發中`, has no `href`, and has `aria-disabled="true"`. They are UI
signals only and cannot grant permission, expose a hidden implementation, or
change the existing authorization model.

No new route, job, provider configuration, environment lookup, credential,
database adapter, migration, persistence model, second organization, or
business workflow is introduced. `DEC-060` and `OD-14` remain guard-only:
recording future terminology does not infer subscription, retention, support,
or multi-tenant semantics for Release 1.

## Enforcement And Error Contract

The future-contract module owns its absence-of-surface rule. Any later
attempt to compose a future adapter must call
`assertFutureFeatureDisabled(featureId)`, which always throws
`FutureFeatureDisabledError` with code `FUTURE_FEATURE_DISABLED` and only the
safe details `{ featureId, release: "release_1", state:
"disabled_by_contract" }`.

This is a local contract error, not a public API response, because P2-12
creates no API surface. A later route must use the P0-03 envelope and map the
denial without leaking configuration, organization, provider, or data state.
The sidebar owns presentation only. It consumes the contract's placeholder
metadata but has no authorization or execution responsibility.

## Risks And Follow-on Gate

The repository contains legacy AI and knowledge pages outside this ticket's
ownership. P2-12 does not enable, alter, or rely on them. Before any future
feature is enabled, a separate post-Release-1 design decision must define the
business state model, authorized actor/context, schema/migration, provider
data boundary, audit/outbox behavior, error mapping, destructive-operation
policy, and negative isolation tests. That work must remove or replace the
disabled contract deliberately; it cannot be activated by changing navigation.

## Deterministic Evidence

`node --test --test-reporter=spec tests/architecture/future-scope.test.ts`
passed `4/4` tests:

1. Each declared future capability is terminally disabled and throws the
   stable local denial error.
2. Navigation exposes only the four approved placeholders, all marked
   `正在開發中`.
3. The contract contains no execution dependency, configuration lookup, or
   credential-shaped value.
4. The sidebar uses disabled placeholders rather than links.

`node --test --test-reporter=spec tests/architecture/module-boundaries.test.ts`
passed `6/6` tests, preserving existing ownership/import/write guard behavior.

`pnpm lint` and `pnpm build` were not run because repository instructions
prohibit them without separate authorization.
