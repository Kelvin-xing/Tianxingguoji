# One-role baseline

This directory is an independent executable baseline for an empty local, Neon
test, or AWS bootstrap. It is deliberately separate from
`db/migrations/manifest.json`; the historical 27 migration files and their
hashes are immutable.

The generator reads all 27 frozen sources, applies five explicit one-role
transforms (008, 011, 012, 013, and 028), copies the other 22 files byte-for-byte,
and emits 28 ordered SQL files plus a manifest. `db:baseline:check` regenerates
the result in memory and rejects source drift or generated-file drift.

`status=executable-unapplied` means the baseline can be run, but has not been
run against any database. The runner uses one transaction, a transaction-scoped
advisory lock, SHA-256 checks before and after every file, and a separate marker
(`tianxing_baseline.installations`) instead of the historical migration ledger.

The baseline uses `tianxing_app` as the only PostgreSQL login role. It removes
legacy database roles, preserves the business role
`platform_billing_approver`, forces RLS on every RLS-enabled public table, and
locks down `SECURITY DEFINER` functions. Because the same role owns the
database and credential table, credential-table owner access remains a known
residual risk; the `app.organization_id` and billing access-mode settings are
application conventions, not a substitute for a second database role.
