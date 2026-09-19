import "server-only";
import {randomUUID} from 'node:crypto';
import {loadTrialPrincipal} from '../../access/server.ts';
import {trialWorkspaceCapabilities} from '../../access/public.ts';
import {appendAtomicMutationEffects} from '../../audit/server.ts';
import {hashRequestPayload} from '../../shared/public.ts';
import {IdempotencyExecutionError,runIdempotentTransaction,type TenantTransaction,type TenantTransactionRunner} from '../../shared/server.ts';
import {sha256SchoolValue} from '../domain/contract.ts';
import {SchoolServiceError,type SchoolRepository,type SchoolChangeRequestResult} from '../application/service.ts';
import {PostgresqlResolvedSchoolTransaction} from './postgresql-resolved-view-transaction.ts';

type Input=Parameters<SchoolRepository['submitSchoolChange']>[0];
export class PostgresqlSchoolChangeRepository implements Pick<SchoolRepository,'submitSchoolChange'>{
  private readonly runner:TenantTransactionRunner;
  constructor(runner:TenantTransactionRunner){this.runner=runner;}
  async submitSchoolChange(input:Input):Promise<SchoolChangeRequestResult>{
    const occurredAt=new Date(input.submittedAtMs).toISOString();
    try{
      const result=await runIdempotentTransaction({runner:this.runner,
        context:{organizationId:input.organizationId,actorUserId:input.actorUserId,actorKind:'user',actorOpaqueId:input.actorUserId,requestId:input.requestId},
        claim:{id:randomUUID(),organizationId:input.organizationId,actorKind:'user',actorOpaqueId:input.actorUserId,operation:'schools.change.submit',key:input.idempotencyKey,requestHash:input.requestHash,createdAt:occurredAt},
        revalidate:async transaction=>{await assertSubmitter(transaction,input);},
        execute:async transaction=>{
          const tx=adapt(transaction);
          const principal=await assertSubmitter(transaction,input);
          const school=await tx.query('SELECT id FROM schools_schools WHERE organization_id=$1 AND id=$2 FOR UPDATE',[input.organizationId,input.schoolId]);
          if(school.rows.length!==1)throw new SchoolServiceError('SCHOOL_CHANGE_BASE_NOT_FOUND');
          const base=await tx.query<{fields_json:Record<string,unknown>}>(`SELECT record.fields_json FROM schools_snapshot_records record
            JOIN schools_snapshots snapshot ON snapshot.id=record.snapshot_id AND snapshot.organization_id=record.organization_id
            WHERE record.organization_id=$1 AND record.school_id=$2 AND record.snapshot_id=$3 AND snapshot.status='active' FOR SHARE OF snapshot,record`,
            [input.organizationId,input.schoolId,input.baseSnapshotId]);
          if(!base.rows[0])throw new SchoolServiceError('SCHOOL_CHANGE_BASE_NOT_FOUND');
          const baseValue=base.rows[0].fields_json[input.fieldName]??null;
          if(sha256SchoolValue(baseValue)!==input.baseValueSha256)throw new SchoolServiceError('SCHOOL_CHANGE_BASE_STALE');
          // Page access authorizes supplementing missing data, not replacing an existing effective value.
          // Full business maintainers and the legacy Advisor retain their established edit scope.
          const current=await new PostgresqlResolvedSchoolTransaction().readCurrentResolvedSchool({transaction:tx,organizationId:input.organizationId,schoolId:input.schoolId});
          const currentValue=current.view.fields[input.fieldName];
          if(principal?.level==='l2'&&currentValue!==undefined&&currentValue!==null&&currentValue!=='')throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
          const revision=await tx.query<{next_version:string}>(`SELECT (COALESCE(max(revision_number),0)+1)::text AS next_version FROM schools_overlay_revisions WHERE organization_id=$1 AND school_id=$2`,[input.organizationId,input.schoolId]);
          await tx.query(`INSERT INTO schools_overlay_revisions(id,organization_id,school_id,base_snapshot_id,revision_number,requested_by_user_id,reason,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($8/1000.0))`,
            [input.changeRequestId,input.organizationId,input.schoolId,input.baseSnapshotId,revision.rows[0]!.next_version,input.actorUserId,input.reason,input.submittedAtMs]);
          await tx.query(`INSERT INTO schools_overlay_fields(organization_id,revision_id,school_id,field_name,field_class,proposed_value_json,base_value_sha256,evidence_json)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,[input.organizationId,input.changeRequestId,input.schoolId,input.fieldName,input.fieldClass,JSON.stringify(input.proposedValue),input.baseValueSha256,JSON.stringify(input.evidence)]);
          await appendAtomicMutationEffects(tx,input.effects);
          const value:SchoolChangeRequestResult={changeRequestId:input.changeRequestId,schoolId:input.schoolId,baseSnapshotId:input.baseSnapshotId,fieldName:input.fieldName,status:'submitted',recordVersion:1};
          return {state:'completed' as const,resultReference:`school-change:${input.changeRequestId}`,responseHash:hashRequestPayload({...value}),updatedAt:occurredAt,value};
        },
      });
      if(result.status==='executed')return result.value;
      const match=/^school-change:([0-9a-f-]{36})$/.exec(result.resultReference);
      if(!match)throw new Error('Invalid school change receipt');
      const value:SchoolChangeRequestResult={changeRequestId:match[1]!,schoolId:input.schoolId,baseSnapshotId:input.baseSnapshotId,fieldName:input.fieldName,status:'submitted',recordVersion:1};
      if(hashRequestPayload({...value})!==result.responseHash)throw new Error('Invalid school change receipt hash');
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
async function assertSubmitter(transaction:TenantTransaction,input:Input){
  const tx=adapt(transaction);
  const principal=await loadTrialPrincipal(tx,{organizationId:input.organizationId,userId:input.actorUserId,lock:true});
  if(principal&&!trialWorkspaceCapabilities(principal).includes('schools.read'))throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
  const binding=await tx.query(`SELECT binding.id FROM identity_users actor
    JOIN access_organization_memberships membership ON membership.user_id=actor.id AND membership.organization_id=$1 AND membership.status='active'
    JOIN access_organizations organization ON organization.id=$1 AND organization.status='active'
    JOIN access_role_bindings binding ON binding.membership_id=membership.id AND binding.organization_id=$1 AND binding.user_id=actor.id AND binding.status='active'
    WHERE actor.id=$2 AND actor.status='active' AND binding.role=ANY($3::text[]) FOR SHARE OF actor,membership,organization,binding`,
    [input.organizationId,input.actorUserId,principal?[principal.level]:['advisor']]);
  if(binding.rows.length===0)throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
  return principal;
}
function adapt(transaction:TenantTransaction){return {async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){const result=await transaction.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length}}};}
