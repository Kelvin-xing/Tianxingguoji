import 'server-only';
import type {TaskFactsTransaction} from '../../shared/public.ts';
import type {K12BusinessCategory} from '../../access/public.ts';

/** CRM receives student IDs only; case records remain owned by Cases. */
export async function readCategoryStudentIds(transaction:TaskFactsTransaction,input:{organizationId:string;categories:readonly K12BusinessCategory[]}):Promise<readonly string[]>{
  const rows=await transaction.query<{student_id:string}>({text:`SELECT student_id FROM cases_service_cases
    WHERE organization_id=$1 AND business_category=ANY($2::text[]) FOR SHARE`,values:[input.organizationId,input.categories]});
  return [...new Set(rows.rows.map(row=>row.student_id))];
}
