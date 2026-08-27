import assert from "node:assert/strict";
import test from "node:test";

import { PostgresqlGuardianRelationshipRepository } from
  "../../../modules/crm/infrastructure/postgresql-guardian-relationship-repository.ts";
import type {
  DatabaseQuery,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const CONTEXT = Object.freeze({
  organizationId: "51000000-0000-4000-8000-000000000001",
  actorUserId: "51000000-0000-4000-8000-000000000101",
  studentId: "51000000-0000-4000-8000-000000000601",
});

test("history is tenant scoped and redacts deleted guardian", async () => {
  const seen: DatabaseQuery[] = [];
  let context: unknown;
  const runner: TenantTransactionRunner = { async run<Result>(c: TenantDatabaseContext, op: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> { context=c; let index=0; return op({query: async <Row>(q:DatabaseQuery)=>{seen.push(q);index++;return {rows:(index===1?[{id:CONTEXT.studentId,display_name:"Student"}]:[{relationship_id:"r1",student_id:CONTEXT.studentId,guardian_id:"g1",relationship_type:"mother",relationship_description:null,is_legal_guardian:true,is_primary_contact:false,is_emergency_contact:false,is_billing_contact:false,notification_consent:false,starts_at:"2026-01-02T00:00:00.000Z",ends_at:"2026-02-02T00:00:00.000Z",record_version:2,guardian_display_name:"Deleted guardian",email_hint:null,phone_hint:null},{relationship_id:"r2",student_id:CONTEXT.studentId,guardian_id:"g2",relationship_type:"father",relationship_description:null,is_legal_guardian:true,is_primary_contact:true,is_emergency_contact:false,is_billing_contact:false,notification_consent:false,starts_at:"2026-01-01T00:00:00.000Z",ends_at:null,record_version:1,guardian_display_name:"Current",email_hint:null,phone_hint:null}]) as Row[]};}}) as Promise<Result>; } };
  const result=await new PostgresqlGuardianRelationshipRepository(runner).listHistory(CONTEXT);
  assert.deepEqual(context,{organizationId:CONTEXT.organizationId,actorUserId:CONTEXT.actorUserId});
  assert.equal(seen.length,2); for(const q of seen){assert.doesNotMatch(q.text,new RegExp(CONTEXT.studentId));assert.deepEqual(q.values,[CONTEXT.studentId,CONTEXT.organizationId]);}
  assert.match(seen[1]!.text,/relationship\.organization_id=\$2/);assert.match(seen[1]!.text,/ORDER BY relationship\.starts_at DESC,relationship\.id DESC/);assert.match(seen[1]!.text,/CASE WHEN guardian\.status='deleted'/);
  assert.equal(result?.relationships.length,2);assert.equal(result?.relationships[0]?.relationship.endsAt,"2026-02-02T00:00:00.000Z");assert.equal(result?.relationships[0]?.guardian.displayName,"Deleted guardian");assert.equal(result?.relationships[0]?.guardian.emailHint,null);
});

test("current reads include pending Student and Guardian while keeping masked hints", async () => {
  const queries: string[] = [];
  const repository = new PostgresqlGuardianRelationshipRepository(recordingRunner(queries));

  const result = await repository.listCurrent(CONTEXT);

  assert.ok(result);
  assert.deepEqual(result.student, {
    id: CONTEXT.studentId,
    displayName: "Synthetic Pending Student",
  });
  assert.deepEqual(result.relationships[0]?.guardian, {
    id: "51000000-0000-4000-8000-000000000701",
    displayName: "Synthetic Pending Guardian",
    emailHint: "s***@example.invalid",
    phoneHint: "******1234",
  });
  assert.match(queries[0]!, /status IN \('active', 'pending_delete'\)/);
  assert.match(queries[1]!, /guardian\.status IN \('active', 'pending_delete'\)/);
});

test("reports only an allowlisted PostgreSQL concurrency code", async () => {
  const reported: unknown[] = [];
  const cause = Object.assign(new Error("raw-secret database message"), {
    code: "57014",
    severity: "ERROR",
    detail: "raw-secret detail",
    query: "SELECT raw-secret",
    stack: "raw-secret stack",
  });
  const repository = new PostgresqlGuardianRelationshipRepository(
    failingRunner(cause),
    (evidence) => reported.push(evidence),
  );

  await assert.rejects(repository.listCurrent(CONTEXT), unavailable());
  assert.deepEqual(reported, [{ postgresCode: "57014" }]);
  assert.doesNotMatch(JSON.stringify(reported), /raw-secret|message|detail|query|stack/);
});

test("does not classify Node error codes or arbitrary objects as PostgreSQL concurrency failures", async () => {
  for (const cause of [Object.assign(new Error("missing"), { code: "ENOENT" }), {
    code: "40P01", severity: "ERROR",
  }]) {
    const reported: unknown[] = [];
    const repository = new PostgresqlGuardianRelationshipRepository(
      failingRunner(cause),
      (evidence) => reported.push(evidence),
    );
    await assert.rejects(repository.listCurrent(CONTEXT), unavailable());
    assert.deepEqual(reported, []);
  }
});

test("accepts multiple active Founder and Advisor bindings, but rejects zero", async () => {
  const runner: TenantTransactionRunner = {
    async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
      let index = 0;
      return operation({ query: async <Row>(query: DatabaseQuery) => {
        index += 1;
        if (index === 1) return { rows: [{ binding_id: "b-founder" }, { binding_id: "b-advisor" }] as Row[] };
        if (query.text.includes("FROM crm_students")) return { rows: [{ id: CONTEXT.studentId, display_name: "Student" }] as Row[] };
        return { rows: [{ id: "g1", display_name: "Guardian", email_hint: null, phone_hint: null }] as Row[] };
      } });
    },
  };
  const result = await new PostgresqlGuardianRelationshipRepository(runner).searchGuardians({ ...CONTEXT, query: "gu" });
  assert.equal(result?.length, 1);

  const deniedRunner: TenantTransactionRunner = {
    async run<Result>(_context: TenantDatabaseContext, operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
      return operation({ query: async <Row>() => ({ rows: [] as Row[] }) });
    },
  };
  await assert.rejects(
    new PostgresqlGuardianRelationshipRepository(deniedRunner).searchGuardians({ ...CONTEXT, query: "gu" }),
    /FORBIDDEN/,
  );
});

function failingRunner(cause: unknown): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return operation(Object.freeze({
        async query(): Promise<never> { throw cause; },
      }));
    },
  });
}

function recordingRunner(queries: string[]): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      let index = 0;
      return operation(Object.freeze({
        async query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<{ rows: readonly Row[] }> {
          queries.push(query.text);
          const rows = index++ === 0 ? [{
            id: CONTEXT.studentId,
            display_name: "Synthetic Pending Student",
          }] : [{
            relationship_id: "51000000-0000-4000-8000-000000000801",
            student_id: CONTEXT.studentId,
            guardian_id: "51000000-0000-4000-8000-000000000701",
            relationship_type: "mother",
            is_legal_guardian: true,
            is_primary_contact: true,
            is_emergency_contact: false,
            is_billing_contact: false,
            notification_consent: false,
            starts_at: "2026-08-23T00:00:00.000Z",
            record_version: 2,
            student_display_name: "Synthetic Pending Student",
            guardian_display_name: "Synthetic Pending Guardian",
            email_hint: "s***@example.invalid",
            phone_hint: "******1234",
          }];
          return { rows: rows as unknown as Row[] };
        },
      }));
    },
  });
}

function unavailable() {
  return (error: unknown) => error instanceof Error &&
    error.name === "GuardianRelationshipError" &&
    (error as Error & { readonly code?: unknown }).code === "GUARDIAN_RELATIONSHIP_UNAVAILABLE";
}
