-- BR-015 / ACCESS-TRIAL-01. Additive only: no automatic user or case mapping.
CREATE TABLE access_trial_members (
  membership_id uuid PRIMARY KEY REFERENCES access_employee_profiles(membership_id),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('founder','l1','l2','l3')),
  categories text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  record_version bigint NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  updated_by_user_id uuid NOT NULL REFERENCES identity_users(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (organization_id,user_id),
  FOREIGN KEY (membership_id,organization_id,user_id)
    REFERENCES access_organization_memberships(id,organization_id,user_id),
  CONSTRAINT access_trial_members_categories_check CHECK (
    categories IN ('{}'::text[], ARRAY['international_school'], ARRAY['local_school'],
      ARRAY['international_school','local_school'])
    AND (level = 'l2' OR cardinality(categories) = 0)
  )
);

-- Missing classification remains NULL, never inferred from assessment or student.
ALTER TABLE cases_service_cases ADD COLUMN business_category text
  CHECK (business_category IN ('international_school','local_school'));
CREATE INDEX cases_service_cases_category_idx ON cases_service_cases(organization_id,business_category,id);

CREATE FUNCTION access_validate_trial_member_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.actor_user_id',true),'')::uuid;
  actor_level text;
  actor_active boolean;
BEGIN
  IF NEW.organization_id::text IS DISTINCT FROM current_setting('app.organization_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='trial organization context required';
  END IF;
  -- Serialize all level changes, including concurrent removal of the last Founder.
  PERFORM 1 FROM access_organizations WHERE id=NEW.organization_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='active organization required';
  END IF;
  SELECT t.level,(t.status='active' AND m.status='active' AND u.status='active')
    INTO actor_level,actor_active
    FROM access_trial_members t
    JOIN access_organization_memberships m ON m.id=t.membership_id
    JOIN identity_users u ON u.id=t.user_id
    WHERE t.organization_id=NEW.organization_id AND t.user_id=actor_id;
  IF FOUND THEN
    IF actor_level <> 'founder' OR NOT actor_active THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='trial Founder required';
    END IF;
  ELSE
    -- A legacy Founder may explicitly bootstrap only the first trial Founder.
    -- This is never an automatic migration or an ongoing legacy permission union.
    IF EXISTS (SELECT 1 FROM access_trial_members WHERE organization_id=NEW.organization_id)
      OR NEW.user_id IS DISTINCT FROM actor_id OR NEW.level <> 'founder'
      OR NEW.status <> 'active'
      OR NOT EXISTS (
        SELECT 1 FROM access_role_bindings rb
        JOIN access_organization_memberships m ON m.id=rb.membership_id AND m.status='active'
        JOIN identity_users u ON u.id=rb.user_id AND u.status='active'
        WHERE rb.organization_id=NEW.organization_id AND rb.user_id=actor_id
          AND rb.role='founder' AND rb.status='active'
      ) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='explicit Founder bootstrap required';
    END IF;
  END IF;
  IF NEW.updated_by_user_id IS DISTINCT FROM actor_id
    OR (TG_OP='INSERT' AND NEW.created_by_user_id IS DISTINCT FROM actor_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='trial actor mismatch';
  END IF;
  IF TG_OP='UPDATE' AND OLD.level='founder' AND OLD.status='active'
    AND (NEW.level <> 'founder' OR NEW.status <> 'active')
    AND NOT EXISTS (
      SELECT 1 FROM access_trial_members t
      JOIN access_organization_memberships m ON m.id=t.membership_id AND m.status='active'
      JOIN identity_users u ON u.id=t.user_id AND u.status='active'
      WHERE t.organization_id=NEW.organization_id AND t.level='founder' AND t.status='active'
        AND t.membership_id<>OLD.membership_id
    ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='last trial Founder required';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='trial member identity immutable';
    END IF;
    IF NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='trial member version must increment';
    END IF;
    NEW.updated_at := transaction_timestamp();
  ELSIF NEW.record_version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='trial member starts at version one';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER access_trial_members_validate_write BEFORE INSERT OR UPDATE ON access_trial_members
  FOR EACH ROW EXECUTE FUNCTION access_validate_trial_member_write();

ALTER TABLE access_trial_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_trial_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tianxing_tenant_boundary ON access_trial_members
  USING (organization_id::text=current_setting('app.organization_id',true))
  WITH CHECK (organization_id::text=current_setting('app.organization_id',true));
REVOKE ALL ON access_trial_members FROM PUBLIC;
-- Writes will use the audited Founder command, not a client supplied level.
GRANT SELECT ON access_trial_members TO tianxing_app;

CREATE FUNCTION access_resolve_trial_principal(p_user_id uuid,p_organization_id uuid,p_membership_id uuid)
RETURNS TABLE(user_id uuid,organization_id uuid,membership_id uuid,level text,categories text[],
  active boolean,record_version bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT t.user_id,t.organization_id,t.membership_id,t.level,t.categories,
    (t.status='active' AND u.status='active' AND m.status='active' AND o.status='active'),t.record_version
  FROM access_trial_members t
  JOIN identity_users u ON u.id=t.user_id
  JOIN access_organization_memberships m ON m.id=t.membership_id AND m.organization_id=t.organization_id
  JOIN access_organizations o ON o.id=t.organization_id
  WHERE t.user_id=p_user_id AND t.organization_id=p_organization_id AND t.membership_id=p_membership_id;
$$;
REVOKE ALL ON FUNCTION access_resolve_trial_principal(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_resolve_trial_principal(uuid,uuid,uuid) TO tianxing_app;

CREATE FUNCTION access_deny_trial_member_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='trial member history cannot be removed';
END;
$$;
CREATE TRIGGER access_trial_members_no_delete BEFORE DELETE ON access_trial_members
  FOR EACH ROW EXECUTE FUNCTION access_deny_trial_member_delete();
CREATE TRIGGER access_trial_members_no_truncate BEFORE TRUNCATE ON access_trial_members
  FOR EACH STATEMENT EXECUTE FUNCTION access_deny_trial_member_delete();
