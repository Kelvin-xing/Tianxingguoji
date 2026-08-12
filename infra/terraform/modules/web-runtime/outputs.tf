output "load_balancer_dns_name" {
  value = aws_lb.health.dns_name
}

output "runtime_security_group_id" {
  value = aws_security_group.runtime.id
}

output "application_task_role_name" {
  value = aws_iam_role.application.name
}
