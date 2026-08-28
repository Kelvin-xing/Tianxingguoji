import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  hashRequestPayload,
} from "../../shared/public.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
  type TenantTransaction,
  type TenantTransactionRunner,
} from "../../shared/server.ts";
import {
  CandidateListError,
  type CandidateListAcknowledgement,
  type CandidateListRepository,
} from "../application/candidate-list-service.ts";

interface CommandRow {
  readonly decision: string;
  readonly result_record_version: number | string | null;
  readonly result_case_record_version?: number | string | null;
  readonly founder_decision_sha256?: string | null;
}

interface AuditAcknowledgementRow {
  readonly resource_id: string;
  readonly result_record_version: number | string;
  readonly founder_decision_sha256: string | null;
}

type RepositoryInput = Parameters<CandidateListRepository[keyof CandidateListRepository]>[0];

export class PostgresqlCandidateListRepository implements CandidateListRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  createVersion(input: Parameters<CandidateListRepository["createVersion"]>[0]) {
    return this.execute(input, {
      operation: "cases.candidate_list.create",
      requiredRole: "advisor",
      primaryOnly: true,
      sql: `SELECT decision,result_record_version
              FROM cases_create_candidate_list_version_v2(
                $1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz
              )`,
      values: [input.caseId,input.versionId,input.previousVersionId,
        input.expectedCaseRecordVersion,input.schoolSetSha256,input.changeSummary,
        JSON.stringify(input.items.map((item) => ({ id: item.id,school_id: item.schoolId,
          pinned_resolved_revision_id: item.pinnedResolvedRevisionId,
          pinned_resolution_sha256: item.pinnedResolutionSha256,ordinal: item.ordinal,
          application_deadline: item.applicationDeadline }))),
        input.occurredAt],
      resultReference: input.versionId,
      replayCaseVersion: false,
      replayFounderHash: false,
      flushDeferredTargetPromotion: true,
    });
  }

  reviewVersion(input: Parameters<CandidateListRepository["reviewVersion"]>[0]) {
    return this.execute(input, {
      operation: "cases.candidate_list.review",
      requiredRole: "founder",
      primaryOnly: false,
      sql: `SELECT decision,result_record_version,founder_decision_sha256
              FROM cases_review_candidate_list_version($1,$2,$3,$4,$5,$6::timestamptz)`,
      values: [input.caseId,input.versionId,input.expectedRecordVersion,input.decision,
        input.reason,input.occurredAt],
      resultReference: input.versionId,
      replayCaseVersion: false,
      replayFounderHash: true,
    });
  }

  recordGuardianDecision(input: Parameters<CandidateListRepository["recordGuardianDecision"]>[0]) {
    return this.execute(input, {
      operation: "cases.candidate_list.guardian_decision",
      requiredRole: "advisor",
      primaryOnly: true,
      sql: `SELECT decision,result_record_version
              FROM cases_record_guardian_list_decision(
                $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::timestamptz
              )`,
      values: [input.caseId,input.versionId,input.expectedListRecordVersion,
        input.expectedCaseRecordVersion,input.guardianId,input.guardianRelationshipId,
        input.decision,input.channel,input.guardianDecidedAt,
        input.boundFounderDecisionSha256,input.transitionFactId,input.occurredAt],
      resultReference: input.versionId,
      replayCaseVersion: false,
      replayFounderHash: false,
      flushDeferredTargetPromotion: true,
    });
  }

  closeCase(input: Parameters<CandidateListRepository["closeCase"]>[0]) {
    return this.execute(input, {
      operation: "cases.service_case.close",
      requiredRole: "founder",
      primaryOnly: false,
      sql: `SELECT decision,result_record_version
              FROM cases_close_service_case($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      values: [input.caseId,input.expectedCaseRecordVersion,input.closureOutcome,input.reason,
        input.transitionFactId,input.lifecycleFactId,input.occurredAt],
      resultReference: input.caseId,
      replayCaseVersion: false,
      replayFounderHash: false,
      resultKind: "case",
    });
  }

  private async execute(input: RepositoryInput, command: Readonly<{
    operation: string;
    requiredRole: "founder" | "advisor";
    primaryOnly: boolean;
    sql: string;
    values: readonly unknown[];
    resultReference: string;
    replayCaseVersion: boolean;
    replayFounderHash: boolean;
    flushDeferredTargetPromotion?: boolean;
    resultKind?: "version" | "case";
  }>): Promise<CandidateListAcknowledgement> {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: { organizationId: input.organizationId, actorKind: "user",
          actorOpaqueId: input.actorUserId, actorUserId: input.actorUserId,
          requestId: input.effects.audit.requestId },
        claim: { id: input.idempotencyRecordId, organizationId: input.organizationId,
          actorKind: "user", actorOpaqueId: input.actorUserId, operation: command.operation,
          key: input.idempotencyKey, requestHash: input.requestHash, createdAt: input.occurredAt },
        revalidate: async (transaction) => {
          const authorization = await transaction.query<{ allowed: boolean }>({
            text: "SELECT cases_actor_has_active_case_role($1,$2,$3) AS allowed",
            values: [input.caseId,command.requiredRole,command.primaryOnly],
          });
          if (authorization.rows[0]?.allowed !== true) {
            throw new CandidateListError("CANDIDATE_LIST_NOT_FOUND");
          }
        },
        execute: async (transaction) => {
          const response = await transaction.query<CommandRow>({
            text: command.sql, values: command.values,
          });
          const row = response.rows[0];
          if (!row) throw new CandidateListError("CANDIDATE_LIST_CONFLICT");
          assertAllowed(row.decision);
          if (command.flushDeferredTargetPromotion === true) {
            await transaction.query({
              text: "SET CONSTRAINTS ALL IMMEDIATE",
            });
          }
          const acknowledgement = Object.freeze({
            id: command.resultReference,
            recordVersion: Number(row.result_record_version),
            ...(row.result_case_record_version == null ? {} : {
              caseRecordVersion: Number(row.result_case_record_version),
            }),
            ...(row.founder_decision_sha256 == null ? {} : {
              founderDecisionSha256: row.founder_decision_sha256,
            }),
          });
          await appendAtomicMutationEffects(adaptTransaction(transaction), input.effects);
          return { state: "completed" as const, resultReference: input.effects.audit.id,
            responseHash: hashAcknowledgement(acknowledgement), updatedAt: input.occurredAt,
            value: acknowledgement };
        },
      });
      if (result.status === "executed") return result.value;
      const replay = await this.readAcknowledgement(input,result.resultReference,command);
      if (result.responseHash !== hashAcknowledgement(replay)) {
        throw new CandidateListError("CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS");
      }
      return replay;
    } catch (error) {
      if (error instanceof IdempotencyExecutionError) {
        if (error.code === "IDEMPOTENCY_KEY_REUSED") {
          throw new CandidateListError("CANDIDATE_LIST_IDEMPOTENCY_KEY_REUSED");
        }
        throw new CandidateListError("CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS");
      }
      if (!(error instanceof CandidateListError)) {
        process.stderr.write(
          `event=candidate_list_postgres_failure operation=${command.operation}` +
          ` postgres_code=${safePostgresCode(error)}` +
          ` postgres_constraint=${safePostgresConstraint(error)}` +
          ` postgres_permission=${safePostgresPermission(error)}\n`,
        );
      }
      throw error;
    }
  }

  private readAcknowledgement(input: RepositoryInput, auditEventId: string,
    command: Readonly<{ replayCaseVersion: boolean; replayFounderHash: boolean }>) {
    return this.runner.run({ organizationId: input.organizationId, actorKind: "user",
      actorOpaqueId: input.actorUserId, actorUserId: input.actorUserId,
      requestId: input.effects.audit.requestId }, async (transaction) => {
      const result = await transaction.query<AuditAcknowledgementRow>({
        text: `SELECT audit.resource_id,
                      (audit.metadata->>'record_version')::bigint AS result_record_version,
                      version.founder_decision_sha256
                 FROM audit_events AS audit
                 LEFT JOIN cases_candidate_school_list_versions AS version
                   ON version.id=audit.resource_id AND version.organization_id=audit.organization_id
                WHERE audit.id=$1`,
        values: [auditEventId],
      });
      const row = result.rows[0];
      if (!row) throw new CandidateListError("CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS");
      return Object.freeze({ id: row.resource_id, recordVersion: Number(row.result_record_version),
        ...(!command.replayFounderHash || row.founder_decision_sha256 === null ? {} : {
          founderDecisionSha256: row.founder_decision_sha256,
        }) });
    });
  }
}

function adaptTransaction(transaction: TenantTransaction) {
  return { async query<Row extends Record<string, unknown>>(text: string,
    values?: readonly unknown[]) {
    const result = await transaction.query<Row>({ text, values });
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } };
}

function assertAllowed(decision: string): void {
  if (decision === "allowed") return;
  if (new Set([
    "CANDIDATE_LIST_INVALID", "CANDIDATE_LIST_NOT_FOUND", "CANDIDATE_LIST_STALE_VERSION",
    "CANDIDATE_LIST_CASE_NOT_ACTIVE", "CANDIDATE_LIST_BACKGROUND_INCOMPLETE",
    "CANDIDATE_LIST_SELECTION_BLOCKED", "CANDIDATE_LIST_GUARDIAN_INVALID",
    "CASE_CLOSE_INVALID", "CASE_CLOSE_NOT_FOUND", "CASE_CLOSE_STALE_VERSION",
    "CASE_CLOSE_TARGETS_INCOMPLETE", "CASE_CLOSE_TASKS_INCOMPLETE",
  ]).has(decision)) throw new CandidateListError(decision as ConstructorParameters<typeof CandidateListError>[0]);
  throw new CandidateListError("CANDIDATE_LIST_CONFLICT");
}

function hashAcknowledgement(value: CandidateListAcknowledgement): string {
  return hashRequestPayload({ id: value.id, record_version: value.recordVersion,
    ...(value.caseRecordVersion === undefined ? {} : {
      case_record_version: value.caseRecordVersion,
    }), ...(value.founderDecisionSha256 === undefined ? {} : {
      founder_decision_sha256: value.founderDecisionSha256,
    }) });
}

function safePostgresCode(error: unknown): string {
  const code = valueFromError(error, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "OTHER";
}

function safePostgresConstraint(error: unknown): string {
  const constraint = valueFromError(error, "constraint");
  return typeof constraint === "string" && /^[a-z0-9_]{1,96}$/.test(constraint)
    ? constraint
    : "NONE";
}

function safePostgresPermission(error: unknown): string {
  const message = valueFromError(error, "message");
  if (typeof message !== "string") return "NONE";
  const denied = /^permission denied for (table|sequence|schema|function) ([a-z0-9_]+)$/i
    .exec(message);
  if (denied) return `DENIED_${denied[1]!.toUpperCase()}_${denied[2]!.toUpperCase()}`;
  const rowSecurity = /^(?:new row violates|query would be affected by) row-level security policy for table "([a-z0-9_]+)"$/i
    .exec(message);
  return rowSecurity ? `RLS_${rowSecurity[1]!.toUpperCase()}` : "OTHER";
}

function valueFromError(error: unknown, field: "code" | "constraint" | "message"): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}
