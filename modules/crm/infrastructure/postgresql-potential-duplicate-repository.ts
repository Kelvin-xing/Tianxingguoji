import "server-only";
import {resolveTrialStudentScope} from './trial-student-scope.ts';
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import type { PotentialDuplicateRepository } from "../application/potential-duplicate-service.ts";
export class PostgresqlPotentialDuplicateRepository implements PotentialDuplicateRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }
  async findCandidates(input: Parameters<PotentialDuplicateRepository["findCandidates"]>[0]) {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.actorUserId }, async tx => findPotentialDuplicateCandidatesInTransaction(tx,input,false));
  }
}

export async function findPotentialDuplicateCandidatesInTransaction(transaction: TenantTransaction, input: Parameters<PotentialDuplicateRepository["findCandidates"]>[0], lockRows: boolean) {
  const visible=await resolveTrialStudentScope(transaction,input);
  if(visible?.length===0)return {candidates:[],candidateVersion:'empty'};
  const scope=input.kind==='student'?'candidate.id=ANY($5::uuid[])':`EXISTS(SELECT 1 FROM crm_student_guardian_relationships relationship
    JOIN crm_students student ON student.id=relationship.student_id AND student.organization_id=relationship.organization_id AND student.status IN ('active','pending_delete')
    WHERE relationship.guardian_id=candidate.id AND relationship.organization_id=candidate.organization_id
      AND relationship.ends_at IS NULL AND relationship.student_id=ANY($5::uuid[]))`;
  const table=input.kind === "student" ? "crm_students" : "crm_guardians";
  const email=input.kind === "student" ? "contact_email" : "email";
  const phone=input.kind === "student" ? "contact_phone" : "phone";
  const result=await transaction.query<{id:string;display_name:string|null;email:string|null;phone:string|null;record_version:number|string}>({text:`SELECT id,display_name,${email} AS email,${phone} AS phone,record_version FROM ${table} AS candidate WHERE organization_id=$1 AND status IN ('active','pending_delete') AND ($5::uuid[] IS NULL OR ${scope}) AND (($2::text IS NOT NULL AND display_name IS NOT NULL AND normalize(btrim(display_name), NFKC)=normalize(btrim($2), NFKC)) OR ($3::text IS NOT NULL AND ${email} IS NOT NULL AND lower(btrim(${email}))=lower(btrim($3))) OR ($4::text IS NOT NULL AND ${phone} IS NOT NULL AND regexp_replace(${phone},'[ ()-]','','g')=regexp_replace($4,'[ ()-]','','g'))) ORDER BY id${lockRows?" FOR SHARE":""}`,values:[input.organizationId,input.name,input.email,input.phone,visible]});
  return {candidates:result.rows.map(r=>({id:r.id,displayName:r.display_name,email:r.email,phone:r.phone,recordVersion:Number(r.record_version)})),candidateVersion:result.rows.map(r=>`${r.id}:${r.record_version}`).join(",")||"empty"};
}
