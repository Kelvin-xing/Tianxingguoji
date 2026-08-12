variable "name_prefix" {
  type        = string
  description = "Non-sensitive prefix for RDS resources."
}

variable "vpc_id" {
  type        = string
  description = "VPC containing the private RDS instance."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs used by the RDS subnet group."

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "RDS requires at least two private subnets for Multi-AZ placement."
  }
}

variable "application_security_group_id" {
  type        = string
  description = "Private ECS runtime security group allowed to open PostgreSQL connections."
}

variable "application_task_role_name" {
  type        = string
  description = "ECS application task role that receives only RDS IAM connect permission."
}

variable "database_name" {
  type        = string
  description = "Initial database name for the Release 1 application."

  validation {
    condition     = var.database_name == "tianxing"
    error_message = "database_name is fixed to the Release 1 application database."
  }
}

variable "postgres_engine_version" {
  type        = string
  description = "Approved PostgreSQL 17 minor version available in ap-east-1."

  validation {
    condition     = can(regex("^17\\.[0-9]+$", var.postgres_engine_version))
    error_message = "postgres_engine_version must be an approved PostgreSQL 17 minor version."
  }
}

variable "final_snapshot_identifier" {
  type        = string
  description = "Exact approved final snapshot identifier used only for an approved destroy operation."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,254}$", var.final_snapshot_identifier))
    error_message = "final_snapshot_identifier must be a lowercase RDS-compatible identifier."
  }
}

variable "master_user_secret_kms_key_id" {
  type        = string
  description = "Optional approved ap-east-1 KMS key ARN for the RDS-managed migration credential secret."
  default     = null
  nullable    = true

  validation {
    condition     = var.master_user_secret_kms_key_id == null || can(regex("^arn:aws:kms:ap-east-1:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.master_user_secret_kms_key_id))
    error_message = "master_user_secret_kms_key_id must be null or an ap-east-1 KMS key ARN."
  }
}
