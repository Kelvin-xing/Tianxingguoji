data "aws_caller_identity" "current" {}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-postgres"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.name_prefix}-postgres"
  }
}

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-postgres"
  description = "Private PostgreSQL ingress from the approved ECS application runtime only."
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name_prefix}-postgres"
  }
}

resource "aws_vpc_security_group_ingress_rule" "application_postgresql" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = var.application_security_group_id
  from_port                    = 5432
  ip_protocol                  = "tcp"
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "application_postgresql" {
  security_group_id            = var.application_security_group_id
  referenced_security_group_id = aws_security_group.database.id
  from_port                    = 5432
  ip_protocol                  = "tcp"
  to_port                      = 5432
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.name_prefix}-postgres17"
  family = "postgres17"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  identifier     = substr("${var.name_prefix}-postgres", 0, 63)
  engine         = "postgres"
  engine_version = var.postgres_engine_version
  instance_class = "db.t4g.small"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  multi_az          = true

  db_name                             = var.database_name
  username                            = "tx_migrator"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.master_user_secret_kms_key_id
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false
  port                   = 5432

  backup_retention_period = 7
  copy_tags_to_snapshot   = true
  delete_automated_backups = false
  deletion_protection      = true
  skip_final_snapshot      = false
  final_snapshot_identifier = var.final_snapshot_identifier

  apply_immediately          = false
  auto_minor_version_upgrade = false
  allow_major_version_upgrade = false
}

resource "aws_iam_role_policy" "application_connect" {
  name = "${var.name_prefix}-rds-connect"
  role = var.application_task_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "rds-db:connect"
        Resource = "arn:aws:rds-db:ap-east-1:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.this.resource_id}/tianxing_app"
      },
    ]
  })
}
