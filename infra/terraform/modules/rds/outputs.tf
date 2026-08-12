output "address" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "security_group_id" {
  value = aws_security_group.database.id
}

output "resource_id" {
  value = aws_db_instance.this.resource_id
}
