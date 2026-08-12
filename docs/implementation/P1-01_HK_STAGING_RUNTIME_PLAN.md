# P1-01 HK Staging Runtime Implementation Record

| Control | Value |
| --- | --- |
| Task ID | `prd-phase-implementation-plan-2026-07-31:P1-01` |
| Date | 2026-08-06 (Asia/Hong_Kong) |
| Status | `implemented_locally_pending_terraform_validation_and_cloud_approval` |
| Source plan | `docs/PRD_PHASE_IMPLEMENTATION_PLAN.md`, Phase 1 ticket `P1-01` |
| Decisions | `DEC-018`, `DEC-021`, `DEC-035`; cloud/cost details remain gated by `OD-10` and `OD-11` |
| Runtime action | None. No Terraform initialization, planning, apply, AWS call, image publication, database connection, deployment, commit, or push occurred. |

## Outcome And Scope

This local declaration and validation harness provides a narrow staging ingress: an approved probe reaches only `GET /api/v1/health` over TLS, served by a private Fargate task in AWS Hong Kong. It is the infrastructure ticket from the phase plan, not the earlier `P1-01_FRONTEND_CASE_WORKSPACE_PLAN.md` UI slice.

In scope: an `ap-east-1` S3-backend Terraform root; a two-or-three-AZ VPC split between ingress and private runtime subnets; private ECR, Logs, and S3 service paths without NAT/default Internet routing; CIDR-restricted TLS health ingress; a non-root read-only Fargate definition with a permissionless application role; and 30-day allowlisted application logs with static regression tests.

Out of scope: every AWS-side action, remote state setup, DNS/certificate issuance, changing the health handler, image build/publish, RDS, Cognito, S3 documents, production traffic, migration execution, browser testing, `pnpm lint`, `pnpm build`, commit, push, or deployment.

## Interface And Invariants

The environment requires an immutable ECR image digest, an `ap-east-1` ACM certificate ARN, and at least one reviewed health source CIDR. World-open IPv4 and IPv6 CIDRs are rejected. VPC allocations are limited to a `10.0.0.0/8` private `/16`; control tags cannot be overridden by callers.

The network module owns the VPC, subnets, routes, endpoint security group, ECR API/ECR DKR/CloudWatch Logs interface endpoints, and S3 gateway endpoint. The runtime module owns the ALB, listener rule, ECS service/task, runtime security group, IAM roles, and application log group. It receives only IDs and CIDRs from the network module. No database, identity, document, or crawler contract is reachable from this health task.

The listener forwards only `GET /api/v1/health`; other methods and paths return 404 at the ALB. The existing route remains responsible for versioned JSON, `no-store`, and server-generated request IDs. A successful health check does not prove authentication, authorization, database availability, document scanning, or a complete P1 vertical slice.

## Evidence And Gate

Relevant files are `infra/terraform/environments/staging/**`, `infra/terraform/modules/{network,web-runtime}/**`, `tests/infra/staging-runtime.test.ts`, and `docs/runbooks/staging-runtime.md`. The deterministic local check is:

```sh
node --test --test-reporter=spec tests/infra/staging-runtime.test.ts tests/infra/residency-policy.test.ts tests/contract/api-envelope.test.ts
```

It must pass alongside `git diff --check`. Terraform syntax/provider validation is pending because the local machine has neither a Terraform binary nor an approved provider lock file. The runbook defines the distinct network boundary.

The local harness cannot prove AWS placement, IAM evaluation, backend encryption, certificate validity, image hardening, route reachability, or CloudWatch residency. Until a human approves the exact account, state backend, CIDR, certificate, image digest, cost, plan, and destroy payload, the terminal state is `needs_human_for_cloud_validation`, not `passed`. Any later residency, ingress, egress, log, or cost mismatch is `blocked`, never a reason to relax a security rule.
