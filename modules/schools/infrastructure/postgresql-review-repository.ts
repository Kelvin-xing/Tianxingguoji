import "server-only";
import {randomUUID} from 'node:crypto';
import {loadTrialPrincipal} from '../../access/server.ts';
import {appendAtomicMutationEffects} from '../../audit/server.ts';
import {hashRequestPayload} from '../../shared/public.ts';
import {IdempotencyExecutionError,runIdempotentTransaction,type TenantTransaction,type TenantTransactionRunner} from '../../shared/server.ts';
import {sha256SchoolValue,type JsonValue} from '../domain/contract.ts';
import {SchoolGovernanceError,type SchoolGovernanceRepository,type SchoolChangeReviewResult} from '../application/governance-service.ts';
import {PostgresqlResolvedSchoolTransaction} from './postgresql-resolved-view-transaction.ts';

type Input=Parameters<SchoolGovernanceRepository['reviewChangeRequest']>[0];
type Revision=Record<string,unknown>&{id:string;school_id:string;base_snapshot_id:string;status:string;record_version:number|string;requested_by_user_id:string};
type Receipt=Record<string,unknown>&{revision_id:string;school_id:string;resolved_revision_id:string|null;decision:'approve'|'reject';record_version:number|string};
export class PostgresqlSchoolReviewRepository implements Pick<SchoolGovernanceRepository,'reviewChangeRequest'> {
  private readonly runner:TenantTransactionRunner;
  constructor(runner:TenantTransactionRunner){this.runner=runner;}

  async reviewChangeRequest(input:Input):Promise<SchoolChangeReviewResult>{
    const occurredAt=new Date(input.reviewedAtMs).toISOString();
    let replayReceipt:SchoolChangeReviewResult|undefined;
    try{
      const result=await runIdempotentTransaction({runner:this.runner,
        context:{organizationId:input.organizationId,actorUserId:input.actorUserId,actorKind:'user',actorOpaqueId:input.actorUserId,requestId:input.requestId},
        claim:{id:randomUUID(),organizationId:input.organizationId,actorKind:'user',actorOpaqueId:input.actorUserId,operation:'schools.change.review',key:input.idempotencyKey,requestHash:input.requestHash,createdAt:occurredAt},
        revalidate:async transaction=>{
          await assertReviewer(transaction,input);
          const revision=await readRevision(transaction,input,false);
          if(revision.requested_by_user_id===input.actorUserId)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED');
          const receipt=await transaction.query<Receipt>({text:'SELECT revision_id,school_id,resolved_revision_id,decision,record_version FROM schools_change_review_receipts WHERE organization_id=$1 AND revision_id=$2',values:[input.organizationId,input.changeRequestId]});
          if(receipt.rows[0])replayReceipt=receiptResult(receipt.rows[0]);
        },
        execute:async transaction=>{
          await assertReviewer(transaction,input);
          const initial=await readRevision(transaction,input,false);
          // Submissions and resolved reads lock the school first. Keep the same order.
          await transaction.query({text:'SELECT id FROM schools_schools WHERE organization_id=$1 AND id=$2 FOR UPDATE',values:[input.organizationId,initial.school_id]});
          const revision=await readRevision(transaction,input,true);
          if(revision.requested_by_user_id===input.actorUserId)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED');
          if(Number(revision.record_version)!==input.expectedRecordVersion)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_STALE_VERSION');
          if(revision.status!=='candidate')throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_CONFLICT');
          const tx=adapt(transaction),resolver=new PostgresqlResolvedSchoolTransaction();
          if(input.decision==='approve'){
            if(!input.resolvedRevisionId)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_INVALID');
            const current=await resolver.readCurrentResolvedSchool({transaction:tx,organizationId:input.organizationId,schoolId:revision.school_id});
            if(current.pin.baseSnapshotId!==revision.base_snapshot_id)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_STALE_VERSION');
            const fields=await transaction.query<Record<string,unknown>&{field_name:string;base_value_sha256:string;expected_effective_value_sha256:string|null;fields_json:Record<string,JsonValue>}>({text:`SELECT field.field_name,field.base_value_sha256,field.expected_effective_value_sha256,record.fields_json
              FROM schools_overlay_fields field JOIN schools_snapshot_records record
                ON record.organization_id=field.organization_id AND record.school_id=field.school_id AND record.snapshot_id=$3
              WHERE field.organization_id=$1 AND field.revision_id=$2 FOR SHARE OF field,record`,values:[input.organizationId,input.changeRequestId,revision.base_snapshot_id]});
            if(fields.rows.length===0)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_CONFLICT');
            for(const field of fields.rows){
              // Legacy pending requests have no effective-value confirmation; require resubmission.
              if(!field.expected_effective_value_sha256||sha256SchoolValue(current.view.fields[field.field_name]??null)!==field.expected_effective_value_sha256
                ||sha256SchoolValue(field.fields_json[field.field_name]??null)!==field.base_value_sha256)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_STALE_VERSION');
            }
          }
          const approved=input.decision==='approve';
          await transaction.query({text:`UPDATE schools_overlay_revisions SET status=$3,
              approved_by_user_id=$4,approved_role=$5,approved_at=$6::timestamptz,
              record_version=record_version+1,updated_at=GREATEST(updated_at,$7::timestamptz)
            WHERE organization_id=$1 AND id=$2`,values:[input.organizationId,input.changeRequestId,approved?'approved':'rejected',approved?input.actorUserId:null,approved?input.reviewerRole:null,approved?occurredAt:null,occurredAt]});
          let resolvedRevisionId:string|null=null;
          if(approved){
            const current=await resolver.readCurrentResolvedSchool({transaction:tx,organizationId:input.organizationId,schoolId:revision.school_id});
            const pinned=await resolver.appendResolvedRevision({transaction:tx,organizationId:input.organizationId,proposedResolvedRevisionId:input.resolvedRevisionId!,resolved:current,createdAtMs:input.reviewedAtMs});
            resolvedRevisionId=pinned.pin.resolvedRevisionId;
          }
          await transaction.query({text:`INSERT INTO schools_change_review_receipts(revision_id,organization_id,school_id,reviewed_by_user_id,reviewer_role,decision,reason,record_version,resolved_revision_id,reviewed_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,values:[input.changeRequestId,input.organizationId,revision.school_id,input.actorUserId,input.reviewerRole,input.decision,input.reason,input.expectedRecordVersion+1,resolvedRevisionId,occurredAt]});
          await appendAtomicMutationEffects(tx,input.effects);
          const value:SchoolChangeReviewResult={changeRequestId:input.changeRequestId,schoolId:revision.school_id,overlayRevisionId:input.changeRequestId,resolvedRevisionId,status:approved?'approved':'rejected',recordVersion:input.expectedRecordVersion+1};
          return {state:'completed' as const,resultReference:`school-review:${input.changeRequestId}`,responseHash:hashRequestPayload({...value}),updatedAt:occurredAt,value};
        },
      });
      if(result.status==='executed')return result.value;
      if(!replayReceipt||result.resultReference!==`school-review:${input.changeRequestId}`||hashRequestPayload({...replayReceipt})!==result.responseHash)throw new Error('Invalid school review receipt');
      return replayReceipt;
    }catch(error){
      if(error instanceof IdempotencyExecutionError){
        if(error.code==='IDEMPOTENCY_KEY_REUSED')throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED');
        if(error.code==='IDEMPOTENCY_IN_PROGRESS')throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_IDEMPOTENCY_IN_PROGRESS');
      }
      throw error;
    }
  }
}
async function assertReviewer(transaction:TenantTransaction,input:Input){
  const principal=await loadTrialPrincipal(adapt(transaction),{organizationId:input.organizationId,userId:input.actorUserId,lock:true});
  if(principal&&!principal.active)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED');
  const role=principal?.level??'founder';
  if(!['founder','l1'].includes(role)||input.reviewerRole!==role)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED');
  const active=await transaction.query({text:`SELECT actor.id FROM identity_users actor
    JOIN access_organization_memberships membership ON membership.user_id=actor.id AND membership.organization_id=$1 AND membership.status='active'
    JOIN access_organizations organization ON organization.id=$1 AND organization.status='active'
    JOIN access_role_bindings binding ON binding.membership_id=membership.id AND binding.user_id=actor.id AND binding.organization_id=$1 AND binding.status='active' AND binding.role=$3
    WHERE actor.id=$2 AND actor.status='active' FOR SHARE OF actor,membership,organization,binding`,values:[input.organizationId,input.actorUserId,role]});
  if(active.rows.length===0)throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_REVIEWER_REQUIRED');
}
async function readRevision(transaction:TenantTransaction,input:Input,lock:boolean){
  const result=await transaction.query<Revision>({text:`SELECT id,school_id,base_snapshot_id,status,record_version,requested_by_user_id FROM schools_overlay_revisions WHERE organization_id=$1 AND id=$2 ${lock?'FOR UPDATE':''}`,values:[input.organizationId,input.changeRequestId]});
  if(!result.rows[0])throw new SchoolGovernanceError('SCHOOL_GOVERNANCE_NOT_FOUND');
  return result.rows[0];
}
function receiptResult(row:Receipt):SchoolChangeReviewResult{return {changeRequestId:row.revision_id,schoolId:row.school_id,overlayRevisionId:row.revision_id,resolvedRevisionId:row.resolved_revision_id,status:row.decision==='approve'?'approved':'rejected',recordVersion:Number(row.record_version)}};
function adapt(transaction:TenantTransaction){return {async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){const result=await transaction.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length}}};}
