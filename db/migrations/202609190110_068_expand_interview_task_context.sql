-- Preserve historical invitation receipts; new invitations capture only the
-- task-specific context deliberately supplied by the case manager.
ALTER TABLE cases_school_target_transition_facts
  ADD COLUMN interview_method text,
  ADD COLUMN interview_language text,
  ADD COLUMN coaching_requirements text,
  ADD COLUMN background_summary text;
ALTER TABLE cases_school_target_transition_facts ADD CONSTRAINT cases_interview_context_check CHECK (
  (interview_method IS NULL AND interview_language IS NULL AND coaching_requirements IS NULL AND background_summary IS NULL)
  OR (to_state='interview' AND interview_method IS NOT NULL AND interview_language IS NOT NULL
    AND coaching_requirements IS NOT NULL AND background_summary IS NOT NULL
    AND char_length(btrim(interview_method)) BETWEEN 1 AND 200
    AND char_length(btrim(interview_language)) BETWEEN 1 AND 200
    AND char_length(btrim(coaching_requirements)) BETWEEN 1 AND 1500
    AND char_length(btrim(background_summary)) BETWEEN 1 AND 1500)
);
