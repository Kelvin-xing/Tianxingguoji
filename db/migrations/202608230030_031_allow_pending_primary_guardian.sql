CREATE OR REPLACE FUNCTION crm_assert_student_primary_contact(target_student_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_student_status text;
  current_primary_count integer;
BEGIN
  SELECT status
    INTO current_student_status
    FROM crm_students
   WHERE id = target_student_id;

  IF current_student_status = 'active' THEN
    SELECT count(*)::integer
      INTO current_primary_count
      FROM crm_student_guardian_relationships AS relationship
      JOIN crm_guardians AS guardian
        ON guardian.id = relationship.guardian_id
       AND guardian.organization_id = relationship.organization_id
     WHERE relationship.student_id = target_student_id
       AND relationship.is_primary_contact
       AND relationship.ends_at IS NULL
       AND guardian.status IN ('active', 'pending_delete');

    IF current_primary_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'crm_students_current_primary_contact_check',
        MESSAGE = 'active Student requires exactly one current readable primary Guardian';
    END IF;
  END IF;
END;
$$;
