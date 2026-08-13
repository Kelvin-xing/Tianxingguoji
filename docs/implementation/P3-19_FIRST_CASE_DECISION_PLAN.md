# P3-19 First-Case Decision Artifact Record

Status: unsigned `no-go` template authored; no first case is authorized.

## Contract

- Problem/outcome: create one repository-verifiable authority that either keeps the tenant empty or permits exactly 1-3 opaque pilot references.
- In scope: decision payload/checklist/signature schema in `docs/release-evidence/phase3/first-case-go-no-go.md`.
- Out of scope: changing the decision to `go`, choosing references, signing for humans, reconstruction, activation or production writes.
- Invariant/enforcement: missing gate checksum, non-zero pre-decision business rows, missing/expired signature, changed payload or reference count outside 1-3 resolves to `no-go`; activation remains off.
- Approvers: Founder, Security, Privacy, Data and Operations on the exact immutable payload.

## Evidence and residual risk

P3-00 through P3-18 plus P3-07A checksums, zero-row receipt, named opaque actors/owners, budget/interviews, rollback/restore receipts and exact reference set are all pending. The template is not authority and cannot be cited as a pass.
