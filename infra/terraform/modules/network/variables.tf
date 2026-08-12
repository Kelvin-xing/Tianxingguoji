variable "name_prefix" {
  type        = string
  description = "Non-sensitive prefix for networking resources."
}

variable "aws_region" {
  type        = string
  description = "AWS region for every network-owned endpoint."

  validation {
    condition     = var.aws_region == "ap-east-1"
    error_message = "Sensitive staging networking is limited to AWS Hong Kong (ap-east-1)."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR assigned to the staging VPC."
}

variable "availability_zones" {
  type        = list(string)
  description = "At least two available ap-east-1 availability zones."

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required for staging."
  }
}

variable "additional_interface_endpoint_services" {
  type        = set(string)
  description = "Reviewed interface endpoint service suffixes for this environment."
  default     = []

  validation {
    condition = alltrue([
      for service in var.additional_interface_endpoint_services : contains([
        "sqs", "kms", "secretsmanager", "sts"
      ], service)
    ])
    error_message = "Only the reviewed private AWS service endpoint set is permitted."
  }
}

variable "enable_nat_gateway" {
  type        = bool
  description = "Creates one NAT Gateway and private default route per availability zone when approved."
  default     = false
}
