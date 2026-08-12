variable "name_prefix" {
  type        = string
  description = "Non-sensitive prefix for the private document resources."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,40}$", var.name_prefix))
    error_message = "name_prefix must be a short lowercase DNS-compatible prefix."
  }
}

variable "bucket_name" {
  type        = string
  description = "Exact approved private S3 bucket name for document bytes."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be an S3-compatible lowercase name."
  }
}

variable "application_task_role_name" {
  type        = string
  description = "ECS application task role that may sign direct private document uploads."

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.application_task_role_name))
    error_message = "application_task_role_name must be an IAM role name."
  }
}
