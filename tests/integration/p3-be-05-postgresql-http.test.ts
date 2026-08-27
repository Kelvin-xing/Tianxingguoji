import assert from "node:assert/strict";
import test from "node:test";

const adminUrl = process.env.P3_ISOLATED_POSTGRES_ADMIN_URL;
const appUrl = process.env.P3_ISOLATED_POSTGRES_APP_URL;
const httpBaseUrl = process.env.P3_HTTP_BASE_URL;

test("P3-BE-05 reaches the isolated PostgreSQL endpoint when configured", { skip: !adminUrl || !appUrl ? "blocked: P3 isolated PostgreSQL URLs are not configured" : false }, async () => {
  const { default: pg } = await import("pg");
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const application = new pg.Pool({ connectionString: appUrl, max: 1 });
  try {
    const result = await admin.query<{ one: number; task_table: string | null }>({
      text: "SELECT 1 AS one, to_regclass('public.tasks_tasks') AS task_table",
    });
    assert.equal(result.rows[0]?.one, 1);
    assert.equal(result.rows[0]?.task_table, "tasks_tasks");
    await application.query("SELECT 1");
  } finally {
    await application.end();
    await admin.end();
  }
});

test("P3-BE-05 exercises the HTTP route when a running app is configured", { skip: !httpBaseUrl ? "blocked: P3 HTTP base URL is not configured" : false }, async () => {
  const response = await fetch(`${httpBaseUrl}/api/v1/tasks/provision`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "p3-http-probe" },
    body: JSON.stringify({}),
  });
  assert.ok(response.status >= 400 && response.status < 600);
  assert.notEqual(response.status, 500);
});

test("P3-BE-05 failure injection is wired to the transaction boundary", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile("modules/tasks/infrastructure/p3-postgresql-repository.ts", "utf8"));
  assert.match(source, /failBeforeCommit/);
  const { P3TaskService } = await import("../../modules/tasks/application/p3-service.ts");
  let injected = false;
  const repository = { ensureTargetTask: async () => { injected = true; throw new Error("injected P3 commit failure"); }, transitionTargetTask: async () => { throw new Error("unused"); } };
  const service = new P3TaskService(repository);
  await assert.rejects(service.ensureTargetTask({
    actor: { organizationId: id(1), userId: id(5), workspaceCapabilities: ["tasks.create"] as const },
    kind: "application_prepare_submit", caseId: id(2), targetId: id(3), assignmentId: id(4), sourceEventId: id(9),
    dueAt: "2026-09-01T00:00:00.000Z", title: "Submit application", brief: "Collect and submit the application.",
    taskKey: "p3-failure", requestId: "p3-failure", idempotencyKey: "p3-failure-key",
  }), /injected P3 commit failure/);
  assert.equal(injected, true);
});
function id(last: number) { return `10000000-0000-4000-8000-0000000000${String(last).padStart(2, "0")}`; }
