provider "aws" {
  region = "ap-east-1"

  default_tags {
    tags = merge(
      var.tags,
      {
        Environment = var.environment
        ManagedBy   = "terraform"
        Project     = var.project_name
        DataClass   = "sensitive-runtime"
      },
    )
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix        = "${var.project_name}-${var.environment}"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
}

module "network" {
  source = "../../modules/network"

  name_prefix        = local.name_prefix
  aws_region         = "ap-east-1"
  vpc_cidr           = var.vpc_cidr
  availability_zones = local.availability_zones
}

module "web_runtime" {
  source = "../../modules/web-runtime"

  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  vpc_cidr              = module.network.vpc_cidr
  interface_endpoint_security_group_id = module.network.interface_endpoint_security_group_id
  public_subnet_ids     = module.network.public_subnet_ids
  private_subnet_ids    = module.network.private_subnet_ids
  health_ingress_cidrs  = var.health_ingress_cidrs
  container_image       = var.container_image
  container_repository_arn = var.container_repository_arn
  health_certificate_arn = var.health_certificate_arn
  log_kms_key_id        = var.log_kms_key_id
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
