import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeWorkspaceCapabilities } from "../../../modules/access/public.ts";
import {
  CandidateGuardianContextError,
  CandidateGuardianContextService,
  type CandidateGuardianContextRepository,
} from "../../../modules/cases/application/candidate-guardian-context-service.ts";
import { PostgresqlCandidateGuardianContextRepository } from "../../../modules/cases/infrastructure/postgresql-candidate-guardian-context-repository.ts";
import {
  GuardianConfirmationOptionsError,
  GuardianConfirmationOptionsService,
} from "../../../modules/crm/application/guardian-confirmation-options-service.ts";
import { PostgresqlGuardianConfirmationOptionsRepository } from "../../../modules/crm/infrastructure/postgresql-guardian-confirmation-options-repository.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantTransactionContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = Object.freeze({
  organization: "72000000-0000-4000-8000-000000000001",
  advisor: "72000000-0000-4000-8000-000000000002",
  case: "72000000-0000-4000-8000-000000000003",
  student: "72000000-0000-4000-8000-000000000004",
  guardian: "72000000-0000-4000-8000-000000000005",
  relationship: "72000000-0000-4000-8000-000000000006",
});

test("Guardian option context requires Advisor capability before Primary Advisor lookup", async () => {
  const calls: string[] = [];
  const service = new CandidateGuardianContextService({
    async find() { calls.push("find"); return { caseId:IDS.case,studentId:IDS.student }; },
  });
  assert.deepEqual(await service.resolve({ actor:actor(["advisor"]),caseId:IDS.case }),{
    caseId:IDS.case,studentId:IDS.student,
  });
  for (const roles of [["founder"],["admin"],["contractor"]] as const) {
    await assert.rejects(() => service.resolve({ actor:actor(roles),caseId:IDS.case }),
      contextError("CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND"));
  }
  assert.deepEqual(calls,["find"]);
});

test("Cases repository enforces current Primary Advisor and resource-safe absence", async () => {
  const queries: DatabaseQuery[] = [];
  const visible = new PostgresqlCandidateGuardianContextRepository(runner((query) => {
    queries.push(query);
    return dbResult([{ case_id:IDS.case,student_id:IDS.student }]);
  }));
  assert.deepEqual(await visible.find({ organizationId:IDS.organization,
    actorUserId:IDS.advisor,caseId:IDS.case }),{ caseId:IDS.case,studentId:IDS.student });
  assert.match(queries[0]?.text ?? "",/cases_actor_has_active_case_role\(service_case\.id,'advisor',true\)/);
  assert.match(queries[0]?.text ?? "",/service_case\.organization_id=\$1/);
  const hidden = new PostgresqlCandidateGuardianContextRepository(runner(() => dbResult([])));
  assert.equal(await hidden.find({ organizationId:IDS.organization,
    actorUserId:IDS.advisor,caseId:IDS.case }),null);
});

test("CRM repository returns only active Guardians on current relationships without contact hints", async () => {
  const queries: DatabaseQuery[] = [];
  const repository = new PostgresqlGuardianConfirmationOptionsRepository(runner((query) => {
    queries.push(query);
    return dbResult([{ guardian_id:IDS.guardian,guardian_relationship_id:IDS.relationship,
      display_name:"Synthetic Guardian",relationship_type:"mother",
      relationship_description:null,is_legal_guardian:true,is_primary_contact:true }]);
  }));
  const items = await repository.list({ organizationId:IDS.organization,
    actorUserId:IDS.advisor,studentId:IDS.student });
  assert.deepEqual(items,[{ guardianId:IDS.guardian,guardianRelationshipId:IDS.relationship,
    displayName:"Synthetic Guardian",relationshipType:"mother",relationshipDescription:null,
    isLegalGuardian:true,isPrimaryContact:true }]);
  const sql = queries[0]?.text ?? "";
  assert.match(sql,/relationship\.ends_at IS NULL/);
  assert.match(sql,/guardian\.status='active'/);
  assert.doesNotMatch(sql,/email|phone/i);
});

test("Guardian public service requires students.read and route exposes the minimal DTO", async () => {
  const service = new GuardianConfirmationOptionsService({ async list() { return []; } });
  await service.list({ actor:actor(["advisor"]),studentId:IDS.student });
  assert.throws(() => service.list({ actor:{ userId:IDS.advisor,
    organizationId:IDS.organization,roles:["advisor"],workspaceCapabilities:[] },
  studentId:IDS.student }),guardianError("GUARDIAN_CONFIRMATION_OPTIONS_NOT_FOUND"));

  const route = await readFile(
    "app/api/v1/cases/[caseId]/guardian-confirmation-options/route.ts","utf8");
  for (const field of ["guardian_id","guardian_relationship_id","display_name",
    "relationship_type","relationship_description","is_legal_guardian",
    "is_primary_contact"] as const) assert.match(route,new RegExp(field));
  assert.doesNotMatch(route,/email_hint|phone_hint|pending_delete/);
  assert.doesNotMatch(route,/crm_guardians|crm_student_guardian_relationships/);
});

function actor(roles: readonly ("founder"|"admin"|"advisor"|"contractor")[]) {
  return { userId:IDS.advisor,organizationId:IDS.organization,roles,
    workspaceCapabilities:mergeWorkspaceCapabilities(roles) };
}
function contextError(code: CandidateGuardianContextError["code"]) {
  return (error: unknown) => error instanceof CandidateGuardianContextError && error.code === code;
}
function guardianError(code: GuardianConfirmationOptionsError["code"]) {
  return (error: unknown) => error instanceof GuardianConfirmationOptionsError && error.code === code;
}
function dbResult<Row>(rows: readonly Record<string,unknown>[]): DatabaseQueryResult<Row> {
  return { rows:rows as readonly Row[] };
}
type Handler = (query: DatabaseQuery) => DatabaseQueryResult<Record<string,unknown>>;
function runner(handler: Handler): TenantTransactionRunner {
  return { async run<Result>(_context: TenantTransactionContext,
    operation: (transaction: TenantTransaction) => Promise<Result>) {
    return operation({ async query<Row = Record<string,unknown>>(query: DatabaseQuery) {
      return handler(query) as DatabaseQueryResult<Row>;
    } });
  } };
}
