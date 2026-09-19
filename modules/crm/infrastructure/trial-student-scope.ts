import 'server-only';
import {loadTrialPrincipal} from '../../access/server.ts';
import {readCategoryStudentIds} from '../../cases/server.ts';
import type {TenantTransaction} from '../../shared/server.ts';

/** null retains unrestricted business reads; [] means no records may be returned.
 * Disabled enrolled members never fall back to historical role permissions. */
export async function resolveTrialStudentScope(tx:TenantTransaction,input:{organizationId:string;actorUserId:string}):Promise<readonly string[]|null>{
  const principal=await loadTrialPrincipal({query:<R extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>tx.query<R>({text,values})},
    {organizationId:input.organizationId,userId:input.actorUserId,lock:true});
  if(principal===null)return null;
  if(!principal.active||principal.level==='l3')return [];
  const bindings=await tx.query({text:`SELECT id FROM access_role_bindings WHERE organization_id=$1 AND user_id=$2 AND role=$3 AND status='active' FOR SHARE`,
    values:[input.organizationId,input.actorUserId,principal.level]});
  if(bindings.rows.length!==1)return [];
  if(principal.level==='founder'||principal.level==='l1')return null;
  return readCategoryStudentIds(tx,{organizationId:input.organizationId,categories:principal.categories});
}
