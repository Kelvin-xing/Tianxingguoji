-- Preserve the effective field value seen by a change requester separately from
-- the immutable crawler baseline. Old requests have no such evidence; do not
-- backfill a value that the requester did not confirm.
ALTER TABLE schools_overlay_fields
  ADD COLUMN expected_effective_value_sha256 text,
  ADD CONSTRAINT schools_overlay_effective_hash_check CHECK (
    expected_effective_value_sha256 IS NULL
    OR expected_effective_value_sha256 ~ '^[a-f0-9]{64}$'
  );
