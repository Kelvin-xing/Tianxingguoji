-- Directory maintenance only; no old capability, table or route is widened.
CREATE FUNCTION schools_directory_member_allowed() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (
  SELECT 1 FROM access_trial_members t
  JOIN access_organization_memberships m ON m.id=t.membership_id AND m.organization_id=t.organization_id
  JOIN identity_users u ON u.id=t.user_id
  JOIN access_organizations o ON o.id=t.organization_id
  WHERE t.organization_id::text=current_setting('app.organization_id',true)
    AND t.user_id::text=current_setting('app.actor_user_id',true)
    AND t.level IN ('founder','l1','l2','l3') AND t.status='active'
    AND m.status='active' AND u.status='active' AND o.status='active'
 );
$$;
REVOKE ALL ON FUNCTION schools_directory_member_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schools_directory_member_allowed() TO tianxing_app;
CREATE POLICY schools_directory_maintenance ON schools_directory_schools FOR ALL TO tianxing_app
 USING (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed())
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed());
GRANT SELECT,INSERT,UPDATE ON schools_directory_schools TO tianxing_app;
CREATE POLICY schools_directory_maintenance ON schools_directory_campuses FOR ALL TO tianxing_app
 USING (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed())
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed());
GRANT SELECT,INSERT,UPDATE ON schools_directory_campuses TO tianxing_app;
CREATE POLICY schools_directory_maintenance ON schools_directory_field_modes FOR ALL TO tianxing_app
 USING (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed())
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed());
GRANT SELECT,INSERT,UPDATE ON schools_directory_field_modes TO tianxing_app;
CREATE POLICY schools_directory_maintenance ON schools_directory_history FOR ALL TO tianxing_app
 USING (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed())
 WITH CHECK (organization_id::text=current_setting('app.organization_id',true) AND schools_directory_member_allowed());
GRANT SELECT,INSERT ON schools_directory_history TO tianxing_app;
GRANT USAGE ON SEQUENCE schools_directory_history_id_seq TO tianxing_app;
GRANT EXECUTE ON FUNCTION schools_directory_valid_fields(jsonb,text[]) TO tianxing_app;
