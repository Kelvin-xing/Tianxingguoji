-- Forward corrective: align the relationship termination reason with the approved code contract.
ALTER TABLE crm_student_guardian_relationships
  RENAME COLUMN end_reason TO end_reason_code;
