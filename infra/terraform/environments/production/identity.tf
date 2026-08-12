resource "aws_cognito_user_pool" "internal" {
  name = "${local.name_prefix}-internal"

  mfa_configuration = "ON"
  software_token_mfa_configuration { enabled = true }

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  deletion_protection = "ACTIVE"

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }
}

resource "aws_cognito_user_pool_client" "application" {
  name         = "${local.name_prefix}-application"
  user_pool_id = aws_cognito_user_pool.internal.id

  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}
