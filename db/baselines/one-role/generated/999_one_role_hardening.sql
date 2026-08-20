-- Generated one-role final hardening. Do not edit by hand.
DO $one_role_hardening$
DECLARE
  target_table record;
  target_function record;
BEGIN
  FOR target_table IN
    SELECT namespace_row.nspname AS schema_name, class_row.relname AS relation_name
      FROM pg_class AS class_row
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND class_row.relkind IN ('r', 'p')
       AND class_row.relrowsecurity
     ORDER BY class_row.relname COLLATE "C"
  LOOP
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
      target_table.schema_name, target_table.relation_name);
  END LOOP;

  FOR target_function IN
    SELECT function_row.function_identity
      FROM (
        SELECT format('%I.%I(%s)', namespace_row.nspname, procedure_row.proname,
                 pg_get_function_identity_arguments(procedure_row.oid)) AS function_identity
          FROM pg_proc AS procedure_row
          JOIN pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
         WHERE namespace_row.nspname = 'public'
           AND procedure_row.prosecdef
      ) AS function_row
     ORDER BY function_row.function_identity COLLATE "C"
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public',
      target_function.function_identity);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',
      target_function.function_identity);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tianxing_app',
      target_function.function_identity);
  END LOOP;
END;
$one_role_hardening$;
