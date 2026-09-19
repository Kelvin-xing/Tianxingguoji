-- Keep the effective value seen at submission for readable before/after history.
-- SQL NULL means legacy evidence is unavailable; jsonb null means known unknown.
ALTER TABLE schools_overlay_fields
  ADD COLUMN submitted_effective_value_json jsonb,
  ADD CONSTRAINT schools_overlay_submitted_value_baseline_check CHECK (
    submitted_effective_value_json IS NULL OR expected_effective_value_sha256 IS NOT NULL
  );
