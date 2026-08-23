DO $doc_01_legacy_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.documents_documents) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_documents_registration_metadata_migration_required',
      MESSAGE = 'existing documents require an authoritative registration metadata migration';
  END IF;
END;
$doc_01_legacy_guard$;

ALTER TABLE public.documents_documents
  ADD COLUMN display_name text NOT NULL,
  ADD CONSTRAINT documents_documents_display_name_check CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT documents_documents_case_classification_check CHECK (
    owner_kind <> 'case'
    OR classification IN ('identity_and_case_evidence', 'operational_attachment')
  );

CREATE FUNCTION public.documents_validate_registration_metadata_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.classification IS DISTINCT FROM OLD.classification THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'documents_documents_registration_metadata_immutable_check',
      MESSAGE = 'document registration metadata is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER documents_registration_metadata_immutable_trg
BEFORE UPDATE ON public.documents_documents
FOR EACH ROW
EXECUTE FUNCTION public.documents_validate_registration_metadata_update();

REVOKE ALL ON FUNCTION public.documents_validate_registration_metadata_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.documents_validate_registration_metadata_update() TO tianxing_app;
