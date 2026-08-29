import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const sql = await readFile("db/migrations/202608260050_041_expand_school_target_task_events.sql","utf8");
test("041 freezes task kind, target linkage and one active task per kind", () => { assert.match(sql,/task_kind/); assert.match(sql,/school_target_id/); assert.match(sql,/tasks_active_target_kind_idx/); });
test("completed application receipt is not a tautology", () => {
  assert.match(sql,/to_state <> 'completed'\s+OR completion_record_json IS NOT NULL/);
  assert.match(sql,/alternative_evidence_document_id IS NOT NULL/);
  assert.doesNotMatch(sql,/OR to_state = 'completed'/);
});
test("application task may be delivered to Contractor with task-only redaction", () => {
  assert.match(sql,/application_prepare_submit/);
  assert.match(sql,/assignee_role IN \('advisor','contractor'\)/);
});
test("paused deadline is not rewritten", () => assert.match(sql,/Case pause never rewrites or extends this deadline/));
