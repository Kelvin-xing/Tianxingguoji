import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseDashboardProjectionError,
  CaseDashboardProjectionService,
  buildCaseDashboardProjection,
  rebuildCaseDashboardProjection,
  type CaseDashboardProjectionRepository,
  type CaseDashboardProjectionSource,
  type DashboardAuthority,
} from "../../modules/operations/case-dashboard-projection.ts";
import { createCaseDashboardGetHandler } from "../../modules/operations/case-dashboard-route.ts";
import {
  CaseDashboardRuntimeUnavailable,
  getCaseDashboardRuntime,
} from "../../modules/operations/case-dashboard-runtime.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const FOUNDER_ID = "22222222-2222-4222-8222-222222222222";
const ADVISOR_ID = "33333333-3333-4333-8333-333333333333";
const COLLABORATOR_ID = "44444444-4444-4444-8444-444444444444";
const CONTRACTOR_ID = "55555555-5555-4555-8555-555555555555";
const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW_MS = 1_754_265_600_000;

const source: CaseDashboardProjectionSource = Object.freeze({
  schemaVersion: "case_dashboard_source_v1",
  sourceSnapshotId: "source-20260810-001",
  sourceCapturedAtMs: NOW_MS - 1_000,
  organizationId: ORGANIZATION_ID,
  cases: Object.freeze([
    {
      caseId: CASE_B,
      organizationId: ORGANIZATION_ID,
      caseNumber: "K12-2026-002",
      studentDisplayName: "Student B",
      stage: "school_selection_confirmed",
      blockerCount: 0,
      nextAction: "Confirm shortlist",
      nextActionDueAtMs: NOW_MS + 86_400_000,
      educationProfileCompleteness: 75,
      schoolTargetCount: 3,
      openTaskCount: 2,
      unreadCommunicationCount: 1,
    },
    {
      caseId: CASE_A,
      organizationId: ORGANIZATION_ID,
      caseNumber: "K12-2026-001",
      studentDisplayName: "Student A",
      stage: "background_collection",
      blockerCount: 2,
      nextAction: "Complete assessment",
      nextActionDueAtMs: null,
      educationProfileCompleteness: 40,
      schoolTargetCount: 0,
      openTaskCount: 4,
      unreadCommunicationCount: 0,
    },
  ]),
});

test("live build and rebuild have one canonical hash for the same source snapshot", () => {
  const live = buildCaseDashboardProjection(source);
  const rebuilt = rebuildCaseDashboardProjection({ ...source, cases: [...source.cases].reverse() });

  assert.equal(live.contentHash, rebuilt.contentHash);
  assert.deepEqual(live.cases.map((item) => item.caseId), [CASE_A, CASE_B]);
  assert.notEqual(
    live.contentHash,
    rebuildCaseDashboardProjection({
      ...source,
      cases: source.cases.map((item) =>
        item.caseId === CASE_A ? { ...item, blockerCount: 3 } : item,
      ),
    }).contentHash,
  );
});

test("Founder sees all organization Cases and assigned Advisor sees assigned Cases only", async () => {
  const founder = await readFor({ kind: "founder" }, "founder", FOUNDER_ID);
  assert.deepEqual(founder.cases.map((item) => item.case_id), [CASE_A, CASE_B]);
  assert.equal(founder.cases[0]?.summary?.student_display_name, "Student A");

  const advisor = await readFor(
    { kind: "advisor", assignedCaseIds: [CASE_B] },
    "advisor",
    ADVISOR_ID,
  );
  assert.deepEqual(advisor.cases.map((item) => item.case_id), [CASE_B]);
  assert.equal(advisor.cases[0]?.tasks?.open_count, 2);
});

test("collaborator output follows only current scopes and never exposes sensitive or export fields", async () => {
  const result = await readFor(
    {
      kind: "collaborator",
      grants: [
        grant(CASE_A, "case_summary", "view"),
        grant(CASE_A, "task_workspace", "edit"),
        grant(CASE_A, "identity_contact", "view"),
        grant(CASE_B, "school_targets", "comment", { status: "revoked" }),
        grant(CASE_B, "internal_notes", "view"),
      ],
    },
    "advisor",
    COLLABORATOR_ID,
  );

  assert.equal(result.cases.length, 1);
  assert.deepEqual(Object.keys(result.cases[0]!).sort(), ["case_id", "summary", "tasks"]);
  assert.deepEqual(result.cases[0]?.scopes, undefined);
  assert.equal(JSON.stringify(result).includes("identity_contact"), false);
  assert.equal(JSON.stringify(result).includes("internal_notes"), false);
  assert.equal(JSON.stringify(result).includes("export"), false);
});

test("expired and not-yet-started grants deny immediately at request time", async () => {
  const result = await readFor(
    {
      kind: "collaborator",
      grants: [
        grant(CASE_A, "case_summary", "view", { expiresAtMs: NOW_MS }),
        grant(CASE_B, "task_workspace", "view", { startsAtMs: NOW_MS + 1 }),
      ],
    },
    "advisor",
    COLLABORATOR_ID,
  );
  assert.deepEqual(result.cases, []);
});

test("contractor is denied before a projection repository read", async () => {
  let calls = 0;
  const repository: CaseDashboardProjectionRepository = {
    async readDashboardTransaction() {
      calls += 1;
      return { projection: buildCaseDashboardProjection(source), authority: { kind: "denied" } };
    },
  };
  const service = new CaseDashboardProjectionService({ repository, nowMs: () => NOW_MS });

  await assert.rejects(
    service.getDashboard({ actor: actor("contractor", CONTRACTOR_ID) }),
    projectionError("CASE_DASHBOARD_FORBIDDEN"),
  );
  assert.equal(calls, 0);
});

test("malformed or cross-organization projection fails without partial disclosure", async () => {
  const projection = buildCaseDashboardProjection(source);
  const repository: CaseDashboardProjectionRepository = {
    async readDashboardTransaction() {
      return {
        projection: { ...projection, organizationId: "99999999-9999-4999-8999-999999999999" },
        authority: { kind: "founder" },
      };
    },
  };
  const service = new CaseDashboardProjectionService({ repository, nowMs: () => NOW_MS });

  await assert.rejects(
    service.getDashboard({ actor: actor("founder", FOUNDER_ID) }),
    projectionError("CASE_DASHBOARD_PROJECTION_INVALID"),
  );
});

test("dashboard GET uses the versioned no-store envelope and safe authentication errors", async () => {
  const unauthenticated = createCaseDashboardGetHandler({
    getSessionSecret: async () => null,
    requireSession: async () => actor("founder", FOUNDER_ID),
    getDashboardService: () => serviceFor({ kind: "founder" }),
  });
  const denied = await unauthenticated(new Request("https://erp.example/api/v1/dashboard/cases"));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal((await denied.json()).error.code, "UNAUTHENTICATED");

  const authenticated = createCaseDashboardGetHandler({
    getSessionSecret: async () => "opaque-secret",
    requireSession: async () => actor("founder", FOUNDER_ID),
    getDashboardService: () => serviceFor({ kind: "founder" }),
  });
  const response = await authenticated(new Request("https://erp.example/api/v1/dashboard/cases"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.api_version, "v1");
  assert.deepEqual(body.data.cases.map((item: { case_id: string }) => item.case_id), [CASE_A, CASE_B]);
});

test("dashboard GET maps denied authority and unavailable composition without details", async () => {
  const forbidden = createCaseDashboardGetHandler({
    getSessionSecret: async () => "opaque-secret",
    requireSession: async () => actor("advisor", ADVISOR_ID),
    getDashboardService: () => serviceFor({ kind: "denied" }),
  });
  const deniedResponse = await forbidden(new Request("https://erp.example/api/v1/dashboard/cases"));
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual((await deniedResponse.json()).error.details, {});

  const unavailable = createCaseDashboardGetHandler({
    getSessionSecret: async () => "opaque-secret",
    requireSession: async () => actor("founder", FOUNDER_ID),
    getDashboardService: () => getCaseDashboardRuntime().service,
  });
  const unavailableResponse = await unavailable(new Request("https://erp.example/api/v1/dashboard/cases"));
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).error.code, "SERVICE_UNAVAILABLE");
  assert.throws(() => getCaseDashboardRuntime(), CaseDashboardRuntimeUnavailable);
});

async function readFor(
  authority: DashboardAuthority,
  role: "founder" | "advisor",
  userId: string,
) {
  const repository: CaseDashboardProjectionRepository = {
    async readDashboardTransaction(input) {
      assert.equal(input.organizationId, ORGANIZATION_ID);
      assert.equal(input.nowMs, NOW_MS);
      return { projection: buildCaseDashboardProjection(source), authority };
    },
  };
  return new CaseDashboardProjectionService({ repository, nowMs: () => NOW_MS }).getDashboard({
    actor: actor(role, userId),
  });
}

function serviceFor(authority: DashboardAuthority) {
  const repository: CaseDashboardProjectionRepository = {
    async readDashboardTransaction() {
      return { projection: buildCaseDashboardProjection(source), authority };
    },
  };
  return new CaseDashboardProjectionService({ repository, nowMs: () => NOW_MS });
}

function actor(role: "founder" | "advisor" | "contractor", userId: string) {
  return {
    userId,
    organizationId: ORGANIZATION_ID,
    role,
    sessionId: "66666666-6666-4666-8666-666666666666",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  } as const;
}

function grant(
  caseId: string,
  scope: "case_summary" | "school_targets" | "task_workspace" | "identity_contact" | "internal_notes",
  capability: "view" | "comment" | "edit",
  overrides: Partial<{
    status: "active" | "pending_approval" | "revoked" | "expired";
    startsAtMs: number;
    expiresAtMs: number;
  }> = {},
) {
  return {
    organizationId: ORGANIZATION_ID,
    caseId,
    scope,
    capability,
    status: "active" as const,
    startsAtMs: NOW_MS - 1,
    expiresAtMs: NOW_MS + 1,
    ...overrides,
  };
}

function projectionError(code: CaseDashboardProjectionError["code"]) {
  return (error: unknown) =>
    error instanceof CaseDashboardProjectionError && error.code === code;
}
