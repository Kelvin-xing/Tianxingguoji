terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  # Backend arguments are supplied only in an approved `terraform init` payload.
  # Declaring the backend prevents a fallback to local state during a real apply.
  backend "s3" {
    region       = "ap-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
