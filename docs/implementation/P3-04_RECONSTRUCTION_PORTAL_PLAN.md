# P3-04 Reconstruction Portal Boundary

| Control | Value |
| --- | --- |
| Ticket | `P3-04` |
| Status | `implemented_local_slice` |
| Authority | `DEC-032`, `DEC-055`, `DEC-057`, `DEC-061`, `DEC-067` |
| Repository | `erp-frontend` |
| Release effect | None; feature remains disabled and runtime unavailable |

## Implemented boundary

- Collection create is `POST /api/v1/cases/reconstructions` with an opaque
  `pilot_reference` and required `Idempotency-Key`.
- The server-only `CASE_RECONSTRUCTION_ENABLED` flag is checked before session
  or runtime access. Any value other than the literal `true` returns the shared
  not-found envelope so disabled functionality does not disclose state.
- The HK runtime is a fail-closed seam. P3-08 must inject the transaction
  adapter; this slice has no in-memory, JSON, legacy-Neon, or local fallback.
- Method errors use the versioned envelope and explicit `Allow: POST`.
- Pre-activation pages live under `/cases/reconstructions/**`; no dashboard
  projection or operational case list is changed.

## Deferred

Item GET and action routes require the authorized reconstruction query/command
adapter from P3-08. The pages are deliberately thin until that adapter exists;
they do not read tables, create drafts locally, or infer actor authorization.

## Verification

```text
node --test --experimental-strip-types \
  tests/contract/case-reconstruction-route.test.ts \
  tests/architecture/module-boundaries.test.ts
```

No database, migration, cloud, lint, build, commit, push, or deployment action
was run. Runtime/UI release readiness remains `needs_human` pending P3-08 and
the approved feature flag/composition gate.
