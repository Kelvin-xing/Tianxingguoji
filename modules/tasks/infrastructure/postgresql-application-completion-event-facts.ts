import "server-only";

import type {
  TaskFactsTransaction,
  TasksApplicationCompletionEventFactsPort,
} from "../../shared/public.ts";

export class PostgresqlTasksApplicationCompletionEventFactsPort
implements TasksApplicationCompletionEventFactsPort {
  async readApplicationCompletionEvent(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; taskId: string;
  }>) {
    const result = await transaction.query<Row>({
      text: `SELECT task.id AS task_id,task.service_case_id AS case_id,
                    task.school_target_id AS target_id,receipt.id AS receipt_id,
                    receipt.actor_user_id,receipt.completion_record_json,
                    receipt.evidence_reference
               FROM tasks_tasks AS task
               JOIN tasks_task_transition_receipts AS receipt
                 ON receipt.id=task.last_transition_receipt_id
                AND receipt.organization_id=task.organization_id
                AND receipt.task_id=task.id
              WHERE task.organization_id=$1 AND task.id=$2
                AND task.task_kind='application_prepare_submit'
                AND task.state='completed' AND receipt.to_state='completed'`,
      values: [input.organizationId,input.taskId],
    });
    const row = result.rows[0];
    if (!row || !row.completion_record_json ||
        typeof row.completion_record_json !== "object" ||
        Array.isArray(row.completion_record_json)) return null;
    return Object.freeze({ taskId:row.task_id,caseId:row.case_id,targetId:row.target_id,
      receiptId:row.receipt_id,actorUserId:row.actor_user_id,
      completionRecord:row.completion_record_json as Readonly<Record<string,unknown>>,
      evidenceReference:row.evidence_reference });
  }
}
interface Row { readonly task_id:string;readonly case_id:string;readonly target_id:string;
  readonly receipt_id:string;readonly actor_user_id:string;readonly completion_record_json:unknown;
  readonly evidence_reference:string|null }
