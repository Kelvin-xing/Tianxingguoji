-- P1/P2 corrective migration: bind request-time Access resolution to the
-- verified session organization + membership locator. No client org input.
ALTER FUNCTION identity_resolve_session_principal(bytea, timestamptz, boolean)
  RENAME TO identity_resolve_session_principal_legacy_042;
REVOKE ALL ON FUNCTION identity_resolve_session_principal_legacy_042(bytea, timestamptz, boolean)
  FROM PUBLIC, tianxing_app;
-- one-role baseline: raw session lookup precedes tenant discovery. The locator
-- is transaction-local, exact-secret scoped, and cleared by the only executable wrapper.
DROP POLICY IF EXISTS tianxing_tenant_boundary ON identity_sessions;
CREATE POLICY tianxing_tenant_boundary ON identity_sessions
  FOR ALL TO tianxing_app
  USING (
    organization_id::text = current_setting('app.organization_id', true)
    OR (
      current_setting('app.identity_session_secret_hash', true) ~ '^[0-9a-f]{64}$'
      AND encode(secret_hash, 'hex') = current_setting('app.identity_session_secret_hash', true)
    )
  )
  WITH CHECK (
    organization_id::text = current_setting('app.organization_id', true)
    OR (
      current_setting('app.identity_session_secret_hash', true) ~ '^[0-9a-f]{64}$'
      AND encode(secret_hash, 'hex') = current_setting('app.identity_session_secret_hash', true)
    )
  );
CREATE FUNCTION identity_resolve_session_principal(p_secret_hash bytea, p_now timestamptz, p_sensitive_action boolean)
RETURNS TABLE (allowed boolean, user_id uuid, session_id uuid, captured_session_version bigint,
  reauthenticated_at timestamptz, organization_id uuid, membership_id uuid, denial_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM set_config('app.identity_session_secret_hash',
    coalesce(encode(p_secret_hash, 'hex'), ''), true);
  RETURN QUERY SELECT principal.allowed, principal.user_id, principal.session_id, principal.captured_session_version,
         principal.reauthenticated_at, session.organization_id, session.membership_id, principal.denial_code
    FROM identity_resolve_session_principal_legacy_042(p_secret_hash, p_now, p_sensitive_action) principal
    LEFT JOIN identity_sessions session ON session.id = principal.session_id;
  PERFORM set_config('app.identity_session_secret_hash', '', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_session_secret_hash', '', true);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION identity_resolve_session_principal(bytea, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_resolve_session_principal(bytea, timestamptz, boolean) TO tianxing_app;

DROP FUNCTION IF EXISTS access_resolve_workspace_context(uuid);
CREATE FUNCTION access_resolve_workspace_context(p_user_id uuid, p_organization_id uuid, p_membership_id uuid)
RETURNS TABLE (user_id uuid, organization_id uuid, membership_id uuid, role_binding_id uuid, role text,
  membership_record_version bigint, role_binding_record_version bigint)
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT m.user_id, m.organization_id, m.id, rb.id, rb.role, m.record_version, rb.record_version
    FROM identity_users u
    JOIN access_organization_memberships m ON m.user_id=u.id AND m.organization_id=p_organization_id
      AND m.id=p_membership_id AND m.status='active'
    JOIN access_organizations o ON o.id=m.organization_id AND o.status='active'
    JOIN access_role_bindings rb ON rb.organization_id=m.organization_id AND rb.membership_id=m.id
      AND rb.user_id=m.user_id AND rb.status='active'
      AND rb.role IN ('founder','admin','advisor','contractor')
   WHERE u.id=p_user_id AND u.status='active'
   ORDER BY rb.id;
$$;
REVOKE ALL ON FUNCTION access_resolve_workspace_context(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_resolve_workspace_context(uuid, uuid, uuid) TO tianxing_app;
