# Module and Layer Map

## Purpose

This document records the code-version-bound module boundaries for the
Tianxingguoji modular monolith. Product scope and cross-version architecture
decisions remain in `txgj-doc`.

## Dependency Direction

Each business module uses the same inward dependency direction:

```text
app / components / workers
        |
        v
public.ts / client.ts / web.ts / server.ts
        |
        +--> domain
        +--> application --> domain
        +--> infrastructure --> application --> domain
```

| Layer | Responsibility | Allowed same-module dependencies |
|---|---|---|
| `domain/` | Contracts, value types, policies, and pure decisions | `domain/` only |
| `application/` | Use cases, orchestration, and repository ports | `application/`, `domain/` |
| `infrastructure/` | PostgreSQL, AWS/provider adapters, runtime composition, route integration, and legacy compatibility | all inward layers |

Cross-module imports must use a declared module entrypoint. Direct imports of
another module's `domain/`, `application/`, or `infrastructure/` files are not
allowed.

## Entrypoints

| Entrypoint | Consumer | Contents |
|---|---|---|
| `public.ts` | Browser and server code | Runtime-neutral contracts and domain rules |
| `server.ts` | Server code only | Application services and infrastructure composition |
| `client.ts` | Browser code only | Explicit browser adapters or preview fixtures |
| `web.ts` | Next.js server web adapters | Cookie/header-aware Identity helpers |
| `crawler-server.ts` | Legacy crawler Route Handlers | Crawler database and snapshot adapters, isolated from core Schools runtime |

Every `server.ts` entrypoint imports `server-only`. Browser code must not import
it. Tests may import internal files directly when they intentionally verify one
layer or adapter.

## Module Ownership

| Module | Owns | Notable entrypoints |
|---|---|---|
| `shared` | Shared idempotency and request contracts | `public.ts`, `server.ts` |
| `identity` | User, session, and invite | `public.ts`, `server.ts`, `web.ts` |
| `access` | Organization membership, roles, grants, and collaborators | `public.ts`, `server.ts` |
| `crm` | Student, guardian, relationships, and merge revisions | `public.ts`, `server.ts`, `client.ts` |
| `cases` | ServiceCase, assessment, school targets, outcomes, and reconstruction | `public.ts`, `server.ts` |
| `tasks` | Task and assignment workflow | `public.ts`, `server.ts` |
| `schools` | School snapshot, overlays, change requests, and resolved views | `public.ts`, `server.ts`, `client.ts`, `crawler-server.ts` |
| `documents` | Document, version, scan result, and object-store policy | `public.ts`, `server.ts` |
| `notifications` | Notification and delivery receipt | `public.ts`, `server.ts` |
| `audit` + `operations` | Audit/outbox plus operational projections, alerts, and telemetry | each exposes `public.ts` and `server.ts`; one registry ownership group |
| `external-portal` | Portal viewer, grant, and session | `public.ts`, `server.ts` |
| `platform-billing` | Advancing-case metrics and opaque contract references | `public.ts`, `server.ts` |
| `future` | Frozen post-Release-1 contracts only; no Release 1 runtime routes or persistence adapters | `public.ts`, `server.ts` |

The authoritative resource list and accepted cross-module entrypoints are in
`modules/shared/architecture/module-registry.ts`.

## Framework and Compatibility Boundaries

- `app/` contains Next.js pages and Route Handlers. It is an adapter layer, not
  a domain module.
- `components/` contains UI adapters. Components may consume `public.ts`,
  `client.ts`, or server entrypoints only when they are Server Components.
- `workers/` contains asynchronous adapter entrypoints and delegates to module
  services and runtimes.
- `lib/` is restricted to technical framework utilities: the HTTP client,
  i18n provider, and local runtime configuration/readiness helpers.
- `types/index.ts` remains a transitional frontend/crawler type collection. It
  should be split by ownership only when each consumer is migrated.
- Legacy `/api/cases` and crawler routes remain compatibility surfaces. They
  are governed by the same entrypoint rules but are not the target Release 1
  API design.
- The crawler database adapter still performs legacy runtime schema setup. It
  must move to append-only migrations before crawler persistence becomes a
  supported Release 1 runtime.
- Knowledge/AI is outside Release 1. Only runtime-neutral disabled contracts
  and navigation-placeholder metadata remain under `modules/future`; Release 1
  has no AI/Knowledge page, Route Handler, job, credential, data write, or
  persistence adapter. Historical UI and adapter source remains recoverable
  from Git history rather than from an active runtime path.
- Preview and synthetic fixtures remain explicit client/server adapters until
  real local runtimes replace each consumer.

## Automated Enforcement

`tests/architecture/module-boundaries.test.ts` verifies:

- registration of all source files under `modules/`, `app/`, `components/`,
  and `workers/`;
- cross-module imports use declared entrypoints;
- `domain/` and `application/` dependency direction;
- public/server entrypoint presence and server-only markers;
- SQL write ownership;
- the exact technical allowlist remaining under `lib/`;
- no source files remain under the former top-level `adapters/` directory;
- Future features have no runtime routes or persistence adapters.
