-- Forward corrective migration: align the ReferralSource deactivation reason
-- with the approved runtime field name without changing historical migrations.
ALTER TABLE crm_referral_sources
  RENAME COLUMN deactivation_reason TO deactivate_reason_code;

ALTER TABLE crm_referral_sources
  DROP CONSTRAINT IF EXISTS crm_referral_sources_deactivation_receipt_check;

ALTER TABLE crm_referral_sources
  ADD CONSTRAINT crm_referral_sources_deactivation_receipt_check CHECK (
    (status = 'active' AND deactivated_at IS NULL
      AND deactivated_by_user_id IS NULL AND deactivate_reason_code IS NULL)
    OR (status = 'inactive' AND deactivated_at IS NOT NULL
      AND deactivate_reason_code IS NOT NULL AND btrim(deactivate_reason_code) <> '')
  ) NOT VALID;
