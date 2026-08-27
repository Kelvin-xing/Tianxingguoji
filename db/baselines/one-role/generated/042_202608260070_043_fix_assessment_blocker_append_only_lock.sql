-- Assessment header serialization is sufficient. Answer revisions are append-only
-- and tianxing_app intentionally has no UPDATE privilege on that table.
CREATE OR REPLACE FUNCTION cases_lock_assessment_blockers(
  target_assessment_id uuid, target_manifest_id uuid, blocker_stage text
) RETURNS TABLE (field_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant_setting text := nullif(current_setting('app.organization_id', true), '');
BEGIN
  IF blocker_stage NOT IN ('background_complete', 'selection_ready') THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='cases_manifest_blocker_contract_check',
      MESSAGE='assessment blocker stage is not canonical';
  END IF;
  IF tenant_setting IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='cases_assessments_tenant_context_check',
      MESSAGE='assessment blocker validation requires tenant context';
  END IF;
  PERFORM 1 FROM public.cases_assessments assessment
    JOIN public.cases_schema_manifests manifest ON manifest.id=assessment.manifest_id
   WHERE assessment.id=target_assessment_id AND assessment.manifest_id=target_manifest_id
     AND assessment.organization_id::text=tenant_setting AND manifest.status='approved'
   FOR UPDATE OF assessment FOR SHARE OF manifest;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='cases_assessments_manifest_approved_check',
      MESSAGE='assessment blocker validation requires the bound approved manifest';
  END IF;
  PERFORM public.cases_assert_case_flow_v1_manifest(target_manifest_id);
  PERFORM 1 FROM public.cases_schema_manifest_fields field
   WHERE field.manifest_id=target_manifest_id AND field.blocking_stages ? blocker_stage
   ORDER BY field.field_id FOR SHARE;
  RETURN QUERY
  SELECT field.field_id FROM public.cases_schema_manifest_fields field
    LEFT JOIN LATERAL (
      SELECT revision.semantic_state
        FROM public.cases_assessment_answers revision
       WHERE revision.assessment_id=target_assessment_id
         AND revision.organization_id::text=tenant_setting
         AND revision.manifest_id=target_manifest_id
         AND revision.field_id=field.field_id
       ORDER BY revision.revision_number DESC
       LIMIT 1
    ) answer ON true
   WHERE field.manifest_id=target_manifest_id AND field.blocking_stages ? blocker_stage
     AND (answer.semantic_state IS NULL OR answer.semantic_state <> 'provided')
   ORDER BY field.field_id;
END;
$$;
REVOKE ALL ON FUNCTION cases_lock_assessment_blockers(uuid, uuid, text) FROM PUBLIC;
