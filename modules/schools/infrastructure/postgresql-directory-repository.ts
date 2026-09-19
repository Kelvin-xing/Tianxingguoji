import "server-only";

import {loadTrialPrincipal} from "../../access/server.ts";
import {trialWorkspaceCapabilities} from "../../access/public.ts";
import type {TenantTransaction,TenantTransactionRunner} from "../../shared/server.ts";
import {SchoolResolutionError,type ResolvedSchoolTargetView} from "../application/resolved-view.ts";
import {PostgresqlResolvedSchoolTransaction} from "./postgresql-resolved-view-transaction.ts";

type Reader={readonly organizationId:string;readonly actorUserId:string};
/** Reads the active PostgreSQL snapshot and overlays; no file-backed fallback. */
export class PostgresqlSchoolDirectoryRepository {
  private readonly resolved=new PostgresqlResolvedSchoolTransaction();
  private readonly runner:TenantTransactionRunner;
  constructor(runner:TenantTransactionRunner){this.runner=runner;}

  list(input:Reader):Promise<readonly ResolvedSchoolTargetView[]>{
    return this.runner.run(input,async transaction=>{
      await assertReader(transaction,input);
      return this.resolved.listCurrentResolvedSchools({organizationId:input.organizationId,transaction:adapt(transaction)});
    });
  }
  listProvisionals(input:Reader){
    return this.runner.run(input,async transaction=>{
      await assertReader(transaction,input);
      const result=await transaction.query<{
        school_id:string; school_name_zh:string|null; school_name_en:string|null;
        district:string|null; system:string|null; stage:string|null; reason:string|null;
        status:'provisional'; record_version:number|string; created_at:Date|string;
      }>({text:`SELECT school_id,school_name_zh,school_name_en,district,system,stage,reason,status,record_version,created_at
        FROM schools_provisional_records WHERE organization_id=$1 ORDER BY created_at DESC,school_id`,values:[input.organizationId]});
      return result.rows.map(row=>({...row,record_version:Number(row.record_version),created_at:new Date(row.created_at).toISOString()}));
    });
  }
  find(input:Reader&{readonly schoolId:string}):Promise<ResolvedSchoolTargetView>{
    return this.runner.run(input,async transaction=>{
      await assertReader(transaction,input);
      return this.resolved.readCurrentResolvedSchool({organizationId:input.organizationId,schoolId:input.schoolId,transaction:adapt(transaction)});
    });
  }
}
async function assertReader(transaction:TenantTransaction,input:Reader){
  const tx=adapt(transaction);
  const principal=await loadTrialPrincipal(tx,{organizationId:input.organizationId,userId:input.actorUserId,lock:true});
  if(principal && !trialWorkspaceCapabilities(principal).includes('schools.read'))throw new SchoolResolutionError('SCHOOL_RESOLUTION_FORBIDDEN');
  const result=await tx.query(`SELECT binding.id FROM identity_users actor
    JOIN access_organization_memberships membership ON membership.user_id=actor.id AND membership.organization_id=$1 AND membership.status='active'
    JOIN access_organizations organization ON organization.id=$1 AND organization.status='active'
    JOIN access_role_bindings binding ON binding.membership_id=membership.id AND binding.organization_id=$1 AND binding.user_id=actor.id AND binding.status='active'
    WHERE actor.id=$2 AND actor.status='active' AND binding.role=ANY($3::text[])
    FOR SHARE OF actor,membership,organization,binding`,[input.organizationId,input.actorUserId,principal?[principal.level]:['founder','advisor']]);
  if(result.rows.length===0)throw new SchoolResolutionError('SCHOOL_RESOLUTION_FORBIDDEN');
}
function adapt(transaction:TenantTransaction){
  return {async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){
    const result=await transaction.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};
  }};
}
