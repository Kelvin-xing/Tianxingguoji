resource "aws_cloudwatch_log_group" "audit" {
  count = var.enable_production_controls ? 1 : 0

  name              = "/${var.name_prefix}/audit"
  retention_in_days = 365
  kms_key_id        = var.log_kms_key_id

  tags = {
    LogPolicy = "append-only-no-pii"
  }
}

resource "aws_appautoscaling_target" "runtime" {
  count = var.enable_production_controls ? 1 : 0

  max_capacity       = var.maximum_count
  min_capacity       = var.minimum_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.health.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "runtime_cpu" {
  count = var.enable_production_controls ? 1 : 0

  name               = "${var.name_prefix}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.runtime[0].resource_id
  scalable_dimension = aws_appautoscaling_target.runtime[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.runtime[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_wafv2_web_acl" "runtime" {
  count = var.enable_production_controls ? 1 : 0

  name  = "${var.name_prefix}-runtime"
  scope = "REGIONAL"

  default_action { allow {} }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common-rules"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "ExactApprovedRateLimit"
    priority = 30
    action { block {} }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_rate_limit
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "runtime-waf"
    sampled_requests_enabled   = false
  }

  lifecycle {
    precondition {
      condition     = var.waf_rate_limit != null && var.waf_rate_limit >= 100
      error_message = "Production WAF rate limit requires an exact approved payload."
    }
  }
}

resource "aws_wafv2_web_acl_association" "runtime" {
  count = var.enable_production_controls ? 1 : 0

  resource_arn = aws_lb.health.arn
  web_acl_arn  = aws_wafv2_web_acl.runtime[0].arn
}
