ALTER FUNCTION cases_validate_service_case_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_service_case_write() SET search_path = pg_catalog, public;
ALTER FUNCTION cases_validate_assessment_write() SECURITY DEFINER;
ALTER FUNCTION cases_validate_assessment_write() SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION cases_validate_service_case_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cases_validate_assessment_write() FROM PUBLIC;
