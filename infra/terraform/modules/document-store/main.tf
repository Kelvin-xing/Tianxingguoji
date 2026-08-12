data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_iam_policy_document" "document_kms" {
  statement {
    sid       = "EnableAccountRootAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "AllowSqsHongKongEnvelopeEncryption"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["sqs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sqs.ap-east-1.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:sqs:arn"
      values = [
        "arn:aws:sqs:ap-east-1:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-document-scan",
        "arn:aws:sqs:ap-east-1:${data.aws_caller_identity.current.account_id}:${var.name_prefix}-document-scan-dlq",
      ]
    }
  }
}

resource "aws_kms_key" "documents" {
  description             = "Single-Region customer-managed key for private Release 1 document storage."
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = false
  policy                  = data.aws_iam_policy_document.document_kms.json

  lifecycle {
    precondition {
      condition     = data.aws_region.current.name == "ap-east-1"
      error_message = "The document store may only be planned in ap-east-1."
    }

    prevent_destroy = true
  }

  tags = {
    DataClassification = "sensitive"
    Residency          = "ap-east-1"
    Name               = "${var.name_prefix}-documents"
  }
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.name_prefix}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket        = var.bucket_name
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    DataClassification = "sensitive"
    Residency          = "ap-east-1"
    Name               = "${var.name_prefix}-documents"
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.documents.arn
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "document_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.documents.arn,
      "${aws_s3_bucket.documents.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyIncorrectObjectEncryptionAlgorithm"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyIncorrectObjectEncryptionKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.documents.arn]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.document_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.documents]
}

resource "aws_sqs_queue" "scan_dead_letter" {
  name                      = "${var.name_prefix}-document-scan-dlq"
  kms_master_key_id         = aws_kms_key.documents.arn
  message_retention_seconds = 1_209_600

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    DataClassification = "sensitive"
    Residency          = "ap-east-1"
    Name               = "${var.name_prefix}-document-scan-dlq"
  }
}

resource "aws_sqs_queue" "scan" {
  name                       = "${var.name_prefix}-document-scan"
  kms_master_key_id          = aws_kms_key.documents.arn
  message_retention_seconds  = 345_600
  visibility_timeout_seconds = 180
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dead_letter.arn
    maxReceiveCount     = 3
  })

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    DataClassification = "sensitive"
    Residency          = "ap-east-1"
    Name               = "${var.name_prefix}-document-scan"
  }
}

data "aws_iam_policy_document" "scan_queue" {
  statement {
    sid     = "AllowPrivateDocumentBucketEvents"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.scan.arn]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.documents.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "scan" {
  queue_url = aws_sqs_queue.scan.id
  policy    = data.aws_iam_policy_document.scan_queue.json
}

resource "aws_s3_bucket_notification" "documents" {
  bucket = aws_s3_bucket.documents.id

  queue {
    queue_arn     = aws_sqs_queue.scan.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "documents/"
  }

  depends_on = [aws_sqs_queue_policy.scan]
}

data "aws_iam_policy_document" "application_document_upload" {
  statement {
    sid = "PutOnlyOpaqueDocumentObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.documents.arn}/documents/*"]
  }

  statement {
    sid       = "UseDocumentEncryptionKeyForUploads"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.documents.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.ap-east-1.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.documents.arn]
    }
  }
}

resource "aws_iam_role_policy" "application_document_upload" {
  name   = "${var.name_prefix}-document-upload"
  role   = var.application_task_role_name
  policy = data.aws_iam_policy_document.application_document_upload.json
}
