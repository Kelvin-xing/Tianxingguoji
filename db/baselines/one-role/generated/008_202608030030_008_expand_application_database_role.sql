-- one-role baseline: tianxing_app already exists as the database owner.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tianxing_app;

DO $$
DECLARE
  target_database text := current_database();
  target_table text;
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', target_database);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tianxing_app', target_database);

  FOR target_table IN
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'organization_id'
     ORDER BY table_name
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO tianxing_app', target_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('DROP POLICY IF EXISTS tianxing_tenant_boundary ON public.%I', target_table);
    EXECUTE format(
      $policy$
        CREATE POLICY tianxing_tenant_boundary ON public.%I
          FOR ALL TO tianxing_app
          USING (organization_id::text = current_setting('app.organization_id', true))
          WITH CHECK (organization_id::text = current_setting('app.organization_id', true))
      $policy$,
      target_table
    );
  END LOOP;
END;
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
