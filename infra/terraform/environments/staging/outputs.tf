output "health_endpoint" {
  description = "HTTPS endpoint for the non-sensitive staging health probe; callers must originate from an approved CIDR."
  value       = "https://${module.web_runtime.load_balancer_dns_name}/api/v1/health"
}

output "runtime_security_group_id" {
  description = "Opaque identifier for the private ECS task security group."
  value       = module.web_runtime.runtime_security_group_id
}

output "staging_region" {
  description = "Residency assertion for this Terraform root."
  value       = "ap-east-1"
}

output "database_address" {
  description = "Private RDS endpoint name. It does not contain a credential or connection string."
  value       = module.rds.address
}
