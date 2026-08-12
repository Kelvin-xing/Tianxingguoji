# P3-07 Production IaC Source Plan

## Receipt

| Field | Value |
| --- | --- |
| Ticket | `P3-07` |
| Authority | `DEC-018`–`DEC-024`, `DEC-035`, `DEC-037`, `DEC-039`, `DEC-063`, `DEC-068` |
| Outcome | Local production IaC source and static policy evidence only |
| Terminal state | `needs_human` |
| Release eligible | `false` |
| External effects | None |

## Problem and boundary

P3-07 makes the approved AWS Hong Kong production topology reviewable before any provider or account is contacted. It owns Terraform source, static Node/OPA checks and a fail-closed evidence compiler. It does not own provider installation, backend initialization, plan generation, apply, migration, DNS, deployment or production data.

Stakeholders are Infrastructure/Security (private HK placement and least exposure), Operations (drain, logs and bounded scaling), Privacy/Data (private encrypted stores and retention), Finance/Founder (category budgets and escalation thresholds), and Release (immutable plan identity).

## Invariants and enforcement

| Invariant | Enforcement owner |
| --- | --- |
| Sensitive resources remain in `ap-east-1`; no public data store or cross-region replication | Provider region/account guard, Terraform resource settings, OPA residency policy |
| ECS tasks use two private AZs, one NAT per AZ and the complete approved endpoint set | Production network wiring plus static source test |
| Runtime is `1024/2048`, desired/minimum `2`, maximum `4`, with readiness, drain, circuit-breaker and autoscaling controls | Web-runtime module plus production source test |
| RDS is PostgreSQL 17, `db.t4g.small`, 20 GiB gp3, Multi-AZ, private, encrypted, deletion-protected and seven-day backup | RDS module plus static source test |
| Documents use private versioned SSE-KMS S3 and encrypted SQS/DLQ | Document-store module and existing focused tests |
| Application logs retain 30 days and audit logs 365 days | Web-runtime resources and source test |
| WAF uses Common/KnownBadInputs managed groups; rate limit has no production default | Production variables, WAF precondition and source test |
| OD-11 total/compute/database/storage/network budgets and 50/80/100 alerts exist; recipients have no default | Production budgets source and input validation |
| P3-10 can identify an apply only by the saved P3-07A binary plan SHA | Manifest compiler rejects a plan claim without P3-07A receipt |

## Inputs and failure contract

Account, backend, network, certificate, immutable image digest, bucket, RDS minor/snapshot/KMS values, WAF rate, category budget amounts, recipients and tags are required external exact payloads. Missing or malformed values stop before plan. Backend arguments are supplied only by the separately approved initialization payload; no local-state fallback is authorized.

The compiler rejects unsupported schema/type/region, malformed hashes, partial plan hashes, a receipt without a plan, and any claimed binary plan without a P3-07A exact-payload/tooling receipt. P3-07 evidence therefore stays `planStatus=not_generated`, `releaseState=needs_human`, `releaseEligible=false`, with all approvals `not_requested`.

## Risks and recovery

- Static source checks cannot prove provider-schema compatibility, resource availability, account inventory, price or resulting placement. P3-07A owns those checks under separate approval.
- The provider lock hash is `null` because provider initialization was not authorized. It must be generated and bound at P3-07A, never hand-authored.
- Changing any Terraform source invalidates the recorded source-tree hash and any later plan derived from it.
- No committed `.tfplan`, plan JSON, `.tfvars`, state, secret, recipient or raw account payload exists. Terraform artifacts are ignored by source control.

## Deterministic evidence

The committed `sourceTreeSha256` is produced by `computeTerraformSourceTreeSha256(repoRoot)`. The helper walks `infra/terraform` recursively, includes only regular files whose names end exactly in `.tf`, skips `.terraform` directories, normalizes each repo-relative path to `/`, and sorts the paths. It hashes a stream containing two length-delimited frames per file: an unsigned 64-bit big-endian UTF-8 path-byte length plus path bytes, followed by an unsigned 64-bit big-endian content-byte length plus raw file bytes. State, plan, tfvars, `.terraform` and lock artifacts are excluded by construction, and length framing prevents path/content concatenation ambiguity.

Red was observed with `0/4` tests passing because the production source and manifest compiler did not exist. After implementation, the focused source/manifest/OPA and staging regression suite passed `21/21`, including committed-evidence reproduction.

Evidence:

- `evidence/release1/p3-07/manifest.json`
- `evidence/release1/p3-07/source-review.json`
- `tests/infra/production-source-policy.test.ts`
- `tests/infra/production-plan-manifest.test.ts`
- `tests/infra/production-residency-policy.test.ts`

Not run: Terraform `fmt`, `validate`, `init`, provider installation, `plan`, `show`, `apply`, AWS APIs, `pnpm lint`, `pnpm build`, migration, commit, push or deploy.

## P3-07A gate

P3-07A requires a separately approved exact payload naming the AWS account, backend, CIDRs, certificate, image digest, bucket, RDS/KMS values, WAF rate, budget values/recipients and tags, plus permission to run the exact Terraform tooling commands. It must save the binary plan outside sensitive Git data, record its SHA-256, generate a separately redacted summary, bind the provider lock and unchanged source-tree hashes, and must not apply.
