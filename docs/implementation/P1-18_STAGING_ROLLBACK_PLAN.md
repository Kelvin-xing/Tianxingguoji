# P1-18 Staging Rollback Evidence

## Scope

P1-18 adds a local Release 1 evidence verifier and the associated staging rollback
runbook. It does not perform a deployment, migration, database restore, object
restore, or environment cleanup.

## State and Invariants

The checked-in bundle is `release1.synthetic`, uses only redacted deterministic
facts, and remains `releaseEligible: false`. A local verification pass means that
the bundle has not changed, not that Release 1 is approved.

The verifier owns these invariants:

- Recompile `manifest-input.json` with the P0-12 evidence compiler and require an
  exact match with `manifest.json`.
- Require a closed file set: input, compiled manifest, and exactly the checksum
  referenced artifacts. Symlinks and unexpected files fail closed.
- Check UTF-8 byte count and SHA-256 for every artifact.
- Require a local checksum scenario plus four unperformed external gates:
  compatible prior image, additive corrective migration, isolated database restore,
  and document linkage/object-version restore.
- Keep the verified local result at `no_go`; `--require-go` exits `4` until staged
  evidence and the human decision exist.

## Evidence

- `scripts/release/verify-vertical-slice.ts` exposes deterministic local outcome
  and exit codes.
- `evidence/release1/p1-18/**` is a redacted fixture with artifact hashes and an
  input-to-manifest checksum chain.
- `tests/release/verify-vertical-slice.test.ts` proves a valid local bundle, a
  tampered artifact, and a missing artifact.
- `docs/runbooks/vertical-slice-rollback.md` records the compatible-prior-image,
  corrective-migration, database restore, document restore, and approval procedure.

## External Gate

Actual RDS/PITR, document storage restore, deployment rollback, and isolated target
destruction remain unperformed and require their own approved staging payload. This
ticket neither claims them nor grants authority to run them.
