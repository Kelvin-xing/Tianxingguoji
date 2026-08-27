import { randomUUID } from "node:crypto";

import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import {
  hashRequestPayload,
  validateIdempotencyKey,
  type AccessCaseIntakeOwnerPort,
  type CrmCaseIntakeOwnerPort,
} from "../../shared/public.ts";
import type { TenantTransaction } from "../../shared/server.ts";
import {
  CASE_INTAKE_ADMISSION_TYPES,
  CaseIntakeError,
  isCaseIntakeError,
  type CaseIntakeAdmissionType,
  type CaseIntakeAdvisorOption,
  type CaseIntakeCommand,
  type CaseIntakeOption,
  type CaseIntakeOptions,
  type CaseIntakeReceipt,
} from "../domain/intake-contract.ts";

export {
  CASE_INTAKE_ADMISSION_TYPES,
  CaseIntakeError,
  isCaseIntakeError,
  type CaseIntakeAdmissionType,
  type CaseIntakeAdvisorOption,
  type CaseIntakeCommand,
  type CaseIntakeOption,
  type CaseIntakeOptions,
  type CaseIntakeReceipt,
} from "../domain/intake-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADMISSION_TYPES = CASE_INTAKE_ADMISSION_TYPES;

interface IntakeActor {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: "advisor";
}

export interface CaseIntakeRepository {
  createCase(input: IntakeActor & {
    readonly studentId: string;
    readonly primaryAdvisorRoleBindingId: string;
    readonly referralSourceId: string | null;
    readonly intakeYear: number;
    readonly admissionType: CaseIntakeAdmissionType;
    readonly signedAt: string;
    readonly caseId: string;
    readonly assessmentId: string;
    readonly transitionFactId: string;
    readonly primaryAssignmentId: string;
    readonly referralSourceAssignmentId: string | null;
    readonly idempotencyRecordId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CaseIntakeReceipt>;
}

export type CrmCaseIntakeOwnerQueries = CrmCaseIntakeOwnerPort;
export type AccessCaseIntakeOwnerQueries = AccessCaseIntakeOwnerPort;

export class CaseIntakeOptionsCoordinator {
  private readonly crm: CrmCaseIntakeOwnerQueries;
  private readonly access: AccessCaseIntakeOwnerQueries;

  constructor(crm: CrmCaseIntakeOwnerQueries, access: AccessCaseIntakeOwnerQueries) {
    this.crm = crm;
    this.access = access;
  }

  async list(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentQuery: string | null;
    readonly advisorQuery: string | null;
    readonly referralSourceQuery: string | null;
  }>): Promise<CaseIntakeOptions> {
    const [students, advisors, referralSources] = await Promise.all([
      this.crm.listStudents({ organizationId: input.organizationId, actorUserId: input.actorUserId, query: input.studentQuery }),
      this.access.listAdvisors({ organizationId: input.organizationId, actorUserId: input.actorUserId, query: input.advisorQuery }),
      this.crm.listReferralSources({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        query: input.referralSourceQuery,
      }),
    ]);
    return Object.freeze({
      students: Object.freeze([...students].slice(0, 20)),
      advisors: Object.freeze([...advisors].slice(0, 20)),
      referralSources: Object.freeze([...referralSources].slice(0, 20)),
    });
  }
}

export class CaseIntakeService {
  private readonly repository: CaseIntakeRepository;
  private readonly optionsCoordinator: CaseIntakeOptionsCoordinator;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: CaseIntakeRepository,
    optionsCoordinator: CaseIntakeOptionsCoordinator,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.optionsCoordinator = optionsCoordinator;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  listIntakeOptions(
    actor: RequestAccessActor,
    filters: Readonly<{
      readonly studentQuery?: string | null;
      readonly advisorQuery?: string | null;
      readonly referralSourceQuery?: string | null;
    }> = {},
  ): Promise<CaseIntakeOptions> {
    const context = authorizeAdvisor(actor);
    const normalized = {
      organizationId: context.organizationId,
      actorUserId: context.actorUserId,
      studentQuery: normalizeQuery(filters.studentQuery),
      advisorQuery: normalizeQuery(filters.advisorQuery),
      referralSourceQuery: normalizeQuery(filters.referralSourceQuery),
    };
    return this.optionsCoordinator.list(normalized);
  }

  async createCase(input: Readonly<{
    readonly actor: RequestAccessActor;
    readonly command: CaseIntakeCommand;
  }>): Promise<CaseIntakeReceipt> {
    const context = authorizeAdvisor(input.actor);
    const command = normalizeCommand(input.command);

    const caseId = checkedId(this.createId());
    const assessmentId = checkedId(this.createId());
    const transitionFactId = checkedId(this.createId());
    const primaryAssignmentId = checkedId(this.createId());
    const referralSourceAssignmentId = command.referralSourceId === null
      ? null
      : checkedId(this.createId());
    const idempotencyRecordId = checkedId(this.createId());
    const auditId = checkedId(this.createId());
    const outboxId = checkedId(this.createId());
    const createdAtMs = this.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new CaseIntakeError("CASE_INTAKE_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: "cases.service_case_created",
      eventVersion: 1,
      action: "create",
      resourceType: "ServiceCase",
      resourceId: caseId,
      outcome: "succeeded",
      requestId: command.requestId,
      occurredAt,
      metadata: {
        record_version: 2,
        status: "background_collection",
        effect_type: "case.created",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "ServiceCase",
      aggregateId: caseId,
      eventType: "cases.service_case_created",
      eventVersion: 1,
      idempotencyKey: `case-create-${outboxId}`,
      requestId: command.requestId,
      payload: {
        aggregate_id: caseId,
        request_id: command.requestId,
        effect_type: "case.created",
        record_version: 2,
        status: "background_collection",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    try {
      return await this.repository.createCase({
        ...context,
        studentId: command.studentId,
        primaryAdvisorRoleBindingId: command.primaryAdvisorRoleBindingId,
        referralSourceId: command.referralSourceId,
        intakeYear: command.intakeYear,
        admissionType: command.admissionType,
        signedAt: command.signedAt,
        caseId,
        assessmentId,
        transitionFactId,
        primaryAssignmentId,
        referralSourceAssignmentId,
        idempotencyRecordId,
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        requestHash: hashRequestPayload({
          admission_type: command.admissionType,
          intake_year: command.intakeYear,
          primary_advisor_role_binding_id: command.primaryAdvisorRoleBindingId,
          referral_source_id: command.referralSourceId,
          signed_at: command.signedAt,
          student_id: command.studentId,
        }),
        createdAtMs,
        effects: buildAtomicMutationEffects({ audit, outbox }),
      });
    } catch (error) {
      if (isCaseIntakeError(error)) throw error;
      throw new CaseIntakeError("CASE_INTAKE_UNAVAILABLE");
    }
  }
}

function authorizeAdvisor(actor: RequestAccessActor): IntakeActor {
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !hasRequestCapability(actor, "cases.create") ||
    !actor.roles?.includes("advisor")
  ) {
    throw new CaseIntakeError("CASE_INTAKE_FORBIDDEN");
  }
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: "advisor",
  };
}

function assertCommand(command: CaseIntakeCommand): void {
  const fields: Record<string, string> = {};
  if (!UUID.test(command.studentId)) fields.student_id = "invalid_uuid";
  if (!UUID.test(command.primaryAdvisorRoleBindingId)) {
    fields.primary_advisor_role_binding_id = "invalid_uuid";
  }
  if (command.referralSourceId !== null && !UUID.test(command.referralSourceId)) {
    fields.referral_source_id = "invalid_uuid";
  }
  if (!Number.isSafeInteger(command.intakeYear) || command.intakeYear < 1) {
    fields.intake_year = "invalid_year";
  }
  if (!(ADMISSION_TYPES as readonly string[]).includes(command.admissionType)) {
    fields.admission_type = "invalid_admission_type";
  }
  if (!isCanonicalIsoWithTimezone(command.signedAt)) fields.signed_at = "invalid_iso8601";
  if (!REQUEST_ID.test(command.requestId)) fields.request_id = "invalid_request_id";
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    fields.idempotency_key = "invalid_idempotency_key";
  }
  if (Object.keys(fields).length > 0) throw new CaseIntakeError("CASE_INTAKE_INVALID", fields);
}

function normalizeCommand(command: CaseIntakeCommand): CaseIntakeCommand {
  assertCommand(command);
  return Object.freeze({
    ...command,
    studentId: command.studentId.toLowerCase(),
    primaryAdvisorRoleBindingId: command.primaryAdvisorRoleBindingId.toLowerCase(),
    referralSourceId: command.referralSourceId?.toLowerCase() ?? null,
    signedAt: new Date(Date.parse(command.signedAt)).toISOString(),
  });
}

function normalizeQuery(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > 100) throw new CaseIntakeError("CASE_INTAKE_INVALID");
  return normalized || null;
}

function isCanonicalIsoWithTimezone(value: string): boolean {
  if (typeof value !== "string" || !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() !== "Invalid Date";
}

function checkedId(value: string): string {
  if (!UUID.test(value)) throw new CaseIntakeError("CASE_INTAKE_INVALID");
  return value.toLowerCase();
}
