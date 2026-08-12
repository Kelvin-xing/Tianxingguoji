# AWS Local Foundation Prerequisite Record (Not R1X-10 Completion)

| Field | Value |
| --- | --- |
| Ticket | Local prerequisite evidence only; authoritative `R1X-10` remains `not_started` |
| Run | `R1-AWS-PORTAL-BILLING-20260811-v1` |
| Date | 2026-08-13 (Asia/Hong_Kong) |
| Repository | `erp-frontend/` |
| Scope | Local Next.js standalone image contract and production ECS/ALB/WAF/IAM source |
| Status | `local_foundation_prerequisite`; `R1X-10` nonprod E2E `not_started` |
| Release eligible | `false` |
| External effects | None; no AWS, Terraform backend, database, network, build, deploy, commit, or push action |

## Problem and Boundary

This slice makes the accepted AWS Hong Kong runtime baseline reviewable in local source. It owns `next.config.ts`, the standalone container contract, the shared web-runtime module's production mode, production runtime wiring, and deterministic infrastructure tests. Staging keeps the existing health-only default and wiring.

The authoritative plan defines `R1X-10` as the nonprod two-task end-to-end gate after `R1X-04`, `R1X-08`, `R1X-09`, and `P3-07`. None of those external integration claims is made here. This artifact is only prerequisite evidence and must not be used to mark `R1X-10` started or complete.

It does not implement application composition, RDS repositories, Cognito verification, S3/SQS effects, route changes, migrations, CI/OIDC, ECR publication, DNS, Cloudflare, Vercel retirement, or any cloud-side resource operation.

## Invariants and Enforcement

| Invariant | Local enforcement |
| --- | --- |
| Production workload is declared for `ap-east-1` | Production provider/root and module resource settings; existing residency policy remains the separate static check |
| ECS tasks are private and multi-AZ capable | Production passes two private subnet sets, `assign_public_ip = false`, desired/minimum `2`, and production preconditions |
| One immutable image identity is promoted across tasks | Required production `container_image_digest`, `build_git_sha`, and `deployment_id` variables; ECS task environment carries the build identities |
| Next.js multi-instance build identity is stable | `output: "standalone"`, lowercase hexadecimal `GIT_SHA`, separately bounded `NEXT_DEPLOYMENT_ID`, and production missing/invalid-value rejection |
| Base image and Server Action key cannot be silently omitted from an image build | Dockerfile requires a digest-pinned Alpine `NODE_IMAGE` compatible with its BusyBox account commands and BuildKit secret `next_server_actions_encryption_key` |
| ALB is HTTPS-only at the runtime ingress and production WAF is attached | Production mode creates approved ALB ingress rules, HTTPS listener/routing, deletion protection, and the existing managed WAF/rate-limit resources |
| Task execution and application roles stay separated | ECS execution role has only ECR pull and application-log write permissions; application role receives no broad managed policy; trust is source-account constrained |
| Logs have bounded retention and production delivery is blocking | Application logs default to 30 days, audit logs to 365 days, and production `awslogs` mode is `blocking`; production log KMS input is required |
| Staging behavior remains health-only | `runtime_mode` defaults to `staging-health`; existing staging root does not opt into production mode and existing health listener rule remains conditional to that mode |

The Docker build additionally rejects a `NODE_IMAGE` that is not an explicit digest-pinned `node:<version>-alpine<variant>@sha256:<digest>` reference. Production module preconditions bind the ECS image digest to the separately approved ECR repository, require at least two distinct public/private subnet IDs, fix the approved 1 vCPU / 2 GiB task size, and prevent production mode from disabling WAF/autoscaling/audit controls, ALB deletion protection, or the 30/365-day retention contract.

## Runtime Contract

The shared `web-runtime` module has two explicit modes:

- `staging-health` preserves the existing restricted health probe, disabled Container Insights, staging resource defaults, and health-only listener behavior.
- `production-authenticated` routes all paths through the HTTPS ALB to the private ECS service, enables WAF/autoscaling/audit controls through the existing production control file, uses Fargate `LATEST`, keeps two healthy tasks during deployment, enables enhanced Container Insights, and requires external build/deployment identities.

The ALB ingress CIDR set is a required production payload. It may be `0.0.0.0/0` for an internet-facing authenticated ALB only when that exact payload has been reviewed; the WAF, TLS certificate, host/origin policy, and application authentication remain mandatory. No public task IP or public RDS/S3 path is introduced by this slice.

## Explicit Release Gates

The following cannot be proved safely by local source tests and remain `needs_human` gates:

1. Terraform provider initialization, `fmt`/`validate`, backend initialization, saved binary `terraform plan`, and any apply require an exact approved account/backend/CIDR/certificate/image/KMS/budget payload. No such command was run.
2. The base image digest, ECR repository/image digest, SBOM, vulnerability scan, provenance, and CI secret delivery must be produced by the approved build/release workflow. This record intentionally contains no digest or secret.
3. The existing health route and application runtime must be verified in a built standalone image. This slice did not edit routes and did not run `pnpm build`, Docker build, or a runtime smoke test.
4. Production composition and required RDS/Cognito/S3/SQS/audit configuration are not connected here. Missing application adapters must continue to fail closed at their owning runtime seam; this infrastructure source is not evidence that the authenticated application is launch-ready.
5. AWS-side checks remain required: actual two-AZ placement, NAT/VPC endpoint reachability, ACM certificate validity, WAF behavior, ALB-to-task health, IAM evaluation, CloudWatch/KMS retention, RDS/S3 privacy, alarms, drain/rollback, restore, load, cookie/origin, and data-residency probes.
6. The unresolved Release 1 business gates in `DP-01`--`DP-12` and the empty-tenant/pilot go/no-go remain unchanged.

## Focused Evidence

Run from `erp-frontend/`:

```text
node --test tests/infra/aws-local-foundation.test.ts tests/infra/production-source-policy.test.ts tests/infra/production-plan-manifest.test.ts tests/infra/staging-runtime.test.ts tests/infra/document-store.test.ts
git diff --check
```

The bounded correction added `evidence:p3-07:source`, backed by a source-only compiler and tests that require atomic replacement and refuse any plan, apply, approval, or release-eligible claim. Its fixture tests pass. The first real-workspace run waited while macOS materialized `dataless` Terraform files; the bounded retry then completed through the same owning CLI and atomically changed only `sourceTreeSha256` from `57c95ba336d4403e3cdd8aec6de74d86048dffa1873413a45cdccbd4c66143c1` to `52f35823fbe8014f9750fad6e5510127452aa50db8dd50c47d1a3d6d6eb2486b`. Plan hashes and the P3-07A receipt remain `null`; approvals remain `not_requested`; release state remains `needs_human` and ineligible.

These are static/local checks only. `pnpm lint`, `pnpm build`, Docker build, Terraform `init`/`validate`/`plan`/`apply`, AWS CLI, networked commands, migrations, Neon, Vercel, commit, and push were not run.

Future production source manifest/hash refreshes must use `npm run evidence:p3-07:source`. The generator cannot create plan/apply evidence or release approval, and this record does not self-approve that separate artifact. The final focused AWS suite passed 18 tests with no failures; this remains static/local prerequisite evidence and does not start authoritative R1X-10 E2E.
