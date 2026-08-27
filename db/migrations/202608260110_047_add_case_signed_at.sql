-- D5 forward corrective migration. Historical cases may not have a captured
-- signing timestamp; all new Case intake writes provide one in UTC.
ALTER TABLE cases_service_cases
  ADD COLUMN signed_at timestamptz;

COMMENT ON COLUMN cases_service_cases.signed_at IS
  '線下簽約事實；D5 intake writes a timezone-normalized UTC timestamp.';
