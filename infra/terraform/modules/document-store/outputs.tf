output "bucket_name" {
  value = aws_s3_bucket.documents.id
}

output "bucket_arn" {
  value = aws_s3_bucket.documents.arn
}

output "kms_key_arn" {
  value = aws_kms_key.documents.arn
}

output "scan_queue_arn" {
  value = aws_sqs_queue.scan.arn
}

output "scan_dead_letter_queue_arn" {
  value = aws_sqs_queue.scan_dead_letter.arn
}
