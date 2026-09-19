import { randomUUID } from "node:crypto";
import {hasRequestCapability,type RequestAccessActor} from "../../access/public.ts";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  canonicalSchoolValue,
  SCHOOL_IDENTITY_FIELDS,
  SchoolContractError,
  type JsonValue,
  type SchoolFieldClass,
  type SchoolOverlayEvidence,
} from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface SchoolServiceClock {
  nowMs(): number;
}

export interface CreateProvisionalSchoolCommand {
  readonly schoolNameZh?: string | null;
  readonly schoolNameEn?: string | null;
  readonly district?: string | null;
  readonly system?: string | null;
  readonly stage?: string | null;
  readonly reason?: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface SubmitSchoolChangeCommand {
  readonly fieldName: string;
  readonly fieldClass: SchoolFieldClass;
  readonly baseSnapshotId: string;
  readonly baseValueSha256: string;
  readonly expectedEffectiveValueSha256: string;
  readonly proposedValue: unknown;
  readonly reason: string;
  readonly evidence: SchoolOverlayEvidence;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface ProvisionalSchoolResult {
  readonly schoolId: string;
  readonly status: "provisional";
  readonly recordVersion: 1;
}

export interface SchoolChangeRequestResult {
  readonly changeRequestId: string;
  readonly schoolId: string;
  readonly baseSnapshotId: string;
  readonly fieldName: string;
  readonly status: "submitted";
  readonly recordVersion: 1;
}

export interface SchoolRepository {
  /**
   * The production adapter must atomically insert the School/provisional
   * facts, idempotency result, redacted audit event, and outbox row. It must
   * not use name or URL as a relationship key or infer an official URL.
   */
  createProvisionalSchool(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly schoolId: string;
    readonly schoolNameZh: string | null;
    readonly schoolNameEn: string | null;
    readonly district: string | null;
    readonly system: string | null;
    readonly stage: string | null;
    readonly reason: string | null;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<ProvisionalSchoolResult>;

  /**
   * The production adapter must read the visible immutable base record,
   * compare its value hash, allocate the next candidate overlay revision,
   * and insert the submitted request, idempotency result, audit, and outbox
   * in one RDS transaction. It must not approve, mutate, or resolve an
   * overlay in this command.
   */
  submitSchoolChange(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly changeRequestId: string;
    readonly schoolId: string;
    readonly fieldName: string;
    readonly fieldClass: SchoolFieldClass;
    readonly baseSnapshotId: string;
    readonly baseValueSha256: string;
    readonly expectedEffectiveValueSha256: string;
    readonly proposedValue: JsonValue;
    readonly reason: string;
    readonly evidence: SchoolOverlayEvidence;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly submittedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<SchoolChangeRequestResult>;
}

export type SchoolServiceErrorCode =
  | "SCHOOL_COMMAND_INVALID"
  | "SCHOOL_ADVISOR_REQUIRED"
  | "SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED"
  | "SCHOOL_CHANGE_IDEMPOTENCY_IN_PROGRESS"
  | "SCHOOL_CHANGE_BASE_NOT_FOUND"
  | "SCHOOL_CHANGE_BASE_STALE";

export class SchoolServiceError extends Error {
  readonly code: SchoolServiceErrorCode;

  constructor(code: SchoolServiceErrorCode) {
    super(`School command rejected ${code}.`);
    this.name = "SchoolServiceError";
    this.code = code;
  }
}

export interface SchoolServiceOptions {
  readonly repository: SchoolRepository;
  readonly clock?: SchoolServiceClock;
  readonly createId?: () => string;
}

/**
 * SchoolIntelligence owns provisional-school and submitted-change commands.
 * The repository is the transaction boundary because snapshot visibility,
 * base hashes, and idempotency must be read with the write.
 */
export class SchoolService {
  private readonly repository: SchoolRepository;
  private readonly clock: SchoolServiceClock;
  private readonly createId: () => string;

  constructor(options: SchoolServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async createProvisionalSchool(input: {
    readonly actor: IdentitySessionActor;
    readonly command: CreateProvisionalSchoolCommand;
  }): Promise<ProvisionalSchoolResult> {
    return createProvisionalSchool(input, {repository:this.repository,clock:this.clock,createId:this.createId});
  }

  async submitSchoolChange(input: {
    readonly actor: IdentitySessionActor;
    readonly schoolId: string;
    readonly command: SubmitSchoolChangeCommand;
  }): Promise<SchoolChangeRequestResult> {
    return submitSchoolChange(input,{repository:this.repository,clock:this.clock,createId:this.createId});
  }
}

/** BR-051 minimal manual intake; the repository owns atomic persistence and current authorization. */
export async function createProvisionalSchool(input: {actor: RequestAccessActor;command: CreateProvisionalSchoolCommand}, options: {repository: Pick<SchoolRepository,"createProvisionalSchool">;clock?: SchoolServiceClock;createId?:()=>string}):Promise<ProvisionalSchoolResult> {
    if (!UUID.test(input.actor.organizationId) || !UUID.test(input.actor.userId) ||
      !(hasRequestCapability(input.actor,"schools.provisional.create") ||
        (!input.actor.trialPrincipal && "role" in input.actor && input.actor.role === "advisor"))) {
      throw new SchoolServiceError("SCHOOL_ADVISOR_REQUIRED");
    }
    const fields = normalizeProvisionalCommand(input.command);

    const schoolId = (options.createId ?? randomUUID)();
    const auditId = (options.createId ?? randomUUID)();
    const outboxId = (options.createId ?? randomUUID)();
    for (const id of [schoolId, auditId, outboxId]) assertUuid(id);

    const createdAtMs = validNow((options.clock ?? {nowMs:()=>Date.now()}).nowMs());
    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "schools.provisional.created";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "School",
      resourceId: schoolId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        effect_type: "school_provisional_created",
        record_version: 1,
        status: "provisional",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "School",
      aggregateId: schoolId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-provisional-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: schoolId,
        effect_type: "school_provisional_created",
        record_version: 1,
        request_id: input.command.requestId,
        status: "provisional",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return options.repository.createProvisionalSchool({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      schoolId,
      ...fields,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload(fields),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
}

export async function submitSchoolChange(input:{actor:RequestAccessActor;schoolId:string;command:SubmitSchoolChangeCommand},options:{repository:Pick<SchoolRepository,'submitSchoolChange'>;clock?:SchoolServiceClock;createId?:()=>string}):Promise<SchoolChangeRequestResult>{
    assertSchoolChangeActor(input.actor);
    assertUuid(input.schoolId);
    const command = normalizeChangeCommand(input.command);

    const changeRequestId = (options.createId ?? randomUUID)();
    const auditId = (options.createId ?? randomUUID)();
    const outboxId = (options.createId ?? randomUUID)();
    for (const id of [changeRequestId, auditId, outboxId]) assertUuid(id);

    const submittedAtMs = validNow((options.clock ?? {nowMs:()=>Date.now()}).nowMs());
    const occurredAt = new Date(submittedAtMs).toISOString();
    const eventType = "schools.change_request.submitted";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "SchoolChangeRequest",
      resourceId: changeRequestId,
      outcome: "succeeded",
      requestId: command.requestId,
      occurredAt,
      metadata: {
        effect_type: "school_change_submitted",
        record_version: 1,
        status: "submitted",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "SchoolChangeRequest",
      aggregateId: changeRequestId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-change-${outboxId}`,
      requestId: command.requestId,
      payload: {
        aggregate_id: changeRequestId,
        effect_type: "school_change_submitted",
        record_version: 1,
        request_id: command.requestId,
        status: "submitted",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return options.repository.submitSchoolChange({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      changeRequestId,
      schoolId: input.schoolId,
      fieldName: command.fieldName,
      fieldClass: command.fieldClass,
      baseSnapshotId: command.baseSnapshotId,
      baseValueSha256: command.baseValueSha256,
      expectedEffectiveValueSha256: command.expectedEffectiveValueSha256,
      proposedValue: command.proposedValue,
      reason: command.reason,
      evidence: command.evidence,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        baseSnapshotId: command.baseSnapshotId,
        baseValueSha256: command.baseValueSha256,
        expectedEffectiveValueSha256: command.expectedEffectiveValueSha256,
        evidence: {
          sourceUrl: command.evidence.sourceUrl,
          quote: command.evidence.quote,
        },
        fieldClass: command.fieldClass,
        fieldName: command.fieldName,
        proposedValue: command.proposedValue,
        reason: command.reason,
        schoolId: input.schoolId,
      }),
      submittedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
}
function assertSchoolChangeActor(actor:RequestAccessActor){
  if(!UUID.test(actor.organizationId)||!UUID.test(actor.userId)||
    !(hasRequestCapability(actor,'schools.read')||(!actor.trialPrincipal&&'role' in actor&&actor.role==='advisor'))){
    throw new SchoolServiceError('SCHOOL_ADVISOR_REQUIRED');
  }
}

function normalizeProvisionalCommand(command: CreateProvisionalSchoolCommand) {
  const optional = (value: unknown, max: number): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim().length > max) throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
    return value.trim() || null;
  };
  const fields = {
    schoolNameZh: optional(command.schoolNameZh,512), schoolNameEn: optional(command.schoolNameEn,512),
    district: optional(command.district,128), system: optional(command.system,128),
    stage: optional(command.stage,128), reason: optional(command.reason,1024),
  };
  if (!fields.schoolNameZh && !fields.schoolNameEn) throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  assertRequest(command.requestId,command.idempotencyKey);
  return fields;
}

function normalizeChangeCommand(command: SubmitSchoolChangeCommand): Readonly<{
  fieldName: string;
  fieldClass: SchoolFieldClass;
  baseSnapshotId: string;
  baseValueSha256: string;
  expectedEffectiveValueSha256: string;
  proposedValue: JsonValue;
  reason: string;
  evidence: SchoolOverlayEvidence;
  requestId: string;
  idempotencyKey: string;
}> {
  if (!FIELD_NAME.test(command.fieldName)) throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  if (command.fieldClass !== "identity" && command.fieldClass !== "general") {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
  if (
    (SCHOOL_IDENTITY_FIELDS as readonly string[]).includes(command.fieldName) &&
    command.fieldClass !== "identity"
  ) {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
  if (!UUID.test(command.baseSnapshotId) || !SHA256.test(command.baseValueSha256) || !SHA256.test(command.expectedEffectiveValueSha256)) {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }

  const reason = assertNonBlank(command.reason, 1_024);
  assertRequest(command.requestId, command.idempotencyKey);
  try {
    return Object.freeze({
      fieldName: command.fieldName,
      fieldClass: command.fieldClass,
      baseSnapshotId: command.baseSnapshotId,
      baseValueSha256: command.baseValueSha256.toLowerCase(),
      expectedEffectiveValueSha256: command.expectedEffectiveValueSha256.toLowerCase(),
      proposedValue: canonicalSchoolValue(command.proposedValue),
      reason,
      evidence: normalizeEvidence(command.evidence),
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof SchoolContractError) {
      throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
    }
    throw error;
  }
}

function normalizeEvidence(evidence: SchoolOverlayEvidence): SchoolOverlayEvidence {
  const sourceUrl = assertNonBlank(evidence?.sourceUrl, 2_048);
  const quote = assertNonBlank(evidence?.quote, 1_024);
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") throw new Error("not https");
  } catch {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
  return Object.freeze({ sourceUrl, quote });
}

function assertRequest(requestId: string, idempotencyKey: string): void {
  if (!REQUEST_ID.test(requestId)) throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  try {
    validateIdempotencyKey(idempotencyKey);
  } catch {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
}

function assertNonBlank(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
  return normalized;
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SchoolServiceError("SCHOOL_COMMAND_INVALID");
  }
  return value;
}
