ALTER FUNCTION identity_validate_session_write() SECURITY DEFINER;
ALTER FUNCTION identity_validate_session_write()
  SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION identity_validate_session_write() FROM PUBLIC;
