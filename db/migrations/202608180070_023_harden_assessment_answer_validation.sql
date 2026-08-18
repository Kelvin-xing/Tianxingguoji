ALTER FUNCTION cases_validate_answer_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_answer_write() SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION cases_validate_answer_write() FROM PUBLIC;
