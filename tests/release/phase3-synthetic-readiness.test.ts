import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createEvidenceManifest } from "../../scripts/evidence/create-manifest.ts";

const FIXTURE_ROOT = resolve("tests/fixtures/release1/phase3");
const EVIDENCE_MANIFEST = resolve("evidence/release1/p3-01/manifest.v1.json");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(FIXTURE_ROOT, path), "utf8")) as T;
}

interface TypedScenarioVector {
  readonly id: string;
  readonly authority: readonly string[];
  readonly actor: {
    readonly mode: string;
    readonly status: string;
    readonly relation?: string;
  };
  readonly input: Readonly<Record<string, unknown>>;
  readonly preconditions: Readonly<Record<string, unknown>>;
  readonly expected: {
    readonly decision: string;
    readonly code?: string | null;
    readonly httpStatus?: number;
    readonly state?: string;
    readonly sideEffects?: Readonly<Record<string, unknown>>;
  };
  readonly tags?: readonly string[];
}

function assertTypedVectors(vectors: readonly TypedScenarioVector[]): void {
  const ids = new Set<string>();
  for (const vector of vectors) {
    assert.match(vector.id, /^[a-z][a-z0-9._-]+$/);
    assert.equal(ids.has(vector.id), false, `duplicate vector ${vector.id}`);
    ids.add(vector.id);
    assert.ok(vector.authority.length > 0, `${vector.id} has no authority`);
    assert.ok(vector.authority.every((value) => /^(?:AC|DEC|OD)-/.test(value)));
    assert.ok(["active", "disabled", "expired", "synthetic_system"].includes(vector.actor.status));
    assert.ok(Object.keys(vector.input).length > 0, `${vector.id} has no input`);
    assert.ok(Object.keys(vector.preconditions).length > 0, `${vector.id} has no preconditions`);
    assert.ok(
      ["allowed", "blocked", "denied", "needs_human", "passed"].includes(
        vector.expected.decision,
      ),
    );
    assert.deepEqual(Object.keys(vector).sort(), [
      "actor",
      "authority",
      "expected",
      "id",
      "input",
      "preconditions",
      ...(vector.tags === undefined ? [] : ["tags"]),
    ].sort());
    assert.ok(Object.keys(vector.actor).every((key) => ["mode", "relation", "status"].includes(key)));
    assert.ok(
      Object.keys(vector.expected).every((key) =>
        ["code", "decision", "httpStatus", "sideEffects", "state"].includes(key),
      ),
    );
    for (const key of [...Object.keys(vector.input), ...Object.keys(vector.preconditions)]) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `${vector.id} has unsafe fact key ${key}`);
    }
  }
}

test("publishes one closed, versioned synthetic scenario file set", async () => {
  const index = JSON.parse(
    await readFile(resolve(FIXTURE_ROOT, "scenario-manifest.v1.json"), "utf8"),
  ) as {
    schemaVersion: number;
    fixtureVersion: string;
    source: string;
    scenarioFiles: string[];
  };

  assert.deepEqual(index, {
    schemaVersion: 1,
    fixtureVersion: "release1-phase3-golden-v1",
    source: "synthetic",
    scenarioFiles: [
      "access-scopes.v1.json",
      "case-target-transitions.v1.json",
      "edge-failures.v1.json",
      "roles.v1.json",
      "task-transitions.v1.json",
    ],
  });
  assert.deepEqual((await readdir(FIXTURE_ROOT)).sort(), [
    ...index.scenarioFiles,
    "scenario-manifest.v1.json",
  ].sort());
});

test("maps every approved Release 1 role and bounded collaborator mode", async () => {
  const fixture = await readJson<{
    approvedOrganizationRoles: string[];
    boundedAccessModes: string[];
    scenarios: TypedScenarioVector[];
  }>("roles.v1.json");

  assert.deepEqual(fixture.approvedOrganizationRoles, [
    "admin",
    "advisor",
    "contractor",
    "data_reviewer",
    "founder",
  ]);
  assert.deepEqual(fixture.boundedAccessModes, ["case_collaborator"]);
  assertTypedVectors(fixture.scenarios);
  assert.deepEqual(
    [...new Set(fixture.scenarios.map(({ actor }) => actor.mode))].sort(),
    ["admin", "advisor", "case_collaborator", "contractor", "data_reviewer", "founder"],
  );
  const byId = new Map(fixture.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const [id, decision, code] of [
    ["authz.advisor.assigned_case", "allowed", null],
    ["authz.advisor.other_case", "denied", "CASE_ACCESS_DENIED"],
    ["authz.actor_disabled", "denied", "USER_DISABLED"],
    ["authz.grant_expired", "denied", "GRANT_EXPIRED"],
    ["authz.direct_api", "denied", "CASE_ACCESS_DENIED"],
    ["authz.id_guessing", "denied", "CASE_NOT_FOUND"],
    ["authz.search", "denied", "CASE_ACCESS_DENIED"],
    ["authz.export", "denied", "COLLABORATOR_EXPORT_DENIED"],
  ]) {
    const scenario = byId.get(id);
    assert.deepEqual([scenario?.expected.decision, scenario?.expected.code ?? null], [decision, code]);
  }
});

test("maps legal and illegal Case and SchoolTarget transitions without deriving target facts", async () => {
  const fixture = await readJson<{
    caseTransitions: TypedScenarioVector[];
    targetTransitions: TypedScenarioVector[];
    outcomeVectors: TypedScenarioVector[];
    illegalTransitions: TypedScenarioVector[];
  }>("case-target-transitions.v1.json");

  assertTypedVectors([
    ...fixture.caseTransitions,
    ...fixture.targetTransitions,
    ...fixture.outcomeVectors,
    ...fixture.illegalTransitions,
  ]);
  assert.deepEqual(
    fixture.caseTransitions.map(({ input }) => `${input.from}->${input.to}`),
    [
      "signed->background_collection",
      "background_collection->school_selection_confirmed",
      "school_selection_confirmed->interview_preparation",
      "interview_preparation->application_submitted",
      "application_submitted->awaiting_result",
      "awaiting_result->offer_confirmed",
      "offer_confirmed->closed",
      "active->paused",
      "paused->active",
      "pre_submission->cancelled",
      "background_collection->signed",
    ],
  );
  assert.ok(fixture.caseTransitions.every(({ expected }) => expected.decision === "allowed"));
  for (const id of ["case.pause", "case.resume", "case.cancel", "case.rollback_immediate_prior"]) {
    const vector = fixture.caseTransitions.find((candidate) => candidate.id === id);
    assert.equal(typeof vector?.input.reason, "string");
    assert.ok((vector?.input.reason as string).length > 0);
  }
  const rollback = fixture.caseTransitions.find(({ id }) => id === "case.rollback_immediate_prior");
  assert.deepEqual(
    [rollback?.actor.mode, rollback?.input.from, rollback?.input.to, rollback?.preconditions.immediate_prior],
    ["founder", "background_collection", "signed", "signed"],
  );
  assert.equal(fixture.targetTransitions.length, 14);
  assert.ok(fixture.targetTransitions.every(({ expected }) => expected.decision === "allowed"));
  assert.deepEqual(
    fixture.outcomeVectors.map(({ input }) => input.code).sort(),
    ["aborted", "accepted", "not_submitted", "rejected", "waitlisted", "withdrawn"],
  );
  for (const vector of fixture.outcomeVectors) {
    assert.deepEqual(Object.keys(vector.input).sort(), [
      "actor_id",
      "code",
      "evidence_source",
      "occurred_on",
      "record_version",
      "source_reference",
      "target_state",
    ]);
    assert.equal(vector.expected.decision, "allowed");
  }
  const illegal = new Map(fixture.illegalTransitions.map((scenario) => [scenario.id, scenario]));
  for (const [id, code] of [
    ["case.skip_stage", "CASE_TRANSITION_NOT_ALLOWED"],
    ["case.pause_wrong_actor", "CASE_PRIMARY_ADVISOR_REQUIRED"],
    ["case.pause_missing_reason", "CASE_REASON_REQUIRED"],
    ["case.resume_wrong_actor", "CASE_FOUNDER_REQUIRED"],
    ["case.resume_missing_reason", "CASE_REASON_REQUIRED"],
    ["case.cancel_wrong_actor", "CASE_FOUNDER_REQUIRED"],
    ["case.cancel_missing_reason", "CASE_REASON_REQUIRED"],
    ["case.close_with_open_target", "CASE_TARGET_OUTCOMES_REQUIRED"],
    ["case.close_with_open_task", "CASE_OPEN_TASKS_BLOCK_CLOSE"],
    ["case.cancel_after_submission", "CASE_CANCEL_AFTER_SUBMISSION_DENIED"],
    ["case.rollback_not_immediate", "CASE_TRANSITION_NOT_ALLOWED"],
    ["target.skip_submission", "TARGET_TRANSITION_NOT_ALLOWED"],
    ["target.missing_submission_evidence", "TARGET_EVIDENCE_REQUIRED"],
    ["target.terminal_without_outcome", "TARGET_OUTCOME_REQUIRED"],
  ]) {
    assert.deepEqual(
      [illegal.get(id)?.expected.decision, illegal.get(id)?.expected.code],
      ["denied", code],
    );
  }
});

test("maps the approved Task matrix and leaves non-command states without invented transitions", async () => {
  const fixture = await readJson<{
    stateCoverage: string[];
    approvedTransitions: TypedScenarioVector[];
    nonCommandStates: string[];
    illegalTransitions: TypedScenarioVector[];
  }>("task-transitions.v1.json");

  assertTypedVectors([...fixture.approvedTransitions, ...fixture.illegalTransitions]);
  assert.deepEqual(fixture.stateCoverage, [
    "accepted",
    "approved",
    "assigned",
    "cancelled",
    "completed",
    "created",
    "overdue",
    "reassigned",
    "rejected",
  ]);
  assert.deepEqual(
    fixture.approvedTransitions.map(({ input }) => `${input.from}->${input.to}`),
    [
      "assigned->accepted",
      "assigned->rejected",
      "accepted->completed",
      "assigned->reassigned",
      "accepted->reassigned",
      "assigned->cancelled",
      "accepted->cancelled",
      "completed->approved",
    ],
  );
  assert.ok(fixture.approvedTransitions.every(({ expected }) => expected.decision === "allowed"));
  assert.deepEqual(fixture.nonCommandStates, ["created", "overdue"]);
  assert.deepEqual(
    fixture.illegalTransitions.map(({ id, expected }) => [id, expected.code]),
    [
      ["task.self_approval", "TASK_APPROVAL_SEPARATION_REQUIRED"],
      ["task.missing_reason", "TASK_REASON_REQUIRED"],
      ["task.contractor_owner_action", "TASK_CONTRACTOR_ACTOR_NOT_ALLOWED"],
      ["task.unapproved_transition", "TASK_TRANSITION_NOT_ALLOWED"],
    ],
  );
});

test("maps every collaborator scope, capability, expiry and immediate denial exception", async () => {
  const fixture = await readJson<{
    scopes: string[];
    capabilities: string[];
    maximumDurationMs: number;
    sensitiveScopes: string[];
    scenarios: TypedScenarioVector[];
  }>("access-scopes.v1.json");

  assertTypedVectors(fixture.scenarios);
  assert.deepEqual(fixture.scopes, [
    "case_summary",
    "communications",
    "education_profile",
    "identity_contact",
    "internal_notes",
    "school_targets",
    "task_workspace",
  ]);
  assert.deepEqual(fixture.capabilities, ["comment", "edit", "view"]);
  assert.equal(fixture.maximumDurationMs, 604_800_000);
  assert.deepEqual(fixture.sensitiveScopes, ["identity_contact", "internal_notes"]);
  assert.deepEqual(
    [...new Set(fixture.scenarios.map(({ input }) => input.scope))].sort(),
    fixture.scopes,
  );
  assert.deepEqual(
    [...new Set(fixture.scenarios.map(({ input }) => input.capability))].filter(Boolean).sort(),
    ["comment", "edit", "export", "view"],
  );
  const allowedGrants = fixture.scenarios.filter(
    ({ input, expected }) => input.command === "grant" && expected.decision === "allowed",
  );
  for (const vector of allowedGrants) {
    const startsAt = Date.parse(String(vector.preconditions.starts_at));
    const expiresAt = Date.parse(String(vector.preconditions.expires_at));
    const caseEndsAt = Date.parse(String(vector.preconditions.case_ends_at));
    assert.ok(expiresAt - startsAt <= fixture.maximumDurationMs, `${vector.id} exceeds seven days`);
    assert.ok(expiresAt <= caseEndsAt, `${vector.id} exceeds case end`);
  }
  for (const scope of fixture.sensitiveScopes) {
    const vector = allowedGrants.find(({ input }) => input.scope === scope);
    assert.deepEqual(
      [
        vector?.preconditions.approver_role,
        vector?.preconditions.approval_status,
        vector?.input.reason_present,
      ],
      ["founder", "approved", true],
    );
  }
  for (const [id, code] of [
    ["scope.expired", "GRANT_EXPIRED"],
    ["scope.revoked", "GRANT_NOT_ACTIVE"],
    ["scope.case_closed", "COLLABORATION_INACTIVE"],
    ["scope.account_disabled", "USER_DISABLED"],
    ["scope.export", "COLLABORATOR_EXPORT_DENIED"],
    ["scope.sensitive_pending", "GRANT_NOT_ACTIVE"],
  ]) {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === id);
    assert.deepEqual([scenario?.expected.decision, scenario?.expected.code], ["denied", code]);
  }
});

test("maps empty, long, error, denied, exception, concurrency, replay and failure shapes", async () => {
  const fixture = await readJson<{
    requiredTags: string[];
    requiredFailureIds: string[];
    scenarios: TypedScenarioVector[];
  }>("edge-failures.v1.json");

  assertTypedVectors(fixture.scenarios);
  assert.deepEqual(fixture.requiredTags, [
    "concurrency",
    "denied",
    "empty",
    "error",
    "exception",
    "failure",
    "long",
    "replay",
  ]);
  const represented = new Set(fixture.scenarios.flatMap(({ tags }) => tags));
  assert.ok(fixture.requiredTags.every((tag) => represented.has(tag)));
  assert.deepEqual(fixture.requiredFailureIds, [
    "failure.bad_publication",
    "failure.database_failover",
    "failure.hk_outage",
    "failure.mandatory_audit_unavailable",
    "failure.outbox_poison",
    "failure.partial_migration",
    "failure.pii_leakage",
    "failure.provider_timeout",
    "failure.reconstruction_interruption",
    "failure.s3_event_missed",
    "failure.s3_event_replay",
    "failure.scanner_timeout",
    "failure.stale_index",
    "failure.support_abuse",
    "failure.tenant_context_missing",
    "failure.tenant_context_residual",
  ]);
  const byId = new Map(fixture.scenarios.map((scenario) => [scenario.id, scenario]));
  assert.ok(fixture.requiredFailureIds.every((id) => byId.has(id)));
  assert.ok(
    fixture.requiredFailureIds.every((id) =>
      byId.get(id)?.authority.some((value) => value === "DEC-057" || value === "AC-08"),
    ),
  );
  assert.deepEqual(
    [byId.get("concurrency.stale_write")?.expected.httpStatus, byId.get("concurrency.stale_write")?.expected.code],
    [409, "VERSION_CONFLICT"],
  );
  assert.equal(
    byId.get("replay.idempotent_command")?.expected.sideEffects?.duplicate_effects,
    0,
  );
  assert.equal(byId.get("failure.s3_event_replay")?.expected.sideEffects?.duplicate_effects, 0);
});

test("pins deterministic synthetic-only checksums while release eligibility and flags stay off", async () => {
  const evidence = JSON.parse(await readFile(EVIDENCE_MANIFEST, "utf8")) as {
    evidenceVersion: string;
    source: string;
    verification: string;
    coverageStatus: string;
    releaseState: string;
    releaseEligible: boolean;
    featureFlags: Record<string, boolean>;
    approvals: Array<{ gate: string; status: string }>;
    fixtureArtifacts: Array<{ path: string; sha256: string; bytes: number }>;
    excludedSemantics: string[];
    fixtureSchema: {
      vectorRequiredKeys: string[];
      actorAllowedKeys: string[];
      expectedAllowedKeys: string[];
    };
  };
  const expectedArtifacts = [
    ["access-scopes.v1.json", "1faede000a9c311a7f70fb388076541db67444db0d79051de437a83cde3ceec3", 6615],
    ["case-target-transitions.v1.json", "5adac5e997937c780b8f5948e60cb07a9142bdcf3f6f164924b06404e1290a0e", 19800],
    ["edge-failures.v1.json", "421b38b054089b590cc7fd6e81ddedc5502fcf01b30d16156660d9ce2f60eb5d", 11803],
    ["roles.v1.json", "d4987a7fb9c1ba1061776d5e0e7a2ae3c5f091c09b232312310d2ef2ffd2b5d0", 5165],
    ["scenario-manifest.v1.json", "af502b81d27c6fcadc1eef3d01d095b8fb8f59620bb25ec9544a31e98dd190e3", 274],
    ["task-transitions.v1.json", "5ea7c5e8ac1bfafcec8f02e80633ae944db6798ca12235463b137f97f5748952", 4638],
  ] as const;

  assert.equal(evidence.evidenceVersion, "p3-01-v1");
  assert.equal(evidence.source, "synthetic");
  assert.equal(evidence.verification, "pass");
  assert.equal(evidence.coverageStatus, "mapped_not_executed");
  assert.equal(evidence.releaseState, "blocked");
  assert.equal(evidence.releaseEligible, false);
  assert.ok(Object.values(evidence.featureFlags).every((enabled) => enabled === false));
  assert.ok(evidence.approvals.every(({ status }) => status === "not_requested"));
  assert.deepEqual(evidence.excludedSemantics, ["DP-01..12", "R1X-billing", "R1X-portal"]);
  assert.deepEqual(evidence.fixtureSchema, {
    vectorRequiredKeys: ["actor", "authority", "expected", "id", "input", "preconditions"],
    actorAllowedKeys: ["mode", "relation", "status"],
    expectedAllowedKeys: ["code", "decision", "httpStatus", "sideEffects", "state"],
  });
  assert.deepEqual(
    evidence.fixtureArtifacts.map(({ path, sha256, bytes }) => [path, sha256, bytes]),
    expectedArtifacts,
  );

  for (const [path, expectedSha256, expectedBytes] of expectedArtifacts) {
    const bytes = await readFile(resolve(FIXTURE_ROOT, path));
    assert.equal(bytes.byteLength, expectedBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
    const text = bytes.toString("utf8");
    assert.doesNotMatch(text, /(?:subscription|billing|parent_portal|guardian_portal|DP-(?:0[1-9]|1[0-2]))/i);
    createEvidenceManifest({
      schemaVersion: 1,
      evidenceType: "release1.synthetic",
      source: "synthetic",
      runId: `p3-01-${path.replace(/[^a-z0-9]+/g, "-")}`,
      inputVersion: "release1-phase3-golden-v1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      scenarios: [{
        id: `fixture.${path.replace(/[^a-z0-9]+/g, "-")}`,
        description: "Synthetic fixture passes the established evidence safety scanner.",
        expectedState: "blocked",
        actualState: "blocked",
        evidence: { synthetic_only: true },
        artifactPaths: [`fixtures/${path}`],
      }],
      artifacts: [{ path: `fixtures/${path}`, content: text }],
    });
  }
});
