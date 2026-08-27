import "server-only";

import type {
  TaskCompletionFactsPort,
  TaskFactsKind,
  TaskFactsTransaction,
} from "../../shared/public.ts";

/** Tasks-owned completion fact port. Cases consumes this fact instead of
 * re-reading Tasks' private tables. */
export class PostgresqlTaskCompletionFactsPort implements TaskCompletionFactsPort {
  async readCompletionFacts(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; targetId: string; taskId: string; receiptId: string;
  }>) {
    const result = await transaction.query<CompletionRow>({
      text: `SELECT task.id AS task_id, task.service_case_id AS case_id,
                    task.school_target_id AS target_id, task.task_kind,
                    receipt.id AS receipt_id, receipt.evidence_reference,
                    receipt.completion_record_json
               FROM tasks_tasks AS task
               JOIN tasks_task_transition_receipts AS receipt
                 ON receipt.task_id=task.id AND receipt.organization_id=task.organization_id
                AND receipt.id=task.last_transition_receipt_id
              WHERE task.organization_id=$1 AND task.id=$2 AND task.service_case_id=$3
                AND task.school_target_id=$4 AND task.state='completed'
                AND receipt.id=$5 AND receipt.to_state='completed'`,
      values: [input.organizationId, input.taskId, input.caseId, input.targetId, input.receiptId],
    });
    const row = result.rows[0];
    if (!row || !["application_prepare_submit", "interview_support"].includes(row.task_kind) ||
        !row.completion_record_json || typeof row.completion_record_json !== "object" ||
        Array.isArray(row.completion_record_json)) return null;
    return Object.freeze({ organizationId: input.organizationId, caseId: row.case_id,
      targetId: row.target_id, taskId: row.task_id, receiptId: row.receipt_id,
      evidenceReference: row.evidence_reference, kind: row.task_kind as TaskFactsKind,
      completionRecord: row.completion_record_json as Readonly<Record<string, unknown>> });
  }
}

interface CompletionRow {
  readonly task_id: string; readonly case_id: string; readonly target_id: string;
  readonly task_kind: string; readonly receipt_id: string; readonly evidence_reference: string | null;
  readonly completion_record_json: unknown;
}
