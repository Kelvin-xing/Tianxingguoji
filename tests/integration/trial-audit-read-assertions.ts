import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";

import { PostgreSqlAuditReadRepository } from "../../modules/audit/infrastructure/read-repository.ts";
import type { RequestAccessActor } from "../../modules/access/public.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";

type Person = { readonly userId: string };
type Level = "founder" | "l1" | "l2" | "l3";

const actorFor = (organizationId: string, person: Person, level: Level): RequestAccessActor => ({
  userId: person.userId,
  organizationId,
  trialPrincipal: {
    userId: person.userId,
    organizationId,
    active: true,
    level,
    categories: ["international_school"],
    recordVersion: 1,
  },
});

export async function assertTrialAuditReads(input: {
  readonly config: ClientConfig;
  readonly organizationId: string;
  readonly founder: Person;
  readonly l1: Person;
  readonly l2: Person;
  readonly l3: Person;
}): Promise<void> {
  const { organizationId: org } = input;
  const client = new Client(input.config);
  await client.connect();
  await client.query("BEGIN");
  const runner: TenantTransactionRunner = {
    async run(context, operation) {
      const savepoint = `audit_read_${randomUUID().replaceAll("-", "")}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [
        context.organizationId,
        context.actorUserId,
      ]);
      try {
        const result = await operation({
          async query<Row = Record<string, unknown>>(query: { text: string; values?: readonly unknown[] }) {
            const response = await client.query(query.text, query.values ? [...query.values] : undefined);
            return { rows: response.rows as readonly Row[], rowCount: response.rowCount ?? 0 };
          },
        });
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
  };
  const repository = new PostgreSqlAuditReadRepository(runner);
  await client.query("SAVEPOINT trial_audit_reads");

  try {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [
      org,
      input.founder.userId,
    ]);
    const eventIds = {
      founderBusiness: randomUUID(),
      l2Business: randomUUID(),
      l3Task: randomUUID(),
      l3Business: randomUUID(),
      security: randomUUID(),
    };
    const rows = [
      [eventIds.founderBusiness, input.founder.userId, "cases.service_case_created", "case"],
      [eventIds.l2Business, input.l2.userId, "schools.change_submitted", "school"],
      [eventIds.l3Task, input.l3.userId, "tasks.task_created", "task"],
      [eventIds.l3Business, input.l3.userId, "cases.note_created", "case"],
      [eventIds.security, input.l1.userId, "identity.session.revoked", "session"],
    ] as const;

    for (const [id, actorUserId, eventType, resourceType] of rows) {
      await client.query(
        `INSERT INTO audit_events
          (id,organization_id,actor_user_id,actor_kind,event_type,event_version,action,
           resource_type,resource_id,outcome,request_id,metadata)
         VALUES ($1,$2,$3,'user',$4,1,'trial_read_fixture',$5,$6,'succeeded',$7,'{}'::jsonb)`,
        [id, org, actorUserId, eventType, resourceType, randomUUID(), `trial-audit-${id}`],
      );
    }

    const read = async (person: Person, level: Level, scope: "business" | "security" = "business") =>
      repository.list({
        organizationId: org,
        actor: actorFor(org, person, level),
        scope,
        limit: 100,
        before: null,
      });

    const founderBusiness = await read(input.founder, "founder");
    assert.deepEqual(
      new Set(founderBusiness.map((row) => row.id)),
      new Set([eventIds.founderBusiness, eventIds.l2Business, eventIds.l3Task, eventIds.l3Business]),
      "Founder business audit includes all business events",
    );
    assert.equal((await read(input.l1, "l1")).some((row) => row.id === eventIds.l2Business), true);
    assert.deepEqual(
      (await read(input.l2, "l2")).map((row) => row.id),
      [eventIds.l2Business],
      "L2 business audit is limited to the actor's own events until category facts exist",
    );
    assert.deepEqual(
      (await read(input.l3, "l3")).map((row) => row.id),
      [eventIds.l3Task],
      "L3 business audit is limited to the actor's task events",
    );
    assert.equal((await read(input.founder, "founder", "security")).length, 1);
    await assert.rejects(() => read(input.l1, "l1", "security"));

    const page = await repository.list({
      organizationId: org,
      actor: actorFor(org, input.founder, "founder"),
      scope: "business",
      limit: 2,
      before: null,
    });
    assert.equal(page.length, 2);
    const nextPage = await repository.list({
      organizationId: org,
      actor: actorFor(org, input.founder, "founder"),
      scope: "business",
      limit: 10,
      before: page.at(-1)!.occurredAt,
    });
    assert.ok(nextPage.every((row) => !page.some((previous) => previous.id === row.id)));

    process.stdout.write(JSON.stringify({
      trial_audit_reads: "pass",
      business: "founder_l1_all_l2_own_l3_task_only",
      security: "founder_only",
      paging: "cursor_disjoint",
    }) + "\n");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT trial_audit_reads");
    await client.query("RELEASE SAVEPOINT trial_audit_reads");
    await client.query("ROLLBACK");
    await client.end();
  }
}
