import "server-only";
import {randomUUID} from "node:crypto";
import {loadTrialPrincipal} from "../../access/server.ts";
import {trialWorkspaceCapabilities} from "../../access/public.ts";
import {appendAtomicMutationEffects} from "../../audit/server.ts";
import {hashRequestPayload} from "../../shared/public.ts";
import {IdempotencyExecutionError,runIdempotentTransaction,type TenantTransaction,type TenantTransactionRunner} from "../../shared/server.ts";
import {SchoolServiceError,type SchoolRepository,type ProvisionalSchoolResult} from "../application/service.ts";

type Input=Parameters<SchoolRepository['createProvisionalSchool']>[0];
const REFERENCE=/^provisional:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export class PostgresqlProvisionalSchoolRepository implements Pick<SchoolRepository,'createProvisionalSchool'> {
  private readonly runner:TenantTransactionRunner;
  constructor(runner:TenantTransactionRunner){this.runner=runner;}
  async createProvisionalSchool(input:Input):Promise<ProvisionalSchoolResult>{
    const occurredAt=new Date(input.createdAtMs).toISOString();
    try{
      const result=await runIdempotentTransaction({
        runner:this.runner,
        context:{organizationId:input.organizationId,actorUserId:input.actorUserId,actorKind:'user',actorOpaqueId:input.actorUserId,requestId:input.requestId},
        claim:{id:randomUUID(),organizationId:input.organizationId,actorKind:'user',actorOpaqueId:input.actorUserId,
          operation:'schools.provisional.create',key:input.idempotencyKey,requestHash:input.requestHash,createdAt:occurredAt},
        revalidate:transaction=>assertCreator(transaction,input),
        execute:async transaction=>{
          await transaction.query({text:'INSERT INTO schools_schools(id,organization_id) VALUES ($1,$2)',values:[input.schoolId,input.organizationId]});
          await transaction.query({text:`INSERT INTO schools_provisional_records
            (school_id,organization_id,school_name_zh,school_name_en,district,system,stage,reason,created_by_user_id,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0))`,
            values:[input.schoolId,input.organizationId,input.schoolNameZh,input.schoolNameEn,input.district,input.system,input.stage,input.reason,input.actorUserId,input.createdAtMs]});
          await appendAtomicMutationEffects(adapt(transaction),input.effects);
          const value=receipt(input.schoolId);
          return {state:'completed' as const,resultReference:`provisional:${input.schoolId}`,responseHash:hashRequestPayload({...value}),updatedAt:occurredAt,value};
        },
      });
      if(result.status==='executed')return result.value;
      const match=REFERENCE.exec(result.resultReference);
      if(!match)throw new Error('Invalid provisional receipt');
      const value=receipt(match[1]!);
      if(result.responseHash!==hashRequestPayload({...value}))throw new Error('Invalid provisional receipt hash');
      return value;
    }catch(error){
      if(error instanceof IdempotencyExecutionError){
        if(error.code==='IDEMPOTENCY_KEY_REUSED')throw new SchoolServiceError('SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED');
        if(error.code==='IDEMPOTENCY_IN_PROGRESS')throw new SchoolServiceError('SCHOOL_CHANGE_IDEMPOTENCY_IN_PROGRESS');
      }
      throw error;
    }
  }
}
function receipt(schoolId:string):ProvisionalSchoolResult{return {schoolId,status:'provisional',recordVersion:1};}
async function assertCreator(transaction:TenantTransaction,input:Input){
  const tx=adapt(transaction);
  const principal=await loadTrialPrincipal(tx,{organizationId:input.organizationId,userId:input.actorUserId,lock:true});
  if(principal&&!trialWorkspaceCapabilities(principal).includes('schools.provisional.create'))throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
  const result=await tx.query(`SELECT binding.id FROM identity_users actor
    JOIN access_organization_memberships membership ON membership.user_id=actor.id AND membership.organization_id=$1 AND membership.status='active'
    JOIN access_organizations organization ON organization.id=$1 AND organization.status='active'
    JOIN access_role_bindings binding ON binding.membership_id=membership.id AND binding.organization_id=$1 AND binding.user_id=actor.id AND binding.status='active'
    WHERE actor.id=$2 AND actor.status='active' AND binding.role=ANY($3::text[])
    FOR SHARE OF actor,membership,organization,binding`,[input.organizationId,input.actorUserId,principal?[principal.level]:['advisor']]);
  if(result.rows.length===0)throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
}
function adapt(transaction:TenantTransaction){return {async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){
  const result=await transaction.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};
}};}
