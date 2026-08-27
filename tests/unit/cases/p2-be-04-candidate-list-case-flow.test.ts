import assert from "node:assert/strict";
import test from "node:test";

import {
  CandidateListError,
  CandidateListService,
  hashCandidateSchoolSet,
  type CandidateListRepository,
} from "../../../modules/cases/application/candidate-list-service.ts";
import {
  evaluateCandidateListCreation,
  evaluateFounderListReview,
  evaluateGuardianListDecision,
  evaluateFounderManualClose,
  evaluateTerminalTargetBranches,
} from "../../../modules/cases/domain/candidate-list-case-flow.ts";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  case: "10000000-0000-4000-8000-000000000003",
  school: "10000000-0000-4000-8000-000000000004",
  revision: "10000000-0000-4000-8000-000000000005",
  version: "10000000-0000-4000-8000-000000000006",
};
const HASH = "a".repeat(64);
const unionActor = Object.freeze({ userId: IDS.user,organizationId: IDS.organization,
  roles: Object.freeze(["founder","advisor"] as const),
  workspaceCapabilities: Object.freeze(["cases.workflow.manage"] as const) });

test("request-time Founder+Advisor union supports each relation-bound command", () => {
  assert.deepEqual(evaluateCandidateListCreation({ actor: unionActor,
    isCurrentPrimaryAdvisor: true,workflowStatus: "active",backgroundComplete: true }),
  { allowed: true });
  assert.deepEqual(evaluateFounderListReview({ actor: unionActor,workflowStatus: "active",
    listStatus: "submitted" }),{ allowed: true });
});

test("legacy-looking role without request-time capability never authorizes", () => {
  const actor = { userId: IDS.user,organizationId: IDS.organization,
    roles: ["advisor"] as const };
  assert.deepEqual(evaluateCandidateListCreation({ actor,isCurrentPrimaryAdvisor: true,
    workflowStatus: "active",backgroundComplete: true }),
  { allowed: false,code: "CANDIDATE_LIST_FORBIDDEN" });
});

test("Founder rejection can never be followed by Guardian confirmation", () => {
  assert.deepEqual(evaluateGuardianListDecision({ actor: unionActor,
    isCurrentPrimaryAdvisor: true,workflowStatus: "active",listStatus: "returned",
    founderDecision: "rejected",founderDecisionSha256: HASH,
    boundFounderDecisionSha256: HASH,selectionBlockersComplete: true,
    guardianRelationshipCurrent: true }),
  { allowed: false,code: "CANDIDATE_LIST_NOT_APPROVED" });
});

test("Guardian confirmation binds the exact approved receipt and current relationship", () => {
  assert.deepEqual(evaluateGuardianListDecision({ actor: unionActor,
    isCurrentPrimaryAdvisor: true,workflowStatus: "active",listStatus: "awaiting_guardian",
    founderDecision: "approved",founderDecisionSha256: HASH,
    boundFounderDecisionSha256: "b".repeat(64),selectionBlockersComplete: true,
    guardianRelationshipCurrent: true }),
  { allowed: false,code: "CANDIDATE_LIST_FOUNDER_RECEIPT_MISMATCH" });
});

test("paused, termination_pending and closed cases reject list progress", () => {
  for (const workflowStatus of ["paused","termination_pending","closed"] as const) {
    assert.deepEqual(evaluateCandidateListCreation({ actor: unionActor,
      isCurrentPrimaryAdvisor: true,workflowStatus,backgroundComplete: true }),
    { allowed: false,code: "CANDIDATE_LIST_CASE_NOT_ACTIVE" });
  }
});

test("all rejected returns two explicit branches and never auto closes", () => {
  assert.deepEqual(evaluateTerminalTargetBranches(["rejected","rejected"]),{
    allTargetsTerminal: true,allTargetsRejected: true,autoClose: false,
    branches: ["add_new_school","founder_manual_close"],
  });
});

test("Founder manual close rechecks terminal Targets and authoritative Task emptiness", () => {
  assert.deepEqual(evaluateFounderManualClose({ actor: unionActor,workflowStatus: "active",
    targetStates: ["rejected"],hasIncompleteCaseTasks: true }),
  { allowed: false,code: "CASE_CLOSE_TASKS_INCOMPLETE" });
  assert.deepEqual(evaluateFounderManualClose({ actor: unionActor,workflowStatus: "active",
    targetStates: ["preparing"],hasIncompleteCaseTasks: false }),
  { allowed: false,code: "CASE_CLOSE_TARGETS_INCOMPLETE" });
});

test("school-set hash is order-stable by ordinal and pins immutable revision", () => {
  const first = { ordinal: 1,schoolId: IDS.school,pinnedResolvedRevisionId: IDS.revision,
    pinnedResolutionSha256: HASH };
  const second = { ...first,ordinal: 2,schoolId: IDS.version };
  assert.equal(hashCandidateSchoolSet([second,first]),hashCandidateSchoolSet([first,second]));
  assert.notEqual(hashCandidateSchoolSet([first]),hashCandidateSchoolSet([
    { ...first,pinnedResolutionSha256: "b".repeat(64) },
  ]));
});

test("service sends canonical hash, atomic effects and no actor.role authorization fact", async () => {
  let captured: Parameters<CandidateListRepository["createVersion"]>[0] | undefined;
  const repository: CandidateListRepository = {
    async createVersion(input) { captured = input; return { id: input.versionId,recordVersion: 2 }; },
    async reviewVersion(input) { return { id: input.versionId,recordVersion: 3 }; },
    async recordGuardianDecision(input) { return { id: input.versionId,recordVersion: 4 }; },
    async closeCase(input) { return { id: input.caseId,recordVersion: 5 }; },
  };
  const ids = Array.from({ length: 20 },(_,index) =>
    `20000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`);
  const service = new CandidateListService(repository,() => ids.shift()!,() => 1_800_000_000_000);
  await service.createVersion({ actor: unionActor,caseId: IDS.case,previousVersionId: null,
    expectedCaseRecordVersion: 2,changeSummary: "initial submitted snapshot",
    items: [{ schoolId: IDS.school,pinnedResolvedRevisionId: IDS.revision,
      pinnedResolutionSha256: HASH,ordinal: 1 }],requestId: "req-p2-be-04",
    idempotencyKey: "p2-be-04-create" });
  assert.ok(captured);
  assert.match(captured.schoolSetSha256,/^[0-9a-f]{64}$/);
  assert.equal(captured.effects.audit.actorUserId,IDS.user);
  assert.equal(captured.effects.audit.metadata.record_version,2);
  assert.equal(captured.effects.audit.id,captured.effects.outbox.auditEventId);
  assert.equal("actorRole" in captured,false);
});

test("service rejects Advisor command when capability union is missing", () => {
  const service = new CandidateListService({} as CandidateListRepository);
  assert.throws(() => service.createVersion({ actor: { userId: IDS.user,
    organizationId: IDS.organization,roles: ["advisor"] },caseId: IDS.case,
    previousVersionId: null,expectedCaseRecordVersion: 2,changeSummary: "x",
    items: [],requestId: "req",idempotencyKey: "key" }),
  (error: unknown) => error instanceof CandidateListError && error.code === "CANDIDATE_LIST_FORBIDDEN");
});
