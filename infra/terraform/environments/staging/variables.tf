variable "project_name" {
  type        = string
  description = "Stable project prefix used in staging resource names."
  default     = "tianxing"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be a lowercase DNS-safe identifier."
  }
}

variable "environment" {
  type        = string
  description = "This root is intentionally limited to the staging environment."
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "The staging Terraform root accepts only environment = staging."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "RFC1918 CIDR allocated to the approved Hong Kong staging VPC."
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && can(regex("^10\\.[0-9]{1,3}\\.0\\.0/16$", var.vpc_cidr))
    error_message = "vpc_cidr must be a valid 10.0.0.0/8 private /16 CIDR block."
  }
}

variable "availability_zone_count" {
  type        = number
  description = "Number of ap-east-1 availability zones used for the staging runtime."
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "availability_zone_count must be between two and three."
  }
}

variable "health_ingress_cidrs" {
  type        = set(string)
  description = "Reviewed operator or probe CIDRs allowed to reach the non-sensitive health endpoint."

  validation {
    condition = length(var.health_ingress_cidrs) > 0 && alltrue([
      for cidr in var.health_ingress_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"
    ])
    error_message = "health_ingress_cidrs must contain at least one approved CIDR and cannot include world-open CIDRs."
  }
}

variable "container_image" {
  type        = string
  description = "Approved immutable ECR image digest for the staging health runtime."

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "container_image must be an immutable image reference ending in an sha256 digest."
  }
}

variable "container_repository_arn" {
  type        = string
  description = "Exact ap-east-1 ECR repository ARN allowed for the staging health image pull."

  validation {
    condition = can(regex(
      "^arn:aws:ecr:ap-east-1:[0-9]{12}:repository/[a-z0-9]+([._/-][a-z0-9]+)*$",
      var.container_repository_arn,
    ))
    error_message = "container_repository_arn must be a canonical ap-east-1 ECR repository ARN."
  }
}

variable "health_certificate_arn" {
  type        = string
  description = "Approved ACM certificate ARN for the HTTPS-only health listener in ap-east-1."

  validation {
    condition     = can(regex("^arn:aws:acm:ap-east-1:[0-9]{12}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.health_certificate_arn))
    error_message = "health_certificate_arn must be an ACM certificate ARN from ap-east-1."
  }
}

variable "log_kms_key_id" {
  type        = string
  description = "Optional approved Hong Kong KMS key ARN for the staging application log group."
  default     = null
  nullable    = true

  validation {
    condition     = var.log_kms_key_id == null || can(regex("^arn:aws:kms:ap-east-1:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.log_kms_key_id))
    error_message = "log_kms_key_id must be null or an ap-east-1 KMS key ARN."
  }
}

variable "postgres_engine_version" {
  type        = string
  description = "Approved PostgreSQL 17 minor version currently available in ap-east-1."

  validation {
    condition     = can(regex("^17\\.[0-9]+$", var.postgres_engine_version))
    error_message = "postgres_engine_version must be an approved PostgreSQL 17 minor version."
  }
}

variable "rds_final_snapshot_identifier" {
  type        = string
  description = "Exact approved RDS snapshot identifier used for an approved staging destroy."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,254}$", var.rds_final_snapshot_identifier))
    error_message = "rds_final_snapshot_identifier must be a lowercase RDS-compatible identifier."
  }
}

variable "rds_master_user_secret_kms_key_id" {
  type        = string
  description = "Optional approved ap-east-1 KMS key ARN for the RDS-managed migration credential secret."
  default     = null
  nullable    = true

  validation {
    condition     = var.rds_master_user_secret_kms_key_id == null || can(regex("^arn:aws:kms:ap-east-1:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.rds_master_user_secret_kms_key_id))
    error_message = "rds_master_user_secret_kms_key_id must be null or an ap-east-1 KMS key ARN."
  }
}

variable "tags" {
  type        = map(string)
  description = "Additional non-sensitive resource tags."
  default     = {}
}
