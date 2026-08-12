variable "aws_account_id" {
  type        = string
  description = "Exact approved 12-digit production AWS account ID."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be an exact 12-digit account ID."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "Exact approved RFC1918 production VPC CIDR; /16-/20 leaves room for cidrsubnet(..., 8, ...)."
  validation {
    condition = can(
      cidrnetmask(var.vpc_cidr) != "" &&
      cidrhost(var.vpc_cidr, 0) == split("/", var.vpc_cidr)[0] &&
      length(regexall("^(10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(1[6-9]|2[0-9]|3[0-1])\\.[0-9]{1,3}\\.[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3})/(1[6-9]|20)$", var.vpc_cidr)) == 1
    )
    error_message = "vpc_cidr must be a canonical RFC1918 IPv4 /16-/20 network CIDR."
  }
}

variable "alb_ingress_cidrs" {
  type        = set(string)
  description = "Exact approved canonical IPv4 CIDRs for the public HTTPS ALB; WAF remains mandatory."
  validation {
    condition = length(var.alb_ingress_cidrs) > 0 && alltrue([
      for cidr in var.alb_ingress_cidrs : can(
        cidrhost(cidr, 0) == split("/", cidr)[0] &&
        length(regexall("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/([01]?[0-9]|2[0-9]|3[0-2])$", cidr)) == 1
      )
    ])
    error_message = "alb_ingress_cidrs requires canonical IPv4 CIDRs; use the exact approved ALB ingress payload."
  }
}

variable "health_ingress_cidrs" {
  type        = set(string)
  description = "Exact approved canonical IPv4 CIDRs reserved for health-probe review; production routes all paths through the authenticated listener rule."
  validation {
    condition = length(var.health_ingress_cidrs) > 0 && alltrue([
      for cidr in var.health_ingress_cidrs : can(
        cidrhost(cidr, 0) == split("/", cidr)[0] &&
        length(regexall("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/([2-9]|[12][0-9]|3[0-2])$", cidr)) == 1
      )
    ])
    error_message = "health_ingress_cidrs requires canonical bounded IPv4 CIDRs narrower than /1."
  }
}

variable "build_git_sha" {
  type        = string
  description = "Exact Git identity used for the immutable image build."
  validation {
    condition     = can(regex("^[0-9a-f]{7,64}$", var.build_git_sha))
    error_message = "build_git_sha must be a lowercase hexadecimal Git identity."
  }
}

variable "deployment_id" {
  type        = string
  description = "Exact Next.js deployment identifier shared by all production tasks."
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.deployment_id))
    error_message = "deployment_id must be a bounded deployment identifier."
  }
}

variable "certificate_arn" {
  type        = string
  description = "Exact approved ap-east-1 ACM certificate ARN."
  validation {
    condition     = can(regex("^arn:aws:acm:ap-east-1:${var.aws_account_id}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.certificate_arn))
    error_message = "certificate_arn must identify an ACM certificate in the production ap-east-1 account."
  }
}

variable "container_image_digest" {
  type        = string
  description = "Immutable exact approved ECR image reference."
  validation {
    condition     = can(regex("^${var.aws_account_id}\\.dkr\\.ecr\\.ap-east-1\\.amazonaws\\.com/.+@sha256:[a-f0-9]{64}$", var.container_image_digest))
    error_message = "container_image_digest must be an immutable ECR @sha256 reference in the production ap-east-1 account."
  }
}

variable "container_repository_arn" {
  type        = string
  description = "Exact approved same-account ap-east-1 ECR repository ARN."
  validation {
    condition = can(regex(
      "^arn:aws:ecr:ap-east-1:${var.aws_account_id}:repository/[a-z0-9]+([._/-][a-z0-9]+)*$",
      var.container_repository_arn,
    ))
    error_message = "container_repository_arn must identify an ECR repository in the production ap-east-1 account."
  }
}

variable "document_bucket_name" {
  type        = string
  description = "Exact approved globally unique private document bucket name."
}

variable "postgres_engine_version" {
  type        = string
  description = "Exact approved PostgreSQL 17 minor available in ap-east-1."
  validation {
    condition     = can(regex("^17\\.[0-9]+$", var.postgres_engine_version))
    error_message = "postgres_engine_version must pin PostgreSQL 17 minor."
  }
}

variable "rds_final_snapshot_identifier" {
  type        = string
  description = "Exact approved final snapshot identifier."
}

variable "log_kms_key_id" {
  type        = string
  description = "Exact approved ap-east-1 KMS key ARN for logs."
  validation {
    condition     = can(regex("^arn:aws:kms:ap-east-1:${var.aws_account_id}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.log_kms_key_id))
    error_message = "log_kms_key_id must identify a KMS key in the production ap-east-1 account."
  }
}

variable "rds_master_user_secret_kms_key_id" {
  type        = string
  description = "Exact approved ap-east-1 KMS key ARN for RDS-managed credentials."
  validation {
    condition     = can(regex("^arn:aws:kms:ap-east-1:${var.aws_account_id}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.rds_master_user_secret_kms_key_id))
    error_message = "rds_master_user_secret_kms_key_id must identify a KMS key in the production ap-east-1 account."
  }
}

variable "waf_rate_limit" {
  type        = number
  description = "Exact approved requests-per-five-minutes WAF limit."
  validation {
    condition     = var.waf_rate_limit >= 100
    error_message = "waf_rate_limit must be supplied by an exact approved payload."
  }
}

variable "monthly_budget_limits_usd" {
  type        = map(number)
  description = "Exact approved USD budgets for total, compute, database, storage, and network."
  validation {
    condition = setequals(toset(keys(var.monthly_budget_limits_usd)), toset([
      "total", "compute", "database", "storage", "network"
    ])) && alltrue([for amount in values(var.monthly_budget_limits_usd) : amount > 0])
    error_message = "All five positive OD-11 category budgets are required."
  }
}

variable "budget_notification_recipients" {
  type        = set(string)
  description = "Exact approved budget notification email recipients; never committed as defaults."
  sensitive   = true
  validation {
    condition     = length(var.budget_notification_recipients) > 0
    error_message = "At least one exact approved budget recipient is required."
  }
}

variable "tags" {
  type        = map(string)
  description = "Reviewed non-sensitive production tags."
}
