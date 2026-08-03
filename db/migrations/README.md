# Release 1 Schema Migrations

This directory is the ordered, immutable SQL source for Release 1 PostgreSQL schema changes. `P0-04` selects `node-pg-migrate@9.0.0` as the runner and keeps checksum and schema-drift enforcement in the local planner. This selection does not authorize a database connection or migration execution.

## Selection Scorecard

| Gate | Result | Enforcement |
| --- | --- | --- |
| PostgreSQL/RDS and SQL-first | Pass | `node-pg-migrate` SQL loader; migrations remain plain `.sql`. |
| Immutable ordered checksums and concurrent lock | Pass with harness | `scripts/db/plan-migration.ts` verifies ordered SHA-256 ledger entries; the selected runner supports advisory locking and policy requires fail-fast mode. |
| Dry-run/plan and transaction/timeout controls | Pass | Planner is read-only; runner policy requires dry-run by default, one transaction, 5-second statement timeout and 5-second lock timeout. |
| Empty/prior-schema drift detection | Pass | Synthetic snapshots classify bootstrap, N-1, schema drift and checksum mutation as pass/warn/fail. |
| Separate migration/application roles | Pass | Migration tooling accepts only `MIGRATION_DATABASE_URL`; application `DATABASE_URL` is not a fallback. |
| Pinned clean-container pnpm execution | Pass with release recheck | `pnpm@10.34.4`, `node-pg-migrate@9.0.0`, `pg@8.20.0` and `@types/pg@8.20.0` are exact package pins in `package.json` and `pnpm-lock.yaml`; a frozen install into a newly created directory with no `node_modules` installed 402 packages successfully. The local host has no OCI runtime, so CI must repeat the same frozen install in its clean container before release. |
| No vendor cloud or schema telemetry | Pass | Planner is local-only and the selected runner has no vendor-cloud requirement; telemetry is disabled by policy. |
| Maintained license and plain-SQL exit | Pass | The selected MIT-licensed runner can be removed while retaining every ordered SQL file and SHA-256 receipt. |

Flyway Community was not selected because its dry-run and drift commands do not satisfy this gate without a paid tier. ORM-specific migration tools were not evaluated after the preferred SQL-first candidate passed with the local harness.

Official sources checked on 2026-08-02:

- [node-pg-migrate programmatic API](https://salsita.github.io/node-pg-migrate/api)
- [node-pg-migrate SQL loading strategies](https://salsita.github.io/node-pg-migrate/migration-loading-strategies)
- [node-pg-migrate v9.0.0 runner source](https://github.com/salsita/node-pg-migrate/blob/v9.0.0/src/runner.ts)
- [node-pg-migrate v9.0.0 package metadata and MIT license](https://github.com/salsita/node-pg-migrate/blob/v9.0.0/package.json)
- [Flyway command edition matrix](https://documentation.red-gate.com/flyway/reference/commands)

## File Contract

Migration names must match:

```text
YYYYMMDDHHMM_<sequence>_<expand|backfill|switch|contract>_<domain>.sql
```

Committed migration contents never change. A correction is a new ordered migration. Destructive contract migrations require evidence that every supported application version has stopped using the old shape; no automatic `down` migration is promised for destructive data changes.

## Planner Contract

The planner reads only this directory and a synthetic or redacted schema snapshot:

```bash
pnpm db:plan -- --snapshot /path/to/schema-snapshot.json
```

It returns versioned JSON and exits with `0` for `pass` or `warn`, `2` for a deterministic failed gate, and `1` for invalid input or an operational error. A prior snapshot contains an ordered `applied` array of `{ "name", "sha256" }` plus expected and observed schema SHA-256 values. It must not contain credentials, SQL data, PII or raw schema contents.

## Execution Boundary

Only a separately approved migration process may provide `MIGRATION_DATABASE_URL`. The migration role owns DDL; the application role remains unprivileged and must not create or alter core schema at runtime. Before any future connection, the caller must apply the policy in `db/migrate.config.ts`, preserve the planner output, identify the exact database target, and obtain migration-owner approval.

Rollback for an unadopted candidate is dependency removal plus deletion of these unreferenced local files. After a migration is used, rollback is an approved corrective migration or compatible application rollback, never an edit to migration history.
