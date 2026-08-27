import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeWorkspaceCapabilities,
  type Release1OrganizationRole,
} from "../../../modules/access/public.ts";
import {
  CandidateListQueryError,
  CandidateListQueryService,
  type CandidateListQueryRepository,
  type CandidateListVersionView,
} from "../../../modules/cases/application/candidate-list-query-service.ts";
import {
  decodeCandidateListCursor,
  encodeCandidateListCursor,
} from "../../../modules/cases/domain/candidate-list-cursor.ts";
import { PostgresqlCandidateListQueryRepository } from "../../../modules/cases/infrastructure/postgresql-candidate-list-query-repository.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = Object.freeze({
  organization: "63000000-0000-4000-8000-000000000001",
  actor: "63000000-0000-4000-8000-000000000002",
  case: "63000000-0000-4000-8000-000000000003",
  otherCase: "63000000-0000-4000-8000-000000000004",
  versionOne: "63000000-0000-4000-8000-000000000005",
  versionTwo: "63000000-0000-4000-8000-000000000006",
  versionThree: "63000000-0000-4000-8000-000000000007",
  item: "63000000-0000-4000-8000-000000000008",
  school: "63000000-0000-4000-8000-000000000009",
  revision: "63000000-0000-4000-8000-000000000010",
  guardian: "63000000-0000-4000-8000-000000000011",
  relationship: "63000000-0000-4000-8000-000000000012",
  target: "63000000-0000-4000-8000-000000000013",
});
const HASH = "a".repeat(64);
const TIME = "2026-08-28T00:00:00.000Z";

test("query service allows Founder+Admin and Advisor but denies pure Admin/Contractor", async () => {
  const calls: string[] = [];
  const service = new CandidateListQueryService(repository(calls));
  await service.list(input(["founder","admin"]));
  await service.list(input(["advisor"]));
  assert.deepEqual(calls,["list","list"]);
  for (const roles of [["admin"],["contractor"]] as const) {
    await assert.rejects(() => service.list(input(roles)),
      queryError("CANDIDATE_LIST_QUERY_FORBIDDEN"));
  }
});

test("query cursor is opaque, returns null at the end, and cannot cross Cases", async () => {
  const first = new CandidateListQueryService(repository([],{
    async list() {
      return { items: [version(3,IDS.versionThree),version(2,IDS.versionTwo)],hasMore: true };
    },
  }));
  const page = await first.list(input(["founder"]));
  assert.match(page.nextCursor ?? "",/^cl_v1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCandidateListCursor(page.nextCursor!),{
    caseId: IDS.case,versionNumber: 2,id: IDS.versionTwo,
    sort: "version_number_desc_id_asc",
  });
  const final = await new CandidateListQueryService(repository([],{
    async list() { return { items: [version(1,IDS.versionOne)],hasMore: false }; },
  })).list(input(["founder"]));
  assert.equal(final.nextCursor,null);
  const wrongCaseCursor = encodeCandidateListCursor({
    caseId: IDS.otherCase,versionNumber: 2,id: IDS.versionTwo,
  });
  await assert.rejects(() => first.list({ ...input(["founder"]),cursor: wrongCaseCursor }),
    queryError("CANDIDATE_LIST_QUERY_INVALID"));
});

test("repository revalidates Founder/current Primary Advisor and projects versions, items and decisions", async () => {
  const queries: DatabaseQuery[] = [];
  const contexts: TenantDatabaseContext[] = [];
  const repository = new PostgresqlCandidateListQueryRepository(runner((query) => {
    queries.push(query);
    if (query.text.includes("cases_actor_has_active_case_role")) return dbResult([{ allowed: true }]);
    if (query.text.includes("FROM cases_candidate_school_list_versions")) return dbResult([
      versionRow(3,IDS.versionThree),versionRow(2,IDS.versionTwo),versionRow(1,IDS.versionOne),
    ]);
    if (query.text.includes("FROM cases_candidate_school_list_items")) return dbResult([
      { id: IDS.item,list_version_id: IDS.versionThree,school_id: IDS.school,
        pinned_resolved_revision_id: IDS.revision,pinned_resolution_sha256: HASH,
        ordinal: 1,school_target_id: IDS.target,application_deadline: TIME },
    ]);
    return dbResult([]);
  },contexts));
  const result = await repository.list(repositoryInput(2));
  assert.equal(result.hasMore,true);
  assert.equal(result.items.length,2);
  assert.deepEqual(result.items[0]?.items[0],{
    id: IDS.item,schoolId: IDS.school,pinnedResolvedRevisionId: IDS.revision,
    pinnedResolutionSha256: HASH,ordinal: 1,schoolTargetId: IDS.target,
    applicationDeadline: TIME,
  });
  assert.deepEqual(result.items[0]?.founderApproval,{
    decision:"approved",decidedByUserId:IDS.actor,decidedAt:TIME,
    reason:null,decisionSha256:HASH,
  });
  assert.deepEqual(result.items[0]?.guardianDecision,{
    guardianId:IDS.guardian,guardianRelationshipId:IDS.relationship,
    decision:"confirmed",decidedAt:TIME,channel:"in_person",
    recordedByUserId:IDS.actor,recordedAt:TIME,boundFounderDecisionSha256:HASH,
  });
  const auth = queries.find((query) => query.text.includes("cases_actor_has_active_case_role"));
  assert.match(auth?.text ?? "",/'founder',false/);
  assert.match(auth?.text ?? "",/'advisor',true/);
  const versions = queries.find((query) => query.text.includes("FROM cases_candidate_school_list_versions"));
  assert.match(versions?.text ?? "",/ORDER BY version_number DESC,id::text COLLATE "C" ASC/);
  assert.deepEqual(versions?.values,[IDS.organization,IDS.case,null,null,3]);
  assert.equal(contexts[0]?.requestId,"candidate-list-query-test");
});

test("repository hides non-Primary Advisors and fails closed on malformed projections", async () => {
  const denied = new PostgresqlCandidateListQueryRepository(runner((query) =>
    query.text.includes("cases_actor_has_active_case_role")
      ? dbResult([{ allowed: false }]) : dbResult([])));
  await assert.rejects(() => denied.list(repositoryInput()),
    queryError("CANDIDATE_LIST_QUERY_NOT_FOUND"));
  const malformed = new PostgresqlCandidateListQueryRepository(runner((query) => {
    if (query.text.includes("cases_actor_has_active_case_role")) return dbResult([{ allowed: true }]);
    if (query.text.includes("FROM cases_candidate_school_list_versions")) {
      return dbResult([{ ...versionRow(1,IDS.versionOne),school_set_sha256:"not-a-hash" }]);
    }
    return dbResult([]);
  }));
  await assert.rejects(() => malformed.list(repositoryInput()),
    queryError("CANDIDATE_LIST_QUERY_UNAVAILABLE"));
});

function input(roles: readonly Release1OrganizationRole[]) {
  return { actor: { userId:IDS.actor,organizationId:IDS.organization,roles,
    workspaceCapabilities:mergeWorkspaceCapabilities(roles) },caseId:IDS.case,
  requestId:"candidate-list-query-test",limit:25,cursor:null };
}
function repository(calls: string[],overrides: Partial<CandidateListQueryRepository> = {}): CandidateListQueryRepository {
  return { async list() { calls.push("list"); return { items:[],hasMore:false }; },...overrides };
}
function version(versionNumber: number,id: string): CandidateListVersionView {
  return { id,versionNumber,previousVersionId:null,schoolSetSha256:HASH,status:"submitted",
    recordVersion:2,changeSummary:"Synthetic candidate list",createdByUserId:IDS.actor,
    createdAt:TIME,submittedAt:TIME,items:[],founderApproval:null,guardianDecision:null };
}
function versionRow(versionNumber: number,id: string) {
  return { id,version_number:versionNumber,previous_version_id:null,school_set_sha256:HASH,
    status:"confirmed",record_version:4,change_summary:"Synthetic candidate list",
    created_by_user_id:IDS.actor,created_at:TIME,submitted_at:TIME,
    founder_decision:"approved",founder_decided_by_user_id:IDS.actor,
    founder_decided_at:TIME,founder_decision_reason:"",founder_decision_sha256:HASH,
    guardian_id:IDS.guardian,guardian_relationship_id:IDS.relationship,
    guardian_decision:"confirmed",guardian_decided_at:TIME,
    guardian_confirmation_channel:"in_person",guardian_recorded_by_user_id:IDS.actor,
    guardian_recorded_at:TIME,guardian_bound_founder_decision_sha256:HASH };
}
function repositoryInput(limit = 25) {
  return { organizationId:IDS.organization,actorUserId:IDS.actor,caseId:IDS.case,
    requestId:"candidate-list-query-test",limit,cursor:null };
}
function queryError(code: CandidateListQueryError["code"]) {
  return (error: unknown) => error instanceof CandidateListQueryError && error.code === code;
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
