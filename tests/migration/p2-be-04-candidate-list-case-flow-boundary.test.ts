import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const path = "db/migrations/202608260040_040_expand_candidate_list_case_flow.sql";
const sql = await readFile(path,"utf8");

test("040 is forward-only CandidateListVersion + Item without current-list entity", () => {
  assert.match(sql,/CREATE TABLE cases_candidate_school_list_versions/);
  assert.match(sql,/CREATE TABLE cases_candidate_school_list_items/);
  assert.doesNotMatch(sql,/CREATE TABLE cases_(?:current_candidate|candidate_school_current)/);
  assert.doesNotMatch(sql,/ALTER TABLE .*202608|DROP TABLE/);
});

test("approved draft model is represented but command atomically submits after hash validation", () => {
  assert.match(sql,/status IN \('draft','submitted','awaiting_guardian','confirmed','returned'\)/);
  assert.match(sql,/OLD\.status = 'draft' AND NEW\.status = 'submitted'/);
  assert.ok(sql.indexOf("actual_hash IS DISTINCT FROM expected_school_set_sha256") <
    sql.indexOf("SET status='submitted'"));
});

test("Target origin item and version are guaranteed to be the same list", () => {
  assert.match(sql,/UNIQUE \(id, organization_id, service_case_id, list_version_id\)/);
  assert.match(sql,/cases_targets_origin_same_version_fk[\s\S]*origin_list_item_id, organization_id, service_case_id, origin_list_version_id[\s\S]*id, organization_id, service_case_id, list_version_id/);
});

test("submitted snapshot, item pins, histories and one-time Target binding are immutable", () => {
  assert.match(sql,/cases_candidate_lists_submitted_snapshot_immutable_check/);
  assert.match(sql,/cases_candidate_list_items_immutable_check/);
  assert.match(sql,/OLD\.school_target_id IS NOT NULL OR NEW\.school_target_id IS NULL/);
  assert.match(sql,/history is permanent|items are permanent/);
});

test("Founder rejected version cannot reach Guardian confirmation", () => {
  assert.match(sql,/status = 'awaiting_guardian' AND founder_decision = 'approved'/);
  assert.match(sql,/list_version\.status<>'awaiting_guardian' OR list_version\.founder_decision<>'approved'/);
  assert.match(sql,/requested_decision='confirmed'/);
});

test("Guardian receipt binds actor time channel relationship and exact Founder hash", () => {
  assert.match(sql,/guardian_confirmation_channel IN \('phone','wechat','in_person'\)/);
  assert.match(sql,/guardian_bound_founder_decision_sha256 = founder_decision_sha256/);
  assert.match(sql,/relationship\.ends_at IS NULL/);
  assert.match(sql,/cases_lock_assessment_blockers\([\s\S]*'selection_ready'/);
});

test("same confirmed version initializes pinned candidate Targets without Tasks", () => {
  assert.match(sql,/INSERT INTO public\.cases_school_targets[\s\S]*'candidate'[\s\S]*list_version\.id,item_row\.id/);
  assert.match(sql,/school_target_id=existing_target_id/);
  assert.doesNotMatch(sql,/INSERT INTO (?:public\.)?tasks_tasks|application_task_requested/);
});

test("milestone advances only from active background_collection after confirmation", () => {
  assert.match(sql,/service_case\.workflow_status<>'active'/);
  assert.match(sql,/from_stage = 'background_collection' AND to_stage = 'school_selection_confirmed'/);
  assert.match(sql,/reason='candidate_list_confirmed'/);
});

test("RLS, narrow grants and SECURITY DEFINER command boundary are frozen", () => {
  assert.match(sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/current_setting\('app\.organization_id', true\)/);
  assert.match(sql,/REVOKE INSERT, UPDATE, DELETE ON TABLE cases_candidate_school_list_versions FROM tianxing_app/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION cases_record_guardian_list_decision/);
});

test("Founder manual close is explicit and rechecks terminal Targets plus Tasks", () => {
  assert.match(sql,/CREATE FUNCTION cases_close_service_case/);
  assert.match(sql,/cases_actor_has_active_case_role\(target_case_id,'founder',false\)/);
  assert.match(sql,/target\.state NOT IN \('offer_confirmed','offer_declined','rejected','withdrawn'\)/);
  assert.match(sql,/task\.state NOT IN \('completed','approved','cancelled'\)/);
  assert.match(sql,/action='manual_close'/);
  assert.match(sql,/closure_outcome NOT IN \('success','no_offer','service_terminated'\)/);
});
