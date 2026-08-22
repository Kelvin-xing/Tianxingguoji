# One-role baseline

This directory is an independent executable baseline for an empty local, Neon
test, or AWS bootstrap. It is deliberately separate from
`db/migrations/manifest.json`; the historical 29 migration files and their
hashes are immutable.

The generator reads all 29 frozen sources, applies six explicit one-role
transforms (008, 011, 012, 013, 025, and 028), copies the other 23 files byte-for-byte,
and emits 30 ordered SQL files plus a manifest. `db:baseline:check` regenerates
the result in memory and rejects source drift or generated-file drift.

The 025 transform temporarily grants `TRIGGER` on the transition-facts table
immediately before creating its guard trigger and revokes that privilege
immediately afterward. Both statements execute inside the baseline's single
transaction, so the final runtime ACL is not expanded.

`status=executable-unapplied` means the baseline can be dry-run, but has not been
applied to any database. The runner uses one transaction, a transaction-scoped
advisory lock, SHA-256 checks before and after every file, and a separate marker
(`tianxing_baseline.installations`) instead of the historical migration ledger.

Any baseline SQL change must pass the real PostgreSQL 17 gate before review:

```bash
pnpm test:one-role-baseline-postgresql
```

The gate uses the pinned PostgreSQL 17 image, an isolated `tmpfs` data directory,
a random loopback port, and the real 30-file runner. It requires a dry-run
`ROLLBACK` plus a clean independent-connection postflight and removes only its
own temporary container.

The baseline uses `tianxing_app` as the only PostgreSQL login role. It removes
legacy database roles, preserves the business role
`platform_billing_approver`, forces RLS on every RLS-enabled public table, and
locks down `SECURITY DEFINER` functions. Because the same role owns the
database and credential table, credential-table owner access remains a known
residual risk; the `app.organization_id` and billing access-mode settings are
application conventions, not a substitute for a second database role.
