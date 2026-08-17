import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateScopeGrant, type ScopeGrantEvaluationInput } from "../../modules/access/domain/contract.ts";
import { evaluateContractorTaskAccess } from "../../modules/access/domain/policy.ts";
import { evaluateAssessmentFieldAnswer, evaluateServiceCaseCreation, evaluateTargetOutcome } from "../../modules/cases/domain/contract.ts";
import {
  evaluateCaseTransitionPolicy,
  evaluateSchoolTargetTransitionPolicy,
  HK_K12_STANDARD_V1_TEMPLATE,
  outcomeCodesForTargetState,
  type CaseTransitionPolicyInput,
} from "../../modules/cases/domain/transition-policy.ts";
import { RELEASE_1_TASK_INITIAL_STATE, RELEASE_1_TASK_TRANSITION_RULES } from "../../modules/tasks/domain/release1-policy.ts";
import { evaluateTaskTransition } from "../../modules/tasks/domain/transition-policy.ts";
import type { TaskActorRole, TaskState, TaskTransitionPolicy } from "../../modules/tasks/domain/contract.ts";
import { createEvidenceManifest, type EvidenceManifestInput } from "../../scripts/evidence/create-manifest.ts";
import { completeIdempotencyRecord, createIdempotencyRecord, evaluateIdempotency, hashRequestPayload } from "../../modules/shared/domain/idempotency.ts";
import { buildAlertOccurrence, getAlertDefinition, ALERT_CATALOGUE_VERSION } from "../../modules/operations/domain/alert-catalogue.ts";
import { createContractorTaskGetHandler } from "../../modules/tasks/infrastructure/contractor-route.ts";
import { ContractorTaskWorkspaceRuntimeUnavailable } from "../../modules/tasks/infrastructure/contractor-workspace-runtime.ts";
import { createOpaqueDocumentObjectKey } from "../../modules/documents/domain/contract.ts";
import { DocumentScanService } from "../../modules/documents/application/scan-service.ts";
import { processDocumentScanEvent, DocumentScanRetryableWorkerError } from "../../workers/scan-document.ts";
import { InMemoryDocumentScanRepository } from "../fakes/document-scan.ts";
import { SyntheticScannerFake } from "../fakes/scanner.ts";

const FIXTURE_ROOT = resolve("tests/fixtures/release1/phase3");
const MATRIX_PATH = resolve("evidence/release1/p3-02/coverage/matrix.json");
const INPUT_PATH = resolve("evidence/release1/p3-02/manifest-input.json");
const MANIFEST_PATH = resolve("evidence/release1/p3-02/manifest.json");
const REQUIRED_ACS = ["AC-01", "AC-04", "AC-06", "AC-07", "AC-08", "AC-17", "AC-22", "AC-24"] as const;

interface Vector {
  id: string;
  actor: { mode: string; relation?: string; status: string };
  input: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  expected: { decision: string; code?: string; state?: string };
}
interface MatrixRow {
  id: string;
  disposition: "executed" | "deferred" | "unrepresented";
  locator: string;
  expected: string;
  observed: string;
  owner: string | null;
  reason: string | null;
}
interface SupplementalCheck {
  id: string;
  authority: string;
  locator: string;
  expected: number;
  observed: number;
  status: "passed" | "failed";
}

const approvedTaskPolicy: TaskTransitionPolicy = {
  policyId: "release1-task-policy",
  version: 1,
  organizationId: "synthetic-org",
  requestedBy: "synthetic-requester",
  initialState: RELEASE_1_TASK_INITIAL_STATE,
  rules: RELEASE_1_TASK_TRANSITION_RULES,
  status: "approved",
  createdAt: "2026-08-11T00:00:00.000Z",
  approvalReceipt: { decisionId: "OD-06", decisionStatus: "resolved", reviewerId: "synthetic-reviewer", reviewerRole: "founder", approvedAt: "2026-08-11T00:00:00.000Z" },
};

function resultOf(vector: Vector): string {
  return vector.expected.code ?? vector.expected.state ?? vector.expected.decision;
}
function executed(vector: Vector, locator: string, observed: string): MatrixRow {
  return { id: vector.id, disposition: "executed", locator, expected: resultOf(vector), observed, owner: null, reason: null };
}
function deferred(vector: Vector, owner: string, reason: string, observation?: { locator: string; observed: string }): MatrixRow {
  return { id: vector.id, disposition: "deferred", locator: observation?.locator ?? "absent", expected: resultOf(vector), observed: observation?.observed ?? "not_executed", owner, reason };
}

const SCAN_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SCAN_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SCAN_VERSION_ID = "33333333-3333-4333-8333-333333333333";

function scanHarness() {
  const repository = new InMemoryDocumentScanRepository();
  const key = createOpaqueDocumentObjectKey(SCAN_DOCUMENT_ID, SCAN_VERSION_ID);
  repository.registerQuarantinedVersion({ organizationId: SCAN_ORGANIZATION_ID, documentVersionId: SCAN_VERSION_ID, bucket: "synthetic-private-document-bucket", key, versionId: "s3-version-01" });
  let serial = 700;
  const service = new DocumentScanService({ repository, clock: { nowMs: () => 1_785_600_000_000 }, createId: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` });
  return { repository, service, event: { eventId: "s3-event-p3-02-001", requestId: "document-scan-p3-02-001", bucket: "synthetic-private-document-bucket", key, versionId: "s3-version-01", scanPolicyVersion: "scanner-v1", deliveryAttempt: 1 } as const };
}

async function executeTypedServiceError(vector: Vector): Promise<MatrixRow> {
  const handler = createContractorTaskGetHandler({
    getSessionSecret: async () => "opaque-session-secret",
    requireSession: async () => ({ userId: "00000000-0000-4000-8000-000000000701", organizationId: "00000000-0000-4000-8000-000000000702", role: "contractor", sessionId: "00000000-0000-4000-8000-000000000703", capturedSessionVersion: 1, reauthenticatedAtMs: null }),
    getWorkspaceService: () => { throw new ContractorTaskWorkspaceRuntimeUnavailable(); },
  });
  const response = await handler(new Request("https://erp.example.test/api/v1/contractor/tasks/00000000-0000-4000-8000-000000000704"), { params: Promise.resolve({ taskId: "00000000-0000-4000-8000-000000000704" }) });
  const body = await response.json() as { error: { code: string } };
  return executed(vector, "modules/tasks/infrastructure/contractor-route.ts#createContractorTaskGetHandler", body.error.code);
}

function executeCase(vector: Vector): MatrixRow {
  if (String(vector.input.action) === "rollback") return deferred(vector, "P3-08", "The current case policy has no approved rollback command seam.");
  const action = vector.input.action as CaseTransitionPolicyInput["action"];
  const stage = (vector.preconditions.canonical_stage ?? vector.input.from ?? "background_collection") as CaseTransitionPolicyInput["stage"];
  const decision = evaluateCaseTransitionPolicy({
    action,
    actorRole: vector.actor.mode as CaseTransitionPolicyInput["actorRole"],
    actorIsCurrentPrimaryAdvisor: vector.actor.relation === "current_primary_advisor",
    stage,
    lifecycleState: action === "resume" ? "paused" : "active",
    pausedPreviousStage: action === "resume" ? "background_collection" : null,
    toStage: action === "advance" || action === "close" ? vector.input.to as CaseTransitionPolicyInput["toStage"] : null,
    hasReason: typeof vector.input.reason === "string" && vector.input.reason.length > 0,
    approvedManifest: true,
    backgroundBlockersComplete: true,
    schoolSelectionBlockersComplete: true,
    allTargetsTerminalWithOutcomes: vector.preconditions.all_targets_terminal_with_outcomes !== false,
    hasOpenTasks: Number(vector.preconditions.open_tasks ?? 0) > 0,
  });
  const observed = decision.allowed ? (action === "pause" ? "paused" : action === "cancel" ? "cancelled" : decision.stage) : decision.code;
  return executed(vector, "modules/cases/domain/transition-policy.ts#evaluateCaseTransitionPolicy", observed);
}

function executeTarget(vector: Vector): MatrixRow {
  const missingEvidence = vector.id === "target.missing_submission_evidence";
  const decision = evaluateSchoolTargetTransitionPolicy({
    template: HK_K12_STANDARD_V1_TEMPLATE,
    from: vector.input.from as Parameters<typeof evaluateSchoolTargetTransitionPolicy>[0]["from"],
    to: vector.input.to as Parameters<typeof evaluateSchoolTargetTransitionPolicy>[0]["to"],
    evidence: {
      dueDate: missingEvidence ? null : "2026-09-01",
      checklistCompleteReceipt: missingEvidence ? null : "synthetic-receipt",
      officialSubmissionReference: missingEvidence ? null : "synthetic-reference",
      invitationEvidence: missingEvidence ? null : "synthetic-invitation",
      interviewAt: missingEvidence ? null : "2026-09-02T00:00:00.000Z",
    },
  });
  if (decision.allowed && decision.requiresOutcome) {
    const outcome = evaluateTargetOutcome({
      targetState: vector.input.to as Parameters<typeof evaluateTargetOutcome>[0]["targetState"],
      currentOutcomeCode: (vector.input.outcome_code ?? null) as Parameters<typeof evaluateTargetOutcome>[0]["currentOutcomeCode"],
    });
    const locator = "modules/cases/domain/transition-policy.ts#evaluateSchoolTargetTransitionPolicy+modules/cases/domain/contract.ts#evaluateTargetOutcome";
    return executed(vector, locator, outcome.allowed ? String(vector.input.to) : outcome.code);
  }
  return executed(vector, "modules/cases/domain/transition-policy.ts#evaluateSchoolTargetTransitionPolicy", decision.allowed ? String(vector.input.to) : decision.code);
}

function executeOutcome(vector: Vector): MatrixRow {
  const allowed = outcomeCodesForTargetState(vector.input.target_state as Parameters<typeof outcomeCodesForTargetState>[0]);
  const observed = allowed.includes(vector.input.code as never) ? String(vector.input.target_state) : "OUTCOME_CODE_INVALID";
  return executed(vector, "modules/cases/domain/transition-policy.ts#outcomeCodesForTargetState", observed);
}

function executeTask(vector: Vector): MatrixRow {
  const role = vector.actor.mode as TaskActorRole;
  const actorId = "synthetic-actor";
  const relation = vector.actor.relation ?? "assignee";
  const decision = evaluateTaskTransition({
    policy: approvedTaskPolicy,
    organizationId: "synthetic-org", taskOrganizationId: "synthetic-org",
    caseId: "synthetic-case", taskCaseId: "synthetic-case",
    from: vector.input.from as TaskState, to: vector.input.to as TaskState,
    actorId, actorRole: role, actorIsActive: true,
    assigneeId: relation.includes("assignee") ? actorId : "synthetic-assignee",
    approverId: relation.includes("approver") ? actorId : "synthetic-approver",
    ownerId: relation === "owner" ? actorId : "synthetic-owner",
    redactedTaskContext: true, recordVersion: 1, expectedRecordVersion: 1,
    reason: String(vector.input.reason ?? ""),
  });
  if (vector.id === "task.contractor_owner_action" && !decision.allowed) {
    return deferred(vector, "P3-09", "The current public task policy returns its role denial before the fixture contractor-specific denial.", { locator: "modules/tasks/domain/transition-policy.ts#evaluateTaskTransition", observed: decision.code });
  }
  return executed(vector, "modules/tasks/domain/transition-policy.ts#evaluateTaskTransition", decision.allowed ? String(vector.input.to) : decision.code);
}

function executeScope(vector: Vector): MatrixRow {
  const startsAt = Date.parse(String(vector.preconditions.starts_at ?? "2026-08-11T00:00:00.000Z"));
  const expiresAt = Date.parse(String(vector.preconditions.expires_at ?? "2026-08-18T00:00:00.000Z"));
  const scope = vector.input.scope as ScopeGrantEvaluationInput["requestedScope"];
  const base: ScopeGrantEvaluationInput = {
    nowMs: vector.id === "scope.expired" ? expiresAt : startsAt,
    organizationId: "synthetic-org", caseId: "synthetic-case",
    requestedScope: scope, requestedCapability: vector.input.capability as ScopeGrantEvaluationInput["requestedCapability"],
    userStatus: vector.id === "scope.account_disabled" ? "disabled" : "active",
    organizationStatus: "active", membershipStatus: "active", advisorRoleBindingStatus: "active",
    collaboratorStatus: vector.id === "scope.case_closed" ? "expired" : "active",
    grantStatus: ["scope.revoked", "scope.sensitive_pending"].includes(vector.id) ? (vector.id === "scope.revoked" ? "revoked" : "pending_approval") : "active",
    grantOrganizationId: "synthetic-org", grantCaseId: "synthetic-case", grantScope: scope,
    grantCapability: vector.input.capability === "export" ? "edit" : vector.input.capability as ScopeGrantEvaluationInput["grantCapability"],
    startsAtMs: startsAt, expiresAtMs: expiresAt,
    requestedByUserId: "synthetic-requester",
    approvedByUserId: vector.preconditions.approval_status === "approved" ? "synthetic-founder" : null,
    approverRole: vector.preconditions.approver_role === "founder" ? "founder" : null,
  };
  const decision = evaluateScopeGrant(base);
  return executed(vector, "modules/access/domain/contract.ts#evaluateScopeGrant", decision.allowed ? "active" : decision.code);
}

async function edgeRows(vectors: Vector[]): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const vector of vectors) {
    if (vector.id === "failure.s3_event_replay") {
      const { service, event } = scanHarness();
      const scanner = new SyntheticScannerFake("clean");
      await processDocumentScanEvent(event, { service, scanner });
      const replay = await processDocumentScanEvent(event, { service, scanner });
      rows.push(executed(vector, "workers/scan-document.ts#processDocumentScanEvent", replay.status));
    } else if (vector.id === "failure.scanner_timeout") {
      const { service, event } = scanHarness();
      try { await processDocumentScanEvent(event, { service, scanner: new SyntheticScannerFake("timeout") }); }
      catch (error) {
        const observed = error instanceof DocumentScanRetryableWorkerError ? "DOCUMENT_SCAN_RETRYABLE" : "UNEXPECTED_ERROR";
        rows.push(deferred(vector, "P3-09", "The public worker intentionally normalizes scanner details and does not return the fixture SCANNER_TIMEOUT code.", { locator: "workers/scan-document.ts#processDocumentScanEvent", observed }));
        continue;
      }
    } else if (vector.id === "surface.typed_service_error") {
      rows.push(await executeTypedServiceError(vector));
    } else if (vector.id === "exception.non_k12_placeholder") {
      const decision = evaluateServiceCaseCreation({ applicationType: "non_k12", organizationId: "synthetic-org", studentOrganizationId: "synthetic-org", studentStatus: "active", primaryOrganizationId: "synthetic-org", primaryRole: "advisor", primaryBindingStatus: "active", manifestStatus: "approved", initialStage: "signed" });
      rows.push(executed(vector, "modules/cases/domain/contract.ts#evaluateServiceCaseCreation", decision.allowed ? "allowed" : decision.code));
    } else if (vector.id === "exception.assessment_unknown") {
      const decision = evaluateAssessmentFieldAnswer({ field: { valueType: "text", enumValues: null }, semanticState: "unknown", value: null, valueType: null });
      rows.push(deferred(vector, "P3-08", "The public contract accepts unknown but returns allowed rather than the fixture state label unknown.", { locator: "modules/cases/domain/contract.ts#evaluateAssessmentFieldAnswer", observed: decision.allowed ? "allowed" : decision.code }));
    } else if (vector.id === "concurrency.stale_write") {
      const decision = evaluateTaskTransition({ policy: approvedTaskPolicy, organizationId: "synthetic-org", taskOrganizationId: "synthetic-org", caseId: "synthetic-case", taskCaseId: "synthetic-case", from: "assigned", to: "accepted", actorId: "synthetic-actor", actorRole: "advisor", actorIsActive: true, assigneeId: "synthetic-actor", approverId: "synthetic-approver", ownerId: "synthetic-owner", redactedTaskContext: true, recordVersion: 5, expectedRecordVersion: 4, reason: "" });
      rows.push(deferred(vector, "P3-08", "The existing optimistic-concurrency seam returns TASK_STALE_VERSION, not the approved fixture VERSION_CONFLICT contract.", { locator: "modules/tasks/domain/transition-policy.ts#evaluateTaskTransition", observed: decision.allowed ? "allowed" : decision.code }));
    } else if (vector.id === "replay.idempotent_command") {
      const requestHash = hashRequestPayload({ operation: "synthetic-replay" });
      const record = completeIdempotencyRecord(createIdempotencyRecord({ id: "00000000-0000-4000-8000-000000000710", organizationId: "00000000-0000-4000-8000-000000000711", actorUserId: "00000000-0000-4000-8000-000000000712", operation: "synthetic.replay", key: "synthetic-replay-1", requestHash, createdAt: "2026-08-11T00:00:00.000Z" }), { resultReference: "synthetic-result", responseHash: hashRequestPayload({ status: "accepted" }), updatedAt: "2026-08-11T00:00:01.000Z" });
      const decision = evaluateIdempotency({ key: "synthetic-replay-1", requestHash, existing: record });
      rows.push(deferred(vector, "P3-08", "The public idempotency contract returns replay; it does not emit the fixture label duplicate.", { locator: "modules/shared/domain/idempotency.ts#evaluateIdempotency", observed: decision.action }));
    } else if (vector.id === "surface.long_bounded_value") {
      rows.push(deferred(vector, "P3-14", "Responsive long-value behavior requires the approved browser seam."));
    } else if (vector.id === "failure.reconstruction_interruption") {
      rows.push(deferred(vector, "P3-03", "Reconstruction contract is introduced by P3-03."));
    } else if (vector.id === "concurrency.stale_write") {
      rows.push(deferred(vector, "P3-08", "Existing task policy exposes TASK_STALE_VERSION, not the fixture VERSION_CONFLICT contract."));
    } else {
      rows.push(deferred(vector, vector.id === "surface.empty_case_list" ? "P3-14" : "P3-16", "No matching approved executable seam with the fixture result code exists in P0-P2."));
    }
  }
  return rows;
}

function supplementalChecks(): SupplementalCheck[] {
  const checks: Omit<SupplementalCheck, "status">[] = [
    { id: "alert.scan_stuck_seconds", authority: "DEC-035", locator: "modules/operations/domain/alert-catalogue.ts#getAlertDefinition", expected: 180, observed: getAlertDefinition("scan.stuck", ALERT_CATALOGUE_VERSION).detector.threshold },
    { id: "alert.outbox_stuck_seconds", authority: "DEC-035", locator: "modules/operations/domain/alert-catalogue.ts#getAlertDefinition", expected: 300, observed: getAlertDefinition("outbox.stuck", ALERT_CATALOGUE_VERSION).detector.threshold },
    { id: "alert.budget_critical_percent", authority: "DEC-035", locator: "modules/operations/domain/alert-catalogue.ts#buildAlertOccurrence", expected: 100, observed: buildAlertOccurrence({ alertId: "budget.rds_monthly", catalogueVersion: ALERT_CATALOGUE_VERSION, occurrenceId: "p3-02-budget", requestId: "p3-02-request", organizationId: null, detectedAt: "2026-08-11T00:00:00.000Z", observedValue: 100, state: "firing" }).threshold_value },
  ];
  return checks.map((check) => ({
    ...check,
    status: check.observed === check.expected ? "passed" : "failed",
  }));
}

async function readFixture<T>(name: string): Promise<T> { return JSON.parse(await readFile(resolve(FIXTURE_ROOT, name), "utf8")) as T; }
async function buildMatrix(): Promise<MatrixRow[]> {
  const roles = await readFixture<{ scenarios: Vector[] }>("roles.v1.json");
  const cases = await readFixture<{ caseTransitions: Vector[]; targetTransitions: Vector[]; outcomeVectors: Vector[]; illegalTransitions: Vector[] }>("case-target-transitions.v1.json");
  const tasks = await readFixture<{ approvedTransitions: Vector[]; illegalTransitions: Vector[] }>("task-transitions.v1.json");
  const scopes = await readFixture<{ scenarios: Vector[] }>("access-scopes.v1.json");
  const edges = await readFixture<{ scenarios: Vector[] }>("edge-failures.v1.json");
  const roleRows = roles.scenarios.map((vector) => {
    if (vector.id === "authz.founder.case_close") {
      const row = executeCase({ ...vector, input: { action: "close", from: "offer_confirmed", to: "closed" } });
      return { ...row, expected: resultOf(vector), observed: row.observed === "closed" ? "allowed" : row.observed };
    }
    if (["authz.collaborator.bounded_scope", "authz.actor_disabled", "authz.grant_expired", "authz.export"].includes(vector.id)) {
      const aliases: Record<string, string> = { "authz.collaborator.bounded_scope": "scope.case_summary.view", "authz.actor_disabled": "scope.account_disabled", "authz.grant_expired": "scope.expired", "authz.export": "scope.export" };
      const row = executeScope({ ...vector, id: aliases[vector.id], input: { scope: "case_summary", capability: vector.id === "authz.export" ? "export" : "view" }, preconditions: vector.id === "authz.grant_expired" ? { expires_at: "2026-08-18T00:00:00.000Z" } : {} });
      return { ...row, id: vector.id, expected: resultOf(vector), observed: row.observed === "active" ? "allowed" : row.observed };
    }
    if (vector.id === "authz.contractor.redacted_task") {
      const decision = evaluateContractorTaskAccess({ requestOrganizationId: "synthetic-org", actorOrganizationId: "synthetic-org", actorUserId: "synthetic-contractor", actorRole: "contractor", actorIsActive: true, taskOrganizationId: "synthetic-org", currentAssigneeUserId: "synthetic-contractor", currentAssigneeRole: "contractor", assignmentStatus: "active", redactionLevel: "task_only" });
      return executed(vector, "modules/access/domain/policy.ts#evaluateContractorTaskAccess", decision.allowed ? "allowed" : decision.code);
    }
    return deferred(vector, "P3-08", "No matching generic case access-control public result code exists in P0-P2.");
  });
  const caseRows = cases.caseTransitions.map(executeCase);
  const illegalRows = cases.illegalTransitions.map((vector) => vector.id.startsWith("target.") ? executeTarget(vector) : executeCase(vector));
  return [...roleRows, ...caseRows, ...cases.targetTransitions.map(executeTarget), ...cases.outcomeVectors.map(executeOutcome), ...illegalRows, ...tasks.approvedTransitions.map(executeTask), ...tasks.illegalTransitions.map(executeTask), ...scopes.scenarios.map(executeScope), ...await edgeRows(edges.scenarios)].sort((a, b) => a.id.localeCompare(b.id));
}

test("represents every P3-01 vector exactly once and preserves executed results", async () => {
  const matrix = await buildMatrix();
  assert.equal(matrix.length, 108);
  assert.equal(new Set(matrix.map(({ id }) => id)).size, 108);
  assert.equal(matrix.filter(({ disposition }) => disposition === "unrepresented").length, 0);
  for (const row of matrix) {
    if (row.disposition === "executed") assert.equal(row.observed, row.expected, row.id);
    if (row.disposition === "deferred") {
      assert.ok(row.owner && row.reason);
      if (row.observed !== "not_executed") {
        assert.notEqual(row.locator, "absent", row.id);
        assert.notEqual(row.observed, row.expected, row.id);
      }
    }
  }
  if (process.env.P3_02_GENERATE_EVIDENCE === "1") await generateEvidence(matrix);
  const stored = JSON.parse(await readFile(MATRIX_PATH, "utf8")) as { rows: MatrixRow[]; supplementalChecks: SupplementalCheck[] };
  assert.deepEqual(stored.rows, matrix);
  assert.deepEqual(stored.supplementalChecks, supplementalChecks());
  assert.ok(stored.supplementalChecks.every(({ status }) => status === "passed"));
});

test("binds matrix counts and fixture hash into fail-closed redacted evidence", async () => {
  const input = JSON.parse(await readFile(INPUT_PATH, "utf8")) as EvidenceManifestInput;
  const compiled = createEvidenceManifest(input);
  const stored = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert.deepEqual(compiled, stored);
  assert.deepEqual(compiled.coverage?.requiredAcceptanceCriteria, [...REQUIRED_ACS].sort());
  assert.equal(compiled.coverage?.total, 108);
  assert.equal(compiled.coverage?.represented, 108);
  assert.equal(compiled.coverage?.unrepresented, 0);
  assert.equal(compiled.coverage?.coverageStatus, "represented_with_deferred");
  assert.equal(compiled.coverage?.matrixArtifactPath, "coverage/matrix.json");
  assert.equal(compiled.releaseState, "needs_human");
  const canonicalBytes = await readFile(MATRIX_PATH, "utf8");
  const embedded = input.artifacts.find(({ path }) => path === "coverage/matrix.json")?.content;
  assert.equal(embedded, canonicalBytes);
  const fixtureManifestHash = createHash("sha256")
    .update(await readFile(resolve(FIXTURE_ROOT, "scenario-manifest.v1.json")))
    .digest("hex");
  assert.equal(compiled.coverage?.fixtureManifestSha256, fixtureManifestHash);
  assert.equal(compiled.releaseEligible, false);
});

async function generateEvidence(matrix: MatrixRow[]): Promise<void> {
  const content = `${JSON.stringify({ schemaVersion: 1, fixtureVersion: "release1-phase3-golden-v1", oracleRowCount: 108, supplementalChecks: supplementalChecks(), rows: matrix }, null, 2)}\n`;
  const manifestBytes = await readFile(resolve(FIXTURE_ROOT, "scenario-manifest.v1.json"));
  const counts = { executed: matrix.filter(({ disposition }) => disposition === "executed").length, deferred: matrix.filter(({ disposition }) => disposition === "deferred").length };
  const input: EvidenceManifestInput = {
    schemaVersion: 1, evidenceType: "release1.synthetic", source: "synthetic", runId: "p3-02-deterministic-matrix-v1", inputVersion: "release1-phase3-golden-v1", generatedAt: "2026-08-11T00:00:00.000Z",
    scenarios: [{ id: "matrix.coverage", description: "Every approved P3-01 vector has one explicit matrix disposition; remaining exact-code gaps require human resolution.", expectedState: "needs_human", actualState: "needs_human", evidence: { total: 108, represented: 108, executed: counts.executed, deferred: counts.deferred, unrepresented: 0, supplemental_checks: supplementalChecks().length }, artifactPaths: ["coverage/matrix.json"] }],
    artifacts: [{ path: "coverage/matrix.json", content }], approvals: [],
    coverage: { fixtureVersion: "release1-phase3-golden-v1", fixtureManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), requiredAcceptanceCriteria: REQUIRED_ACS, matrixArtifactPath: "coverage/matrix.json", total: 108, represented: 108, executed: counts.executed, deferred: counts.deferred, unrepresented: 0 },
  };
  const root = resolve("evidence/release1/p3-02"); await mkdir(resolve(root, "coverage"), { recursive: true });
  await writeFile(MATRIX_PATH, content); await writeFile(INPUT_PATH, `${JSON.stringify(input, null, 2)}\n`); await writeFile(MANIFEST_PATH, `${JSON.stringify(createEvidenceManifest(input), null, 2)}\n`);
}
