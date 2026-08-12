import type { AuditEvent } from "../../audit/contract.ts";
import type {
  ReconstructionActivationWrite,
  ReconstructionActor,
  ReconstructionCommandType,
  ReconstructionCreateCommand,
  ReconstructionEventInput,
  ReconstructionGapInput,
  ReconstructionGapReasonCode,
  ReconstructionIdempotencyScope,
  ReconstructionResult,
  ReconstructionServiceCaseBinding,
} from "./contract.ts";

export interface ReconstructionWriteContext {
  readonly organizationId: string;
  readonly actor: ReconstructionActor;
  readonly reconstructionId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  /** Hash of `idempotencyScope`; request metadata and generated IDs are excluded. */
  readonly requestHash: string;
  readonly idempotencyScope: ReconstructionIdempotencyScope;
  readonly recordedAt: string;
}

/**
 * Case binding is supplied by the later CaseWorkflow adapter. P3-03 owns only
 * this typed input and the transaction boundary; it does not create a live
 * CaseService or invent a production lookup fallback.
 */
export interface ReconstructionActivationBindingPort {
  readonly bindServiceCase: (
    input: ReconstructionServiceCaseBinding,
  ) => Promise<ReconstructionServiceCaseBinding>;
}

export interface CaseReconstructionRepository {
  /** Verifies pilot approval and current Primary Advisor assignment in one transaction. */
  createDraft(input: {
    readonly organizationId: string;
    readonly actor: ReconstructionActor;
    readonly reconstructionId: string;
    readonly reconstructionVersionId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly command: ReconstructionCreateCommand;
    readonly requestHash: string;
    readonly idempotencyScope: ReconstructionIdempotencyScope;
    readonly recordedAt: string;
  }): Promise<ReconstructionResult>;
  appendEvent(input: ReconstructionWriteContext & {
    readonly eventId: string;
    readonly event: ReconstructionEventInput;
  }): Promise<ReconstructionResult>;
  appendGap(input: ReconstructionWriteContext & {
    readonly gapId: string;
    readonly gap: ReconstructionGapInput;
  }): Promise<ReconstructionResult>;
  submit(input: ReconstructionWriteContext): Promise<ReconstructionResult>;
  requestChanges(input: ReconstructionWriteContext): Promise<ReconstructionResult>;
  createNextDraft(input: ReconstructionWriteContext & {
    readonly nextReconstructionVersionId: string;
  }): Promise<ReconstructionResult>;
  approve(input: ReconstructionWriteContext): Promise<ReconstructionResult>;
  /**
   * Atomically verifies the typed case binding, writes facts/history/gaps/audit,
   * records the approved version and emits the sole activation outbox event.
   */
  activate(input: ReconstructionActivationWrite & {
    readonly idempotencyScope: ReconstructionIdempotencyScope;
  }): Promise<ReconstructionResult>;
  appendCorrection(input: ReconstructionWriteContext & {
    readonly correctionId: string;
    readonly correctionOfEventId: string;
    readonly reasonCode: ReconstructionGapReasonCode;
    readonly event: ReconstructionEventInput;
    readonly audit: AuditEvent;
  }): Promise<ReconstructionResult>;
}

export type ReconstructionRepositoryCommand = ReconstructionCommandType;
