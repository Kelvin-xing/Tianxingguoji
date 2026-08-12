locals {
  budget_service_filters = {
    compute  = ["Amazon Elastic Container Service", "Amazon Elastic Compute Cloud - Compute"]
    database = ["Amazon Relational Database Service"]
    storage  = ["Amazon Simple Storage Service"]
    network  = ["Amazon Elastic Load Balancing", "Amazon Virtual Private Cloud"]
  }
  budget_thresholds = [50, 80, 100]
}

resource "aws_budgets_budget" "category" {
  for_each = var.monthly_budget_limits_usd

  name         = "${local.name_prefix}-${each.key}"
  budget_type  = "COST"
  limit_amount = tostring(each.value)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = each.key == "total" ? [] : [1]
    content {
      name   = "Service"
      values = local.budget_service_filters[each.key]
    }
  }

  dynamic "notification" {
    for_each = toset(local.budget_thresholds)
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = var.budget_notification_recipients
    }
  }
}
