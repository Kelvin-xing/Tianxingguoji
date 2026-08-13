# P3-18 Empty-Baseline Restore Artifact Record

Status: runbook upgraded; restore execution and Operations/Founder gate pending.

## Contract

- Problem/outcome: restore an isolated HK empty baseline and independently prove DB and document recovery targets plus integrity.
- In scope: `docs/runbooks/restore.md` procedure/evidence schema.
- Out of scope: restore execution, AWS/RDS/S3 access, migration, endpoint switch, target cleanup and production data.
- Invariants: isolated/private `ap-east-1` targets; production endpoint never changes; DB RPO <=5m/RTO <=4h; document RPO <=24h/RTO <=8h; schema/count/hash/linkage/audit probes all pass.
- Enforcement owner: Operations executes exact-approved payload; Founder shares the final gate; module owners remediate mismatches.

## Failure model

Job success without reconciliation is failure. Any checksum, audit, linkage, region or target mismatch blocks. Cleanup is a separate destructive approval after evidence retention.

## Remaining evidence

Exact payload approval, isolated target receipts, measured clocks, redacted manifest/checksum, integrity probes and both signatures remain external human gates.
