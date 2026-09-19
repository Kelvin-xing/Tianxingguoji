import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type ClientConfig } from "pg";
import { createTenantTransactionRunner, type DatabasePool,type DatabaseQuery } from "../../modules/shared/infrastructure/db.ts";
import { TrialMemberManagementService, TrialMemberError } from "../../modules/access/application/trial-member-management.ts";
import { PostgresqlTrialMemberRepository } from "../../modules/access/infrastructure/postgresql-trial-member-repository.ts";
import { buildAccessContext, type AccessContext } from "../../modules/access/domain/authorization.ts";
import type { TrialLevel } from "../../modules/access/domain/trial-policy.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

export async function assertTrialMemberCommands(config: ClientConfig): Promise<void> {
  const pool = new Pool({ ...config, max: 4 });
  const diagnosticPool:DatabasePool={async connect(){
    const connection=await pool.connect();
    return {async query<Row>(query:DatabaseQuery){
      try { const result=await connection.query(query.text,query.values ? [...query.values] : undefined);
        return {rows:result.rows as unknown as readonly Row[],rowCount:result.rowCount};
      } catch(error) {
        const failure=error as {code?:string;constraint?:string;message?:string};
        process.stdout.write(JSON.stringify({trial_member_sql_failure:{code:failure.code,constraint:failure.constraint,message:failure.message}})+"\n");
        throw error;
      }
    },release(error){connection.release(error);}};
  }};
  const runner = createTenantTransactionRunner(diagnosticPool, { expectedLoginUser: "tianxing_app" });
  const repository = new PostgresqlTrialMemberRepository(runner);
  const service = new TrialMemberManagementService(repository);
  const founder = NEON_TEST_PRINCIPALS[0]!;
  const l1 = NEON_TEST_PRINCIPALS[1]!;
  const l2 = NEON_TEST_PRINCIPALS[2]!;
  const l3 = NEON_TEST_PRINCIPALS[4]!;
  const org = NEON_TEST_ORGANIZATION.id;
  const actor = (user: typeof founder, level?: TrialLevel): AccessContext => buildAccessContext({
    userId: user.userId, organizationId: org, membershipId: user.membershipId,
    roles: [level ?? user.role], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
    ...(level ? { trialPrincipal: { userId: user.userId, organizationId: org, level, categories: [], active: true, recordVersion: 1 } } : {}),
  });
  const command = (level: TrialLevel, version: number | null, categories: string[] = [], status = "active") => ({
    level, categories, status, expectedRecordVersion: version, requestId: randomUUID(), idempotencyKey: randomUUID(),
  });
  const rejected = (code: string) => (error: unknown) => error instanceof TrialMemberError && error.code === code;
  try {
    const root = actor(founder);
    const before = await service.list(root);
    assert.equal(before.filter((member) => member.level !== null).length, 0);
    const bootstrap = await service.update({ actor: root, targetUserId: founder.userId, command: command("founder", null) });
    assert.equal(bootstrap.replayed, false);
    const request = { actor: root, targetUserId: l2.userId, command: command("l2", null, ["local_school", "international_school"]) };
    const first = await service.update(request);
    const replay = await service.update(request);
    assert.equal(replay.receiptId, first.receiptId);
    assert.equal(replay.replayed, true);
    await assert.rejects(service.update({ ...request, command: { ...request.command, categories: [] } }), rejected("IDEMPOTENCY_CONFLICT"));
    await service.update({ actor: root, targetUserId: l1.userId, command: command("l1", null) });
    await service.update({ actor: root, targetUserId: l3.userId, command: command("l3", null) });
    await assert.rejects(async () => service.update({ actor: actor(l1, "l1"), targetUserId: l2.userId, command: command("founder", 1) }), rejected("FORBIDDEN"));
    // Even a stale forged/pre-demotion Founder context cannot authorize a write at the repository boundary.
    await assert.rejects(service.update({ actor: actor(l1, "founder"), targetUserId: l2.userId, command: command("founder", 1) }), rejected("FORBIDDEN"));
    await assert.rejects(service.update({ actor: root, targetUserId: l2.userId, command: command("l2", 9) }), rejected("STALE_VERSION"));
    await assert.rejects(service.update({ actor: root, targetUserId: founder.userId, command: command("l1", 1) }), rejected("LAST_FOUNDER_REQUIRED"));
    const rows = await service.list(root);
    assert.deepEqual(rows.find((member) => member.userId === l2.userId)?.categories, ["international_school", "local_school"]);
    assert.equal(rows.find((member) => member.userId === l3.userId)?.level, "l3");

    const failingAudit = new TrialMemberManagementService({
      list: (input) => repository.list(input),
      update: (input) => repository.update({ ...input, effects: {
        audit: { ...input.effects.audit, id: first.receiptId },
        outbox: { ...input.effects.outbox, auditEventId: first.receiptId },
      } }),
    });
    await assert.rejects(failingAudit.update({ actor: root, targetUserId: l2.userId, command: command("l2", 1, []) }), rejected("UNAVAILABLE"));
    const afterRollback = (await service.list(root)).find((member) => member.userId === l2.userId)!;
    assert.equal(afterRollback.recordVersion, 1);
    assert.deepEqual(afterRollback.categories, ["international_school", "local_school"]);
    await service.update({ actor: root, targetUserId: l2.userId, command: command("l2", 1, []) });
    assert.deepEqual((await service.list(root)).find((member) => member.userId === l2.userId)?.categories, []);

    const counts = await runner.run({ organizationId: org, actorUserId: founder.userId }, async (tx) => {
      const result = await tx.query<{ n: string }>({ text: "SELECT count(*)::text AS n FROM audit_events WHERE event_type='access.trial_member.updated'" });
      return Number(result.rows[0]!.n);
    });
    assert.equal(counts, 5, "only successful non-replayed mutations create audit events");

    const disabledMember = NEON_TEST_PRINCIPALS[3]!;
    await service.update({ actor: root, targetUserId: disabledMember.userId, command: command("l3", null) });
    await service.update({ actor: root, targetUserId: disabledMember.userId, command: command("l3", 1, [], "disabled") });
    const disabledRoles = await runner.run({ organizationId: org, actorUserId: founder.userId }, async (tx) => {
      return (await tx.query({ text: "SELECT role FROM access_resolve_workspace_context($1,$2,$3)", values: [disabledMember.userId,org,disabledMember.membershipId] })).rows;
    });
    assert.deepEqual(disabledRoles, []);
    assert.equal((await service.list(root)).find((member) => member.userId === disabledMember.userId)?.status, "disabled");
    await assert.rejects(service.update({ actor: root, targetUserId: disabledMember.userId, command: command("l3", 2) }), rejected("INVALID"));
    await service.update({ actor: root, targetUserId: l1.userId, command: command("founder", 1) });
    const concurrent = await Promise.allSettled([
      service.update({ actor: root, targetUserId: founder.userId, command: command("l1", 1) }),
      service.update({ actor: actor(l1, "founder"), targetUserId: l1.userId, command: command("l1", 2) }),
    ]);
    assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
    const remaining = await runner.run({ organizationId: org, actorUserId: founder.userId }, async (tx) => {
      return (await tx.query<{ n: string }>({ text: "SELECT count(*)::text AS n FROM access_trial_members WHERE level='founder' AND status='active'" })).rows[0]!.n;
    });
    assert.equal(remaining, "1", "concurrent demotions preserve one Founder");
    process.stdout.write(JSON.stringify({ trial_member_commands: "pass", enrollment: "explicit", replay: "single_effect", stale_actor: "denied", audit_failure: "rolled_back", concurrent_last_founder: "protected" }) + "\n");
  } finally { await pool.end(); }
}
