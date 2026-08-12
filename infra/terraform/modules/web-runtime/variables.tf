variable "name_prefix" {
  type        = string
  description = "Non-sensitive prefix for runtime resources."
}

variable "runtime_mode" {
  type        = string
  description = "Runtime contract selected by the environment root."
  default     = "staging-health"

  validation {
    condition     = contains(["staging-health", "production-authenticated"], var.runtime_mode)
    error_message = "runtime_mode must be staging-health or production-authenticated."
  }
}

variable "vpc_id" {
  type        = string
  description = "VPC that owns the ingress load balancer and private ECS tasks."
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR used to derive the VPC resolver address."
}

variable "interface_endpoint_security_group_id" {
  type        = string
  description = "Network-owned security group for private AWS interface endpoints."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Dedicated ingress subnet IDs for the load balancer."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Dedicated private subnet IDs for ECS tasks."
}

variable "health_ingress_cidrs" {
  type        = set(string)
  description = "Reviewed source CIDRs for the HTTPS health endpoint."
}

variable "alb_ingress_cidrs" {
  type        = set(string)
  description = "Exact approved IPv4 CIDRs for the production HTTPS ALB."
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.alb_ingress_cidrs : can(
        cidrhost(cidr, 0) == split("/", cidr)[0] &&
        length(regexall("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/([01]?[0-9]|2[0-9]|3[0-2])$", cidr)) == 1
      )
    ])
    error_message = "alb_ingress_cidrs must contain canonical bounded IPv4 CIDRs."
  }
}

variable "container_image" {
  type        = string
  description = "Immutable approved image digest to run in ECS."
}

variable "build_git_sha" {
  type        = string
  description = "Git identity embedded in the promoted image and Next.js build."
  default     = null
  nullable    = true

  validation {
    condition     = var.build_git_sha == null || can(regex("^[0-9a-f]{7,64}$", var.build_git_sha))
    error_message = "build_git_sha must be a lowercase hexadecimal Git identity."
  }
}

variable "deployment_id" {
  type        = string
  description = "Stable Next.js deployment identifier shared by all tasks in one rollout."
  default     = null
  nullable    = true

  validation {
    condition     = var.deployment_id == null || can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.deployment_id))
    error_message = "deployment_id must be a bounded deployment identifier."
  }
}

variable "container_repository_arn" {
  type        = string
  description = "Exact ECR repository ARN allowed for the ECS execution role image pull."

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
  description = "ACM certificate for the HTTPS-only load balancer listener."
}

variable "log_kms_key_id" {
  type        = string
  description = "Optional KMS key used by the application log group."
  default     = null
  nullable    = true
}

variable "task_cpu" {
  type        = number
  description = "Fargate task CPU units."
  default     = 256
}

variable "task_memory" {
  type        = number
  description = "Fargate task memory in MiB."
  default     = 512
}

variable "desired_count" {
  type        = number
  description = "Steady-state ECS task count."
  default     = 1
}

variable "minimum_count" {
  type        = number
  description = "Minimum autoscaling task count."
  default     = 1
}

variable "maximum_count" {
  type        = number
  description = "Maximum autoscaling task count."
  default     = 1
}

variable "enable_production_controls" {
  type        = bool
  description = "Enables the reviewed autoscaling, WAF, and audit-log production controls."
  default     = false
}

variable "waf_rate_limit" {
  type        = number
  description = "Exact approved WAF requests-per-five-minutes limit."
  default     = null
  nullable    = true
}

variable "application_log_retention_days" {
  type        = number
  description = "Application log retention."
  default     = 30
}

variable "audit_log_retention_days" {
  type        = number
  description = "Mandatory audit log retention."
  default     = 365
}

variable "enable_deletion_protection" {
  type        = bool
  description = "Protects the production ALB from accidental deletion."
  default     = false
}
