import 'server-only';
import {loadTrialPrincipal} from '../../access/server.ts';
import type {OwnedSupportingTransaction} from '../../audit/server.ts';

/** Inbox ownership never grants resource access. Recheck and lock identity on every request/replay. */
export async function currentNotificationRecipient(tx:OwnedSupportingTransaction,organizationId:string,userId:string):Promise<{allowed:boolean;taskOnly:boolean}>{
  const organizations=await tx.query({text:"SELECT id FROM access_organizations WHERE id=$1 AND status='active' FOR SHARE",values:[organizationId]});
  if(organizations.length!==1)return {allowed:false,taskOnly:false};
  const trial=await loadTrialPrincipal({async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){return {rows:await tx.query<Row>({text,values})};}},
    {organizationId,userId,lock:true});
  if(trial&&!trial.active)return {allowed:false,taskOnly:false};
  const roles=await tx.query<{role:string}>({text:`SELECT b.role FROM identity_users u
    JOIN access_organization_memberships m ON m.user_id=u.id AND m.organization_id=$1
    JOIN access_role_bindings b ON b.membership_id=m.id AND b.organization_id=m.organization_id AND b.user_id=u.id
    WHERE u.id=$2 AND u.status='active' AND m.status='active' AND b.status='active'
    FOR SHARE OF u,m,b`,values:[organizationId,userId]});
  if(trial)return {allowed:roles.length===1&&roles[0]!.role===trial.level,taskOnly:trial.level==='l3'};
  const allowed=roles.length>0&&roles.every(row=>['founder','admin','advisor','contractor'].includes(row.role));
  return {allowed,taskOnly:roles.length===1&&roles[0]!.role==='contractor'};
}
