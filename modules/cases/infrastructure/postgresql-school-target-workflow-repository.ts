import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
  type TenantTransaction,
  type TenantTransactionRunner,
} from "../../shared/server.ts";
import type { TaskCompletionFactsPort } from "../../shared/public.ts";
import type { SchoolTargetWorkflowRepository } from "../application/school-target-workflow.ts";
import { SchoolTargetWorkflowError } from "../application/school-target-workflow.ts";

export class PostgresqlSchoolTargetWorkflowRepository implements SchoolTargetWorkflowRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly taskFacts: TaskCompletionFactsPort;

  constructor(runner: TenantTransactionRunner, taskFacts: TaskCompletionFactsPort) {
    this.runner = runner; this.taskFacts = taskFacts;
  }

  async recordApplicationSubmission(input: Parameters<SchoolTargetWorkflowRepository["recordApplicationSubmission"]>[0]) {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: { organizationId: input.actor.organizationId, actorKind: "user", actorOpaqueId: input.actor.userId,
          actorUserId: input.actor.userId, requestId: input.requestId },
        claim: { id: input.idempotencyRecordId, organizationId: input.actor.organizationId,
          actorKind: "user", actorOpaqueId: input.actor.userId,
          operation: "cases.school_target.application_submission", key: input.idempotencyKey,
          requestHash: input.requestHash, createdAt: input.occurredAt },
        revalidate: async (transaction) => {
          const authorization = await transaction.query<{ allowed: boolean }>({
            text: "SELECT cases_actor_has_active_case_role($1,'advisor',true) AS allowed",
            values: [input.caseId],
          });
          if (authorization.rows[0]?.allowed !== true) throw new SchoolTargetWorkflowError("FORBIDDEN");
          const completion = await this.taskFacts.readCompletionFacts(transaction, {
            organizationId: input.actor.organizationId, caseId: input.caseId, targetId: input.targetId,
            taskId: input.taskId, receiptId: input.completionReceiptId,
          });
          if (!completion || completion.kind !== "application_prepare_submit" ||
              completion.evidenceReference !== input.evidenceReference ||
              JSON.stringify(completion.completionRecord) !== JSON.stringify(input.completion)) {
            throw new SchoolTargetWorkflowError("CONFLICT");
          }
        },
        execute: async (transaction) => {
          const targetResult = await transaction.query<TargetRow>({
            text: `SELECT id,service_case_id,state,record_version,current_assignment_id
                     FROM cases_school_targets
                    WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR UPDATE`,
            values: [input.targetId, input.actor.organizationId, input.caseId],
          });
          const target = targetResult.rows[0];
          if (!target) throw new SchoolTargetWorkflowError("NOT_FOUND");
          if (target.state !== "preparing") throw new SchoolTargetWorkflowError("CONFLICT");
          if (Number(target.record_version) !== input.expectedTargetRecordVersion) throw new SchoolTargetWorkflowError("STALE_VERSION");
          const completion = await this.taskFacts.readCompletionFacts(transaction, {
            organizationId: input.actor.organizationId, caseId: input.caseId, targetId: input.targetId,
            taskId: input.taskId, receiptId: input.completionReceiptId,
          });
          if (!completion || completion.kind !== "application_prepare_submit" || completion.evidenceReference !== input.evidenceReference) {
            throw new SchoolTargetWorkflowError("CONFLICT");
          }
          const record = completion.completionRecord;
          const noReference = record.no_reference_declared === true;
          const official = typeof record.official_submission_reference === "string" ? record.official_submission_reference : null;
          if ((!official && !noReference) || (official && noReference)) throw new SchoolTargetWorkflowError("INVALID");
          await transaction.query({
            text: `INSERT INTO cases_school_target_transition_facts
              (id,organization_id,service_case_id,school_target_id,transition_kind,from_state,to_state,
               actor_user_id,assignment_id,from_record_version,to_record_version,submission_task_id,
               task_completion_receipt_id,submission_channel,submitted_at,official_submission_reference,
               no_reference_declared,alternative_evidence_document_id,occurred_at)
             VALUES ($1,$2,$3,$4,'workflow','preparing','submitted',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            values: [input.transitionFactId, input.actor.organizationId, input.caseId, input.targetId,
              input.actor.userId, target.current_assignment_id, input.expectedTargetRecordVersion,
              input.expectedTargetRecordVersion + 1, input.taskId, input.completionReceiptId,
              record.submission_channel, record.submitted_at, official, noReference,
              input.evidenceReference, input.occurredAt],
          });
          const updated = await transaction.query({
            text: `UPDATE cases_school_targets SET state='submitted',record_version=record_version+1,updated_at=$1
                    WHERE id=$2 AND organization_id=$3 AND record_version=$4`,
            values: [input.occurredAt, input.targetId, input.actor.organizationId, input.expectedTargetRecordVersion],
          });
          if ((updated.rowCount ?? 0) !== 1) throw new SchoolTargetWorkflowError("STALE_VERSION");
          await appendAtomicMutationEffects(adapt(transaction), input.effects);
          const acknowledgement = Object.freeze({ id: input.targetId,
            recordVersion: input.expectedTargetRecordVersion + 1, state: "submitted" });
          return { state: "completed" as const, resultReference: input.targetId,
            responseHash: hashAcknowledgement(acknowledgement), updatedAt: input.occurredAt,
            value: acknowledgement };
        },
      });
      if (result.status === "executed") return result.value;
      const replay = await this.readAcknowledgement(input);
      if (result.responseHash !== hashAcknowledgement(replay)) throw new SchoolTargetWorkflowError("CONFLICT");
      return replay;
    } catch (error) {
      if (error instanceof SchoolTargetWorkflowError) throw error;
      if (error instanceof IdempotencyExecutionError) {
        throw new SchoolTargetWorkflowError(error.code === "IDEMPOTENCY_KEY_REUSED" ? "CONFLICT" : "UNAVAILABLE");
      }
      throw new SchoolTargetWorkflowError("UNAVAILABLE");
    }
  }

  private readAcknowledgement(input: Parameters<SchoolTargetWorkflowRepository["recordApplicationSubmission"]>[0]) {
    return this.runner.run({ organizationId: input.actor.organizationId, actorKind: "user", actorOpaqueId: input.actor.userId,
      actorUserId: input.actor.userId, requestId: input.requestId }, async (transaction) => {
      const result = await transaction.query<TargetRow>({ text: `SELECT id,service_case_id,state,record_version,current_assignment_id FROM cases_school_targets WHERE id=$1 AND organization_id=$2`, values: [input.targetId, input.actor.organizationId] });
      const row = result.rows[0]; if (!row) throw new SchoolTargetWorkflowError("NOT_FOUND");
      return Object.freeze({ id: row.id, recordVersion: Number(row.record_version), state: row.state });
    });
  }
}

interface TargetRow { readonly id: string; readonly service_case_id: string; readonly state: string; readonly record_version: number | string; readonly current_assignment_id: string | null; }
function hashAcknowledgement(value: Readonly<{ id: string; recordVersion: number; state: string }>) { return hashRequestPayload({ id: value.id, record_version: value.recordVersion, state: value.state }); }
function adapt(transaction: TenantTransaction) { return { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => { const result = await transaction.query<Row>({ text, values }); return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }; } }; }
