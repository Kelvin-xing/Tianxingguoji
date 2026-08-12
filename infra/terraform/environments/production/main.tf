provider "aws" {
  region              = "ap-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = merge(var.tags, {
      Environment = "production"
      ManagedBy   = "terraform"
      Project     = "tianxing"
      Residency   = "ap-east-1"
    })
  }
}

data "aws_availability_zones" "available" { state = "available" }

locals {
  name_prefix        = "tianxing-production"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  availability_zone_count = 2
}

module "network" {
  source = "../../modules/network"

  name_prefix        = local.name_prefix
  aws_region         = "ap-east-1"
  vpc_cidr           = var.vpc_cidr
  availability_zones = local.availability_zones
  enable_nat_gateway = true
  additional_interface_endpoint_services = ["sqs", "kms", "secretsmanager", "sts"]
}

module "web_runtime" {
  source = "../../modules/web-runtime"

  runtime_mode           = "production-authenticated"
  name_prefix            = local.name_prefix
  vpc_id                 = module.network.vpc_id
  vpc_cidr               = module.network.vpc_cidr
  interface_endpoint_security_group_id = module.network.interface_endpoint_security_group_id
  public_subnet_ids      = module.network.public_subnet_ids
  private_subnet_ids     = module.network.private_subnet_ids
  health_ingress_cidrs   = var.health_ingress_cidrs
  alb_ingress_cidrs      = var.alb_ingress_cidrs
  container_image        = var.container_image_digest
  build_git_sha          = var.build_git_sha
  deployment_id          = var.deployment_id
  container_repository_arn = var.container_repository_arn
  health_certificate_arn = var.certificate_arn
  log_kms_key_id         = var.log_kms_key_id

  task_cpu              = 1024
  task_memory           = 2048
  desired_count         = 2
  minimum_count         = 2
  maximum_count         = 4
  enable_production_controls   = true
  waf_rate_limit                = var.waf_rate_limit
  application_log_retention_days = 30
  audit_log_retention_days       = 365
  enable_deletion_protection     = true
}

module "rds" {
  source = "../../modules/rds"

  name_prefix                   = local.name_prefix
  vpc_id                        = module.network.vpc_id
  private_subnet_ids            = module.network.private_subnet_ids
  application_security_group_id = module.web_runtime.runtime_security_group_id
  application_task_role_name    = module.web_runtime.application_task_role_name
  database_name                 = "tianxing"
  postgres_engine_version       = var.postgres_engine_version
  final_snapshot_identifier     = var.rds_final_snapshot_identifier
  master_user_secret_kms_key_id = var.rds_master_user_secret_kms_key_id
}

module "document_store" {
  source = "../../modules/document-store"

  name_prefix               = local.name_prefix
  bucket_name               = var.document_bucket_name
  application_task_role_name = module.web_runtime.application_task_role_name
}
