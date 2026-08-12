# P1-16 Role-Aware Case Workspace

| Control | Value |
| --- | --- |
| Ticket | `P1-16` Case workspace completes the role-aware vertical journey |
| Date | 2026-08-07 (Asia/Hong_Kong) |
| Local status | `implemented_with_feature_gated_projection_shell` |
| Decision inputs | `DEC-041`, `DEC-055`; P1-03 through P1-15 contracts |
| External state | No RDS/AWS/Cognito action, migration, commit, push, deployment, or real case data access was performed |

## Scope And Boundary

The new route is `app/(erp)/cases/[caseId]/workspace`. It is disabled unless
`CASE_WORKSPACE_ENABLED=true`, so it cannot replace legacy case pages by
accident. The route verifies a session, rejects contractor case access, and
returns a versioned safe unavailable state until a future HK RDS composition
provides an authorized workspace projection. It has no local JSON, legacy page,
or synthetic runtime fallback.

`CaseWorkspace` renders only a serializable projection produced outside the
browser. It provides URL-backed `overview`, `assessment`, `schools`, `tasks`,
`documents`, and `timeline` tabs. The client filters only the projection's
explicit `visible` flag. It does not infer role, collaborator scope, expiry,
capability, document access, or counts.

The sole visual fixture route is `/cases/__fixtures/workspace`. It requires
both `NODE_ENV=development` and
`NEXT_PUBLIC_CASE_WORKSPACE_VISUAL_FIXTURE=true`; it is not a production
read-model or command fallback.

Out of scope: an aggregate database read model, permission policy evaluation,
domain writes, task/case/document controls beyond rendering permitted
descriptors, contractor case disclosure, P1-17 negative testing, and P1-18
staging evidence.

## UI Contract

| State | Shell behavior |
| --- | --- |
| Loading | Fixed-height panel skeleton with `aria-busy`; no stale data is invented. |
| Ready | Compact header, URL-backed tab strip, and one active operational panel. Overview exposes only projected stage/blocker/next-action data. |
| Empty | Shows an authorized zero-result state and only a projected permitted action. |
| Denied | Shows no counts, resource names, or cached restricted content. |
| Error | Uses a safe detail, request reference, and explicit retry link. |
| Stale conflict | Keeps the local draft, presents current/draft summaries, and requires an explicit use-current, keep-draft, or retry action. |

The tab list uses native links with tab semantics. Left/Right/Home/End change
focus only; Enter/Space follows the selected URL. Tab activation scrolls the
selected control into view and moves focus to the active panel heading. Core
targets are at least 44px, status uses text plus icon, and mobile uses a
one-column panel with a horizontally scrollable tab strip.

## Enforcement Ownership

| Invariant | Owner |
| --- | --- |
| Actor role, case visibility, collaborator scope/capability/expiry | Identity and Access RDS transaction/read adapters |
| Assessment schema/value/conflict | CaseWorkflow P1-07 service |
| Pinned schools and stale target state | SchoolIntelligence/CaseWorkflow P1-09 service |
| Document scan/version availability | Document P1-10 through P1-12 services |
| Task authority and completion/approval separation | Task P1-13 service |
| Case blocker/transition guards | CaseWorkflow P1-14 service |
| Notification delivery/receipt | Notification P1-15 worker |
| Panel visibility, focus, rendering, and safe state presentation | P1-16 workspace shell only |

## Deterministic Evidence

- `node --test --test-reporter=tap tests/unit/case-workspace-model.test.ts tests/architecture/module-boundaries.test.ts`: `11` pass, `0` fail.
- The workspace model accepts only declared tabs, falls back from hidden/invalid
  tabs to the first server-visible surface, leaves an all-denied projection
  without a visible tab, preserves URL state, and bounds keyboard movement to
  projected tabs.
- `git diff --check`: pass.

The local environment contains no configured Playwright/jsdom/browser test
runner. A `next dev --webpack -p 3007` smoke attempt remained non-listening
for 60 seconds and was stopped; `curl` confirmed that the port was unavailable.
`tsc --noEmit` also emitted no diagnostics or completion within 60 seconds and
was stopped. Neither browser screenshots nor a full type-check pass is claimed.
`pnpm lint` and `pnpm build` remain unrun under `AGENTS.md`.

## External Enablement Gate

Before enabling `CASE_WORKSPACE_ENABLED`, an approved HK RDS workspace
projection must compose current authorization and the owning module reads
without a broad case-data payload. It must test revoke/expiry after initial
render, reauthorization on tab/action navigation, P0-03 envelopes, contractor
redaction, and all named browser/a11y sizes from `AC-15`/`AC-16`. Browser
automation and screenshot evidence must be added before release acceptance.
