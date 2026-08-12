output "load_balancer_dns_name" { value = module.web_runtime.load_balancer_dns_name }
output "production_region" { value = "ap-east-1" }
output "runtime_mode" { value = "production-authenticated" }
output "runtime_task_role_name" { value = module.web_runtime.application_task_role_name }
output "database_address" {
  value     = module.rds.address
  sensitive = true
}
output "document_bucket_name" { value = module.document_store.bucket_name }
