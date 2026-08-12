# Staging Runtime Runbook

## Purpose And Boundary

This runbook governs `P1-01`: a non-sensitive health route served by a
private ECS/Fargate task in AWS Hong Kong (`ap-east-1`). The Terraform root is
`infra/terraform/environments/staging`. It declares the network and runtime
only; it does not authorize `terraform init`, `terraform plan`, `terraform
apply`, AWS resource creation, DNS changes, image publication, migration,
application release, database connection, or handling real data.

The health response is deliberately limited to the existing versioned API
envelope containing `{ "status": "ok" }` and a server-generated request ID.
It must not expose build identifiers, environment values, provider details,
database state, credentials, or any person/case/document data.

## Enforced Invariants

- Every declared sensitive runtime resource is in `ap-east-1`.
- ECS tasks run only in private subnets with no public IP and no NAT/default
  Internet route. They can use only the private ECR API/ECR DKR/CloudWatch Logs
  interface endpoints and the S3 gateway endpoint needed for image layers.
- The public-facing ALB is an ingress proxy, not the runtime. It accepts HTTPS
  only from approved CIDRs, forwards only `GET /api/v1/health`, and returns 404
  for every other request. Its target group is private and can reach port 3000
  only from that ALB security group.
- The first task role is permissionless because health reads no data. The ECS
  execution role is separate and is used only to retrieve the image and emit
  logs.
- Application logs have an explicit 30-day retention setting and must use the
  allowlisted, no-PII logging contract. `containerInsights` stays disabled
  until its data flow and retention are separately reviewed.
- Terraform has an S3 backend declaration so a real apply cannot quietly use
  local state. The approved backend configuration must itself specify an
  encrypted, versioned, private bucket in `ap-east-1` and an approved locking
  mechanism.

## Required Approval Payload Before Any Cloud Command

The operations, privacy, security, and budget owners must approve one exact
payload containing all of the following before any AWS or Terraform command:

1. AWS account ID, environment name, region `ap-east-1`, and approved remote
   state bucket/key/locking configuration, including encryption and access
   policy evidence.
2. VPC CIDR, two or more available zones, the exact health probe CIDRs, and
   confirmation that no `0.0.0.0/0` or `::/0` ingress is present.
3. ACM certificate ARN from `ap-east-1`, intended hostname, DNS ownership, and
   TLS verification method.
4. Immutable ECR image digest, source revision, SBOM/vulnerability evidence,
   non-root runtime confirmation, and the expected `/api/v1/health` response.
5. Full `terraform plan` artifact, provider/Terraform versions, resource
   inventory, IAM-policy review, log group/KMS setting, and measured cost
   estimate addressing `OD-11`.
6. Named business-hours operations owner, rollback approver, time window, and
   the precise `terraform destroy` target for this isolated staging payload.

Do not substitute an account alias, image tag, broad CIDR, previous approval,
or an altered plan for an approved value. Any change invalidates the payload.

## Deterministic Local Checks

Before a human reviews a cloud payload, run only local checks that have no AWS
side effect:

```sh
node --test tests/infra/staging-runtime.test.ts
node --test tests/infra/residency-policy.test.ts
```

When a local Terraform binary and an approved provider lock file are available,
run formatting and validation without credentials or a backend connection:

```sh
terraform -chdir=infra/terraform/environments/staging fmt -check -recursive
terraform -chdir=infra/terraform/environments/staging init -backend=false
terraform -chdir=infra/terraform/environments/staging validate
```

`init -backend=false` may download a provider, so it remains a separate network
approval in a restricted environment. It is not an apply and cannot establish
AWS residency evidence. The repository currently has no Terraform binary, so
these commands are a pending validation gate rather than completed evidence.

## Approved-Only Staging Smoke Test

After the exact payload has been approved and applied, an operator from one of
the approved source CIDRs performs a single HTTPS request with certificate
validation enabled. The expected result is HTTP 200, `cache-control: no-store`,
an authoritative `x-request-id`, and no fields beyond the versioned health
envelope. Requests to a different path or method must return 404 or 405 without
leaking infrastructure details.

Record the command version, UTC time, opaque request ID, ALB target health,
CloudWatch region/retention, plan checksum, image digest, response schema
checksum, and reviewer identities in the approved evidence store. Do not put
raw headers, access tokens, customer data, Terraform state, or secrets in Git.

## Failure, Stop, And Rollback

Classify a failed local policy check as `blocked`; fix the owning Terraform or
route contract once, then rerun the full focused suite. A missing tool,
credentials, approval, CIDR, certificate, image digest, remote state setup, or
cost approval is `needs_human` and must not be retried blindly.

For an approved isolated staging apply, a bad health deployment first rolls the
ECS service back through its circuit breaker. Stop the evidence run if the ALB
accepts an unapproved path/method/source, a task receives a public IP, a
runtime has Internet egress, logs leave `ap-east-1`, or the health body changes.
Destroying the isolated stack requires the pre-approved exact destroy plan and
must retain redacted plan, log-retention, and teardown receipts. It never
authorizes deletion of shared networking, state, production resources, or data.
