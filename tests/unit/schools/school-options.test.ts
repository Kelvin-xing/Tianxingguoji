import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  mergeWorkspaceCapabilities,
  type Release1OrganizationRole,
} from "../../../modules/access/public.ts";
import {
  SchoolOptionsError,
  SchoolOptionsService,
  type SchoolOptionsRepository,
} from "../../../modules/schools/application/school-options-service.ts";
import { decodeSchoolOptionsCursor } from "../../../modules/schools/domain/school-options-cursor.ts";
import { PostgresqlSchoolOptionsRepository } from "../../../modules/schools/infrastructure/postgresql-school-options-repository.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = Object.freeze({
  organization: "71000000-0000-4000-8000-000000000001",
  actor: "71000000-0000-4000-8000-000000000002",
  school: "71000000-0000-4000-8000-000000000003",
  revision: "71000000-0000-4000-8000-000000000004",
});
const HASH = "a".repeat(64);

test("school options allow Founder/Advisor but deny pure Admin/Contractor", async () => {
  const calls: string[] = [];
  const service = new SchoolOptionsService(repository(calls));
  await service.list(input(["founder","admin"]));
  await service.list(input(["advisor"]));
  assert.deepEqual(calls,["list","list"]);
  for (const roles of [["admin"],["contractor"]] as const) {
    await assert.rejects(() => service.list(input(roles)),
      optionsError("SCHOOL_OPTIONS_FORBIDDEN"));
  }
});

test("school options cursor is opaque and bound to organization/query/sort", async () => {
  const service = new SchoolOptionsService(repository([],{
    async list() {
      return { items:[{ schoolId:IDS.school,displayName:"Synthetic School",
        resolvedRevisionId:IDS.revision,resolutionSha256:HASH }],hasMore:true };
    },
  }));
  const first = await service.list({ ...input(["advisor"]),query:"Synthetic" });
  assert.match(first.nextCursor ?? "",/^so_v1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeSchoolOptionsCursor(first.nextCursor!),{
    displayName:"Synthetic School",schoolId:IDS.school,
    filterHash:decodeSchoolOptionsCursor(first.nextCursor!).filterHash,
  });
  await assert.rejects(() => service.list({
    ...input(["advisor"]),query:"Changed",cursor:first.nextCursor,
  }),optionsError("SCHOOL_OPTIONS_INVALID"));
});

test("school options repository reads only persisted current immutable pins", async () => {
  const queries: DatabaseQuery[] = [];
  const contexts: TenantDatabaseContext[] = [];
  const repository = new PostgresqlSchoolOptionsRepository(runner((query) => {
    queries.push(query);
    return dbResult([{ school_id:IDS.school,display_name:"Synthetic School",
      resolved_revision_id:IDS.revision,resolution_sha256:HASH }]);
  },contexts));
  const result = await repository.list({ organizationId:IDS.organization,
    actorUserId:IDS.actor,query:"Synthetic",limit:25,cursor:null });
  assert.deepEqual(result.items,[{ schoolId:IDS.school,displayName:"Synthetic School",
    resolvedRevisionId:IDS.revision,resolutionSha256:HASH }]);
  const sql = queries[0]?.text ?? "";
  assert.match(sql,/schools_snapshots[\s\S]+status='active'/);
  assert.match(sql,/schools_overlay_revisions[\s\S]+status='approved'/);
  assert.match(sql,/schools_resolved_revisions/);
  assert.match(sql,/schools_snapshot_records AS record/);
  assert.match(sql,/record\.source_school_key/);
  assert.doesNotMatch(sql,/school\.source_school_key/);
  assert.match(sql,/overlay_revision_id IS NOT DISTINCT FROM current_overlay\.id/);
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i);
  assert.deepEqual(queries[0]?.values,[IDS.organization,"Synthetic",null,null,26]);
  assert.equal(contexts[0]?.actorUserId,IDS.actor);
});

test("school options HTTP contract rejects loose query input and exposes only pin DTO", async () => {
  const support = await readFile("app/api/v1/schools/options/route-support.ts","utf8");
  const route = await readFile("app/api/v1/schools/options/route.ts","utf8");
  assert.match(support,/parameters\.getAll\(key\)\.length > 1/);
  assert.match(support,/!allowed\.has\(key\)/);
  for (const field of ["school_id","display_name","resolved_revision_id",
    "resolution_sha256","next_cursor"] as const) assert.match(route,new RegExp(field));
  assert.doesNotMatch(route,/crawler|materialize|appendResolvedRevision/);
});

function input(roles: readonly Release1OrganizationRole[]) {
  return { actor:{ userId:IDS.actor,organizationId:IDS.organization,roles,
    workspaceCapabilities:mergeWorkspaceCapabilities(roles) },query:null,limit:25,cursor:null };
}
function repository(calls: string[],overrides: Partial<SchoolOptionsRepository> = {}): SchoolOptionsRepository {
  return { async list() { calls.push("list"); return { items:[],hasMore:false }; },...overrides };
}
function optionsError(code: SchoolOptionsError["code"]) {
  return (error: unknown) => error instanceof SchoolOptionsError && error.code === code;
}
function dbResult<Row>(rows: readonly Record<string,unknown>[]): DatabaseQueryResult<Row> {
  return { rows:rows as readonly Row[] };
}
type Handler = (query: DatabaseQuery) => DatabaseQueryResult<Record<string,unknown>>;
function runner(handler: Handler,contexts: TenantDatabaseContext[] = []): TenantTransactionRunner {
  return { async run<Result>(context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>) {
    contexts.push(context);
    return operation({ async query<Row = Record<string,unknown>>(query: DatabaseQuery) {
      return handler(query) as DatabaseQueryResult<Row>;
    } });
  } };
}
