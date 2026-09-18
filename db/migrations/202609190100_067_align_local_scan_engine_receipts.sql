-- The existing non-production transport records its actual scanner identifier.
-- Never label deterministic local scanning as ClamAV. Production runtime continues
-- to reject the deterministic transport; state/attempt/object/pointer checks remain.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('documents_validate_scan_result_write()'::regprocedure) INTO definition;
  IF position($match$NEW.engine IS DISTINCT FROM 'clamav-release1'$match$ IN definition)=0 THEN
    RAISE EXCEPTION 'scan engine allowlist anchor missing';
  END IF;
  definition:=replace(definition,$match$NEW.engine IS DISTINCT FROM 'clamav-release1'$match$,
    $replacement$(NEW.engine IS NULL OR NEW.engine NOT IN ('clamav-release1','deterministic-fake-release1'))$replacement$);
  EXECUTE definition;
END; $$;

ALTER TABLE documents_scan_results DROP CONSTRAINT documents_scan_results_completed_check;
ALTER TABLE documents_scan_results ADD CONSTRAINT documents_scan_results_completed_check CHECK (
  (state='queued' AND engine IS NULL AND signature IS NULL AND attempt_count=0 AND started_at IS NULL AND completed_at IS NULL)
  OR (state='running' AND engine IS NULL AND signature IS NULL AND attempt_count BETWEEN 1 AND 3 AND started_at IS NOT NULL AND completed_at IS NULL)
  OR (state IN ('clean','rejected','failed') AND engine IS NOT NULL AND engine IN ('clamav-release1','deterministic-fake-release1')
    AND signature IS NULL AND attempt_count BETWEEN 1 AND 3 AND started_at IS NOT NULL AND completed_at IS NOT NULL)
);
