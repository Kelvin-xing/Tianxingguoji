import 'server-only';
import {randomUUID} from 'node:crypto';
import {InternalEmailServiceError, type InviteOperationResult} from '../application/internal-email.ts';
import type {DatabaseClient} from './postgresql-client.ts';

type OperationInput={organizationId:string;actorUserId:string;operation:'create'|'resend';key:string;requestHash:string;model:'trial'|'legacy'|null};
interface OperationRow{ id:string;invite_id:string;target_user_id:string;expires_at:Date|string;request_hash:Buffer;channel_policy_id:'hk_dpa_reviewed_transactional'|null;receipt_reference:string|null;delivered_at:Date|string|null }

export async function readInviteOperation(client:DatabaseClient,input:OperationInput):Promise<InviteOperationResult|null>{
  // Revalidate even on replay and serialize with current grade changes.
  try{await client.query('SELECT identity_require_current_inviter($1,$2,$3)',[input.organizationId,input.actorUserId,input.model]);}
  catch(error){if((error as {code?:string}).code==='42501') throw new InternalEmailServiceError('FOUNDER_REQUIRED');throw error;}
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
    `identity-invite-operation:${input.organizationId}:${input.actorUserId}:${input.operation}:${input.key}`,
  ]);
  const result=await client.query<OperationRow>(`SELECT * FROM identity_invite_operations
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND command_key=$4`,
    [input.organizationId,input.actorUserId,input.operation,input.key]);
  const row=result.rows[0];
  if(!row)return null;
  if(row.request_hash.toString('hex')!==input.requestHash)throw new InternalEmailServiceError('INVITE_CONFLICT');
  return fromRow(row,false);
}

export async function recordInviteOperation(client:DatabaseClient,input:OperationInput & {inviteId:string}):Promise<InviteOperationResult>{
  const result=await client.query<OperationRow>(`INSERT INTO identity_invite_operations
    (id,organization_id,actor_user_id,operation,command_key,request_hash,invite_id,invite_record_version,target_user_id,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,i.id,i.record_version,i.target_user_id,i.expires_at FROM identity_invites i
    WHERE i.id=$7 AND i.organization_id=$2 RETURNING *`,
    [randomUUID(),input.organizationId,input.actorUserId,input.operation,input.key,Buffer.from(input.requestHash,'hex'),input.inviteId]);
  if(result.rows.length!==1)throw new InternalEmailServiceError('INVITE_UNAVAILABLE');
  return fromRow(result.rows[0]!,true);
}

function fromRow(row:OperationRow,started:boolean):InviteOperationResult{
  return Object.freeze({operationId:row.id,started,inviteId:row.invite_id,targetUserId:row.target_user_id,
    expiresAtMs:new Date(row.expires_at).getTime(),deliveryReceipt:row.receipt_reference===null?null:{
      channelPolicyId:row.channel_policy_id!,receiptReference:row.receipt_reference,deliveredAtMs:new Date(row.delivered_at!).getTime(),
    }});
}
