data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:ap-east-1:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  is_production       = var.runtime_mode == "production-authenticated"
  alb_ingress_cidrs  = local.is_production ? var.alb_ingress_cidrs : var.health_ingress_cidrs
  task_family_suffix  = local.is_production ? "web" : "health"
  log_stream_prefix   = local.is_production ? "web" : "health"
  log_options = merge(
    {
      awslogs-group         = aws_cloudwatch_log_group.application.name
      awslogs-region        = "ap-east-1"
      awslogs-stream-prefix = local.log_stream_prefix
    },
    local.is_production ? { mode = "blocking" } : {},
  )
  approved_repository_url = replace(
    var.container_repository_arn,
    "arn:aws:ecr:ap-east-1:${data.aws_caller_identity.current.account_id}:repository/",
    "${data.aws_caller_identity.current.account_id}.dkr.ecr.ap-east-1.amazonaws.com/",
  )
}

data "aws_prefix_list" "s3" {
  name = "com.amazonaws.ap-east-1.s3"
}

resource "aws_security_group" "load_balancer" {
  name        = "${var.name_prefix}-alb"
  description = local.is_production ? "HTTPS ingress for the authenticated production runtime." : "HTTPS ingress for reviewed staging health probes only."
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name_prefix}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "health_https" {
  for_each = local.is_production ? toset([]) : var.health_ingress_cidrs

  security_group_id = aws_security_group.load_balancer.id
  cidr_ipv4         = each.value
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443

  description = "Approved staging health probe"
}

resource "aws_vpc_security_group_ingress_rule" "application_https" {
  for_each = local.is_production ? local.alb_ingress_cidrs : toset([])

  security_group_id = aws_security_group.load_balancer.id
  cidr_ipv4         = each.value
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443

  description = "Approved production application ingress"
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_runtime" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.runtime.id
  from_port                    = 3000
  ip_protocol                  = "tcp"
  to_port                      = 3000
}

resource "aws_security_group" "runtime" {
  name        = "${var.name_prefix}-runtime"
  description = "Private ECS runtime reachable only from its load balancer."
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name_prefix}-runtime"
  }
}

resource "aws_vpc_security_group_ingress_rule" "runtime_from_load_balancer" {
  security_group_id            = aws_security_group.runtime.id
  referenced_security_group_id = aws_security_group.load_balancer.id
  from_port                    = 3000
  ip_protocol                  = "tcp"
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "interface_endpoints_from_runtime" {
  security_group_id            = var.interface_endpoint_security_group_id
  referenced_security_group_id = aws_security_group.runtime.id
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_interface_endpoints" {
  security_group_id            = aws_security_group.runtime.id
  referenced_security_group_id = var.interface_endpoint_security_group_id
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_s3_image_layers" {
  security_group_id = aws_security_group.runtime.id
  prefix_list_id    = data.aws_prefix_list.s3.id
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_dns_udp" {
  security_group_id = aws_security_group.runtime.id
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  ip_protocol       = "udp"
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "runtime_dns_tcp" {
  security_group_id = aws_security_group.runtime.id
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  ip_protocol       = "tcp"
  to_port           = 53
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/${var.name_prefix}/application"
  retention_in_days = 30
  kms_key_id        = var.log_kms_key_id

  lifecycle {
    precondition {
      condition     = !local.is_production || var.log_kms_key_id != null
      error_message = "Production application logs require an approved ap-east-1 KMS key."
    }
  }

  tags = {
    Name      = "${var.name_prefix}-application"
    LogPolicy = "allowlisted-no-pii"
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

data "aws_iam_policy_document" "task_execution" {
  statement {
    sid       = "EcrAuthorization"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrImageRead"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [var.container_repository_arn]
  }

  statement {
    sid    = "ApplicationLogWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.application.arn}:*"]
  }
}

resource "aws_iam_role_policy" "task_execution" {
  name   = "${var.name_prefix}-ecs-execution"
  role   = aws_iam_role.task_execution.name
  policy = data.aws_iam_policy_document.task_execution.json
}

# The application role intentionally receives no policy in P1-01: health has no data dependencies.
resource "aws_iam_role" "application" {
  name               = "${var.name_prefix}-application"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-runtime"

  setting {
    name  = "containerInsights"
    value = local.is_production ? "enhanced" : "disabled"
  }
}

resource "aws_ecs_task_definition" "health" {
  family                   = "${var.name_prefix}-${local.task_family_suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.application.arn

  container_definitions = jsonencode([
    {
      name                   = "application"
      image                  = var.container_image
      essential              = true
      readonlyRootFilesystem = true
      user                   = "10001"
      stopTimeout            = 30
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = "ap-east-1" },
        { name = "GIT_SHA", value = var.build_git_sha },
        { name = "NEXT_DEPLOYMENT_ID", value = var.deployment_id },
      ]
      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        },
      ]
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
          add  = ["NET_BIND_SERVICE"]
        }
      }
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.log_options
      }
    },
  ])

  lifecycle {
    precondition {
      condition = !local.is_production || (
        can(regex("^[0-9]+\\.dkr\\.ecr\\.ap-east-1\\.amazonaws\\.com/.+@sha256:[0-9a-f]{64}$", var.container_image)) &&
        startswith(var.container_image, "${local.approved_repository_url}@sha256:")
      )
      error_message = "Production ECS requires an immutable digest from the exact approved ECR repository."
    }
    precondition {
      condition     = !local.is_production || (var.task_cpu == 1024 && var.task_memory == 2048)
      error_message = "Production ECS is fixed to the approved 1 vCPU / 2 GiB task size."
    }
  }
}

resource "aws_lb" "health" {
  name               = substr(replace("${var.name_prefix}-alb", "/[^a-zA-Z0-9-]/", "-"), 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = var.public_subnet_ids

  drop_invalid_header_fields = true
  enable_deletion_protection = var.enable_deletion_protection

  tags = {
    Name = "${var.name_prefix}-health"
  }
}

resource "aws_lb_target_group" "health" {
  name        = substr(replace("${var.name_prefix}-${local.task_family_suffix}", "/[^a-zA-Z0-9-]/", "-"), 0, 32)
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/api/v1/health"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.health.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.health_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "health_get" {
  count = local.is_production ? 0 : 1

  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.health.arn
  }

  condition {
    path_pattern {
      values = ["/api/v1/health"]
    }
  }

  condition {
    http_request_method {
      values = ["GET"]
    }
  }
}

resource "aws_lb_listener_rule" "application_all" {
  count = local.is_production ? 1 : 0

  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.health.arn
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

resource "aws_ecs_service" "health" {
  name            = "${var.name_prefix}-${local.task_family_suffix}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.health.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  platform_version = local.is_production ? "LATEST" : null

  health_check_grace_period_seconds = local.is_production ? 60 : null
  deployment_minimum_healthy_percent = local.is_production ? 100 : null
  deployment_maximum_percent         = local.is_production ? 200 : null

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.runtime.id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.health.arn
    container_name   = "application"
    container_port   = 3000
  }

  lifecycle {
    precondition {
      condition     = !local.is_production || (var.desired_count >= 2 && var.minimum_count >= 2 && var.maximum_count >= var.minimum_count)
      error_message = "Production ECS must retain at least two tasks and a valid bounded autoscaling range."
    }
    precondition {
      condition     = !local.is_production || (var.build_git_sha != null && var.deployment_id != null)
      error_message = "Production ECS requires an explicit Git SHA and deployment ID."
    }
    precondition {
      condition     = !local.is_production || (length(distinct(var.private_subnet_ids)) >= 2 && length(distinct(var.public_subnet_ids)) >= 2)
      error_message = "Production ECS and ALB require at least two distinct private and public subnets."
    }
    precondition {
      condition = !local.is_production || (
        var.enable_production_controls &&
        var.enable_deletion_protection &&
        var.application_log_retention_days == 30 &&
        var.audit_log_retention_days == 365
      )
      error_message = "Production requires WAF/autoscaling/audit controls, ALB deletion protection, and 30/365-day log retention."
    }
  }

  depends_on = [aws_lb_listener.https]
}
