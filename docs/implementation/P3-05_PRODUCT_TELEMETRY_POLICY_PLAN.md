# P3-05 Product Telemetry Policy

| Control | Value |
| --- | --- |
| Ticket | `P3-05` |
| Status | `implemented_local` |
| Authority | `DEC-023`, `DEC-039`, `DEC-062`, AC-17, AC-27 |
| Repository | `erp-frontend` |
| Release effect | None; producer policy only, no sink/runtime wiring |

## Boundary

The product telemetry producer now has a closed, scalar-only contract owned by
`audit_operations` through `modules/operations`. It allows only route,
command, and job completion events. Unknown fields, nested values, PII-like
keys/values, query-bearing routes, and invalid context are rejected before any
adapter can receive an event.

Product telemetry is not authorization truth, business truth, audit evidence,
or a release gate. Audit remains a separate append-only transactional path and
is not disabled or substituted by this policy.

## Contract

- Schema: `product_telemetry_v1`; policy: `hk_privacy_telemetry_v1`.
- Exact fields are defined in `telemetry-contract.ts`; there is no metadata or
  tags escape hatch.
- Route templates are static `/api/v1/` paths with `[param]` placeholders;
  query strings, fragments, URLs, IDs, and percent escapes are rejected.
- User events require tenant/actor/session/route context; job events require an
  opaque job ID and have no user/session/route context.
- Successful results have no error code; denied/failed results require a
  stable uppercase error code.

## Retention

`schema/operations/product-telemetry-retention.v1.json` is a policy manifest,
not a sink or deletion worker. It fixes 30-day retention, `aws:ap-east-1`
residency, delete-after-retention disposition, and explicit-only legal hold
extensions. Sink, retry, degraded, and outage behavior remain P3-06.

## Verification

```text
node --test --experimental-strip-types \
  tests/unit/operations/telemetry-policy.test.ts \
  tests/privacy/telemetry-pii.test.ts
```

No cloud, database, migration, sink, lint, build, commit, or deployment action
was run. Production producer approval and HK sink composition remain deferred.
