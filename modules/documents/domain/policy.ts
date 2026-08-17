import { DOCUMENT_OBJECT_REGION } from "./contract.ts";

export const DOCUMENT_POLICY_VERSION = "hk_document_retention_export_v1" as const;
export const DOCUMENT_EXPORT_MAX_TTL_MS = 15 * 60 * 1000;

export const DOCUMENT_CLASSIFICATIONS = Object.freeze([
  "identity_and_case_evidence",
  "operational_attachment",
  "temporary_upload",
] as const);

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

export interface DocumentPolicyActor {
  readonly organizationId: string;
  readonly userId: string;
  /**
   * This is derived from the current authenticated role by the RDS adapter.
   * The adapter must re-evaluate it in the mutation transaction.
   */
  readonly isFounder: boolean;
}

export interface DocumentRetentionContext {
  readonly policyVersion: string;
  readonly classification: string;
  readonly documentCreatedAtMs: number;
  readonly attachedToCase: boolean;
  readonly caseClosedAtMs: number | null;
}

export interface ResolvedDocumentRetention {
  readonly policyVersion: typeof DOCUMENT_POLICY_VERSION;
  readonly classification: DocumentClassification;
  readonly retentionEndsAtMs: number;
  readonly scheduleAnchor: "case_closure" | "document_creation";
}

export interface DocumentCleanupPolicyInput {
  readonly retention: DocumentRetentionContext;
  readonly legalHold: boolean;
  readonly founderApproved: boolean;
  readonly nowMs: number;
}

export interface DocumentCleanupPolicyEvidence {
  readonly policyVersion: typeof DOCUMENT_POLICY_VERSION;
  readonly classification: DocumentClassification;
  readonly retentionEndsAtMs: number;
  readonly legalHold: boolean;
  readonly founderApproved: boolean;
}

export interface DocumentExportPolicyInput {
  readonly actor: DocumentPolicyActor;
  readonly retention: DocumentRetentionContext;
  readonly documentStorageRegion: string;
  readonly hkRegionHealthy: boolean;
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly watermarkRequired: boolean;
}

export type DocumentPolicyDenialCode =
  | "DOCUMENT_POLICY_COMMAND_INVALID"
  | "DOCUMENT_POLICY_EXPORT_EXPIRED"
  | "DOCUMENT_POLICY_EXPORT_TTL_INVALID"
  | "DOCUMENT_POLICY_FOUNDER_REQUIRED"
  | "DOCUMENT_POLICY_HK_UNAVAILABLE"
  | "DOCUMENT_POLICY_LEGAL_HOLD"
  | "DOCUMENT_POLICY_RECEIPT_INVALID"
  | "DOCUMENT_POLICY_RETENTION_NOT_REACHED"
  | "DOCUMENT_POLICY_RETENTION_CONTEXT_INVALID"
  | "DOCUMENT_POLICY_STORAGE_REGION_INVALID"
  | "DOCUMENT_POLICY_UNKNOWN_CLASSIFICATION"
  | "DOCUMENT_POLICY_VERSION_UNSUPPORTED"
  | "DOCUMENT_POLICY_WATERMARK_REQUIRED";

export type DocumentPolicyDecision<T> =
  | { readonly allowed: true; readonly value: T }
  | { readonly allowed: false; readonly code: DocumentPolicyDenialCode };

export class DocumentPolicyError extends Error {
  readonly code: DocumentPolicyDenialCode;

  constructor(code: DocumentPolicyDenialCode) {
    super(`Document policy rejected ${code}.`);
    this.name = "DocumentPolicyError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function isValidTimestamp(value: number | null): value is number {
  return Number.isSafeInteger(value) && value >= 0;
}

function resolveClassification(value: string): DocumentClassification | null {
  return (DOCUMENT_CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as DocumentClassification)
    : null;
}

function addUtcCalendarYears(timestampMs: number, years: number): number {
  const source = new Date(timestampMs);
  const targetYear = source.getUTCFullYear() + years;
  const month = source.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return Date.UTC(
    targetYear,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}

function addUtcCalendarDays(timestampMs: number, days: number): number {
  return timestampMs + days * 24 * 60 * 60 * 1000;
}

function validCommandId(value: string): boolean {
  return UUID.test(value);
}

function validMutationCommand(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly caseId: string;
  readonly documentId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}): boolean {
  return (
    validCommandId(input.organizationId) &&
    validCommandId(input.userId) &&
    validCommandId(input.caseId) &&
    validCommandId(input.documentId) &&
    Number.isSafeInteger(input.expectedRecordVersion) &&
    input.expectedRecordVersion >= 1 &&
    REQUEST_ID.test(input.requestId) &&
    IDEMPOTENCY_KEY.test(input.idempotencyKey)
  );
}

/**
 * Resolves the OD-02 retention date only. It never authorizes deletion or
 * substitutes for the P0-10 soft-delete, reference, and record-version gates.
 */
export function resolveDocumentRetention(
  context: DocumentRetentionContext,
): DocumentPolicyDecision<ResolvedDocumentRetention> {
  if (context.policyVersion !== DOCUMENT_POLICY_VERSION) {
    return { allowed: false, code: "DOCUMENT_POLICY_VERSION_UNSUPPORTED" };
  }
  if (!isValidTimestamp(context.documentCreatedAtMs)) {
    return { allowed: false, code: "DOCUMENT_POLICY_RETENTION_CONTEXT_INVALID" };
  }

  const classification = resolveClassification(context.classification);
  if (classification === null) {
    return { allowed: false, code: "DOCUMENT_POLICY_UNKNOWN_CLASSIFICATION" };
  }

  if (classification === "temporary_upload") {
    if (context.attachedToCase || context.caseClosedAtMs !== null) {
      return { allowed: false, code: "DOCUMENT_POLICY_RETENTION_CONTEXT_INVALID" };
    }
    return {
      allowed: true,
      value: {
        policyVersion: DOCUMENT_POLICY_VERSION,
        classification,
        retentionEndsAtMs: addUtcCalendarDays(context.documentCreatedAtMs, 30),
        scheduleAnchor: "document_creation",
      },
    };
  }

  if (!context.attachedToCase || !isValidTimestamp(context.caseClosedAtMs)) {
    return { allowed: false, code: "DOCUMENT_POLICY_RETENTION_CONTEXT_INVALID" };
  }

  return {
    allowed: true,
    value: {
      policyVersion: DOCUMENT_POLICY_VERSION,
      classification,
      retentionEndsAtMs: addUtcCalendarYears(
        context.caseClosedAtMs,
        classification === "identity_and_case_evidence" ? 7 : 2,
      ),
      scheduleAnchor: "case_closure",
    },
  };
}

/**
 * Applies only the new retention and legal-hold conditions. A repository must
 * additionally enforce P0-10's pending-delete, reference, and concurrency
 * conditions in the same transaction as a later purge command.
 */
export function evaluateDocumentCleanupPolicy(
  input: DocumentCleanupPolicyInput,
): DocumentPolicyDecision<DocumentCleanupPolicyEvidence> {
  if (!isValidTimestamp(input.nowMs)) {
    return { allowed: false, code: "DOCUMENT_POLICY_COMMAND_INVALID" };
  }
  const retention = resolveDocumentRetention(input.retention);
  if (!retention.allowed) return retention;

  const evidence: DocumentCleanupPolicyEvidence = {
    policyVersion: retention.value.policyVersion,
    classification: retention.value.classification,
    retentionEndsAtMs: retention.value.retentionEndsAtMs,
    legalHold: input.legalHold,
    founderApproved: input.founderApproved,
  };
  if (input.legalHold) {
    return { allowed: false, code: "DOCUMENT_POLICY_LEGAL_HOLD" };
  }
  if (!input.founderApproved) {
    return { allowed: false, code: "DOCUMENT_POLICY_FOUNDER_REQUIRED" };
  }
  if (input.nowMs < retention.value.retentionEndsAtMs) {
    return { allowed: false, code: "DOCUMENT_POLICY_RETENTION_NOT_REACHED" };
  }
  return { allowed: true, value: evidence };
}

/**
 * Verifies the non-negotiable properties of a future export grant before the
 * repository creates it. The repository must re-check every mutable fact.
 */
export function evaluateDocumentExportPolicy(
  input: DocumentExportPolicyInput,
): DocumentPolicyDecision<{
  readonly policyVersion: typeof DOCUMENT_POLICY_VERSION;
  readonly classification: DocumentClassification;
}> {
  if (!input.actor.isFounder) {
    return { allowed: false, code: "DOCUMENT_POLICY_FOUNDER_REQUIRED" };
  }
  if (!input.hkRegionHealthy) {
    return { allowed: false, code: "DOCUMENT_POLICY_HK_UNAVAILABLE" };
  }
  if (input.documentStorageRegion !== DOCUMENT_OBJECT_REGION) {
    return { allowed: false, code: "DOCUMENT_POLICY_STORAGE_REGION_INVALID" };
  }
  if (!input.watermarkRequired) {
    return { allowed: false, code: "DOCUMENT_POLICY_WATERMARK_REQUIRED" };
  }
  if (!isValidTimestamp(input.nowMs) || !isValidTimestamp(input.expiresAtMs)) {
    return { allowed: false, code: "DOCUMENT_POLICY_COMMAND_INVALID" };
  }
  if (input.expiresAtMs <= input.nowMs) {
    return { allowed: false, code: "DOCUMENT_POLICY_EXPORT_EXPIRED" };
  }
  if (input.expiresAtMs - input.nowMs > DOCUMENT_EXPORT_MAX_TTL_MS) {
    return { allowed: false, code: "DOCUMENT_POLICY_EXPORT_TTL_INVALID" };
  }
  const retention = resolveDocumentRetention(input.retention);
  if (!retention.allowed) return retention;
  return {
    allowed: true,
    value: {
      policyVersion: retention.value.policyVersion,
      classification: retention.value.classification,
    },
  };
}

export interface DocumentPolicyAuditReceipt {
  readonly auditEventId: string;
  readonly outboxMessageId: string;
}

export interface DocumentLegalHoldCommand {
  readonly action: "place" | "release";
  readonly reason: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface DocumentLegalHoldResult {
  readonly documentId: string;
  readonly legalHold: boolean;
  readonly recordVersion: number;
  readonly receipt: DocumentPolicyAuditReceipt;
}

export interface CreateDocumentExportCommand {
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly expiresAtMs: number;
}

export interface DocumentExportGrant {
  readonly exportId: string;
  readonly documentId: string;
  readonly expiresAtMs: number;
  readonly remainingUses: 1;
  readonly watermarkRequired: true;
  readonly storageRegion: typeof DOCUMENT_OBJECT_REGION;
  readonly receipt: DocumentPolicyAuditReceipt;
}

export interface ConsumeDocumentExportCommand {
  readonly exportId: string;
  readonly requestId: string;
}

export interface DocumentExportDownload {
  /** A short-lived private HTTPS location, never a public or durable URL. */
  readonly location: string;
  readonly expiresAtMs: number;
  readonly watermarkRequired: true;
  readonly storageRegion: typeof DOCUMENT_OBJECT_REGION;
  readonly receipt: DocumentPolicyAuditReceipt;
}

export interface DocumentPolicyRepository {
  /**
   * Lock the current session, role, tenant, case/document relationship, and
   * idempotency record, then atomically persist the legal-hold fact, audit,
   * outbox, and idempotency result. Hold release is a separate explicit write.
   */
  mutateLegalHold(input: {
    readonly actor: DocumentPolicyActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: DocumentLegalHoldCommand;
    readonly policyVersion: typeof DOCUMENT_POLICY_VERSION;
    readonly mutatedAtMs: number;
  }): Promise<DocumentLegalHoldResult>;
  /**
   * Lock current authorization, document/version/region health, and
   * idempotency facts in one RDS transaction. Persist a private, one-use grant
   * with audit/outbox facts; do not issue a public URL or handle bytes here.
   */
  createExportGrant(input: {
    readonly actor: DocumentPolicyActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: CreateDocumentExportCommand;
    readonly policyVersion: typeof DOCUMENT_POLICY_VERSION;
    readonly classification: DocumentClassification;
    readonly watermarkRequired: true;
    readonly storageRegion: typeof DOCUMENT_OBJECT_REGION;
    readonly createdAtMs: number;
  }): Promise<DocumentExportGrant>;
  /**
   * Atomically consume exactly one still-valid grant after revalidating the
   * session and regional health. It signs the exact private object only after
   * consuming the grant and writes download audit/outbox evidence.
   */
  consumeExportGrant(input: {
    readonly actor: DocumentPolicyActor;
    readonly command: ConsumeDocumentExportCommand;
    readonly consumedAtMs: number;
  }): Promise<DocumentExportDownload>;
}

export interface DocumentPolicyClock {
  nowMs(): number;
}

export interface DocumentPolicyServiceOptions {
  readonly repository: DocumentPolicyRepository;
  readonly clock?: DocumentPolicyClock;
}

/**
 * Boundary service for P2-07. It is intentionally incapable of object-store
 * calls and delegates all authoritative, mutable checks to its repository.
 */
export class DocumentPolicyService {
  private readonly repository: DocumentPolicyRepository;
  private readonly clock: DocumentPolicyClock;

  constructor(options: DocumentPolicyServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async mutateLegalHold(input: {
    readonly actor: DocumentPolicyActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: DocumentLegalHoldCommand;
  }): Promise<DocumentLegalHoldResult> {
    this.assertFounderCommand(input.actor, input.caseId, input.documentId, input.command);
    if (
      (input.command.action !== "place" && input.command.action !== "release") ||
      input.command.reason.trim().length === 0 ||
      input.command.reason.length > 500
    ) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_COMMAND_INVALID");
    }
    const result = await this.repository.mutateLegalHold({
      ...input,
      policyVersion: DOCUMENT_POLICY_VERSION,
      mutatedAtMs: this.now(),
    });
    this.assertReceipt(result.receipt);
    if (result.documentId !== input.documentId || result.legalHold !== (input.command.action === "place")) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_RECEIPT_INVALID");
    }
    return result;
  }

  async createExportGrant(input: {
    readonly actor: DocumentPolicyActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: CreateDocumentExportCommand;
    readonly policy: Omit<DocumentExportPolicyInput, "actor" | "nowMs" | "expiresAtMs">;
  }): Promise<DocumentExportGrant> {
    this.assertFounderCommand(input.actor, input.caseId, input.documentId, input.command);
    const nowMs = this.now();
    const decision = evaluateDocumentExportPolicy({
      ...input.policy,
      actor: input.actor,
      nowMs,
      expiresAtMs: input.command.expiresAtMs,
    });
    if (!decision.allowed) throw new DocumentPolicyError(decision.code);
    const result = await this.repository.createExportGrant({
      actor: input.actor,
      caseId: input.caseId,
      documentId: input.documentId,
      command: input.command,
      policyVersion: decision.value.policyVersion,
      classification: decision.value.classification,
      watermarkRequired: true,
      storageRegion: DOCUMENT_OBJECT_REGION,
      createdAtMs: nowMs,
    });
    this.assertReceipt(result.receipt);
    if (
      !validCommandId(result.exportId) ||
      result.documentId !== input.documentId ||
      result.remainingUses !== 1 ||
      result.watermarkRequired !== true ||
      result.storageRegion !== DOCUMENT_OBJECT_REGION ||
      result.expiresAtMs !== input.command.expiresAtMs
    ) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_RECEIPT_INVALID");
    }
    return result;
  }

  async consumeExportGrant(input: {
    readonly actor: DocumentPolicyActor;
    readonly command: ConsumeDocumentExportCommand;
  }): Promise<DocumentExportDownload> {
    if (!input.actor.isFounder || !validCommandId(input.command.exportId) || !REQUEST_ID.test(input.command.requestId)) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_COMMAND_INVALID");
    }
    const result = await this.repository.consumeExportGrant({
      actor: input.actor,
      command: input.command,
      consumedAtMs: this.now(),
    });
    this.assertReceipt(result.receipt);
    if (
      result.storageRegion !== DOCUMENT_OBJECT_REGION ||
      result.watermarkRequired !== true ||
      !isValidTimestamp(result.expiresAtMs) ||
      result.expiresAtMs <= this.now() ||
      !isPrivateHttpsUrl(result.location)
    ) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_RECEIPT_INVALID");
    }
    return result;
  }

  evaluateCleanupCandidate(input: DocumentCleanupPolicyInput): DocumentCleanupPolicyEvidence {
    const decision = evaluateDocumentCleanupPolicy(input);
    if (!decision.allowed) throw new DocumentPolicyError(decision.code);
    return decision.value;
  }

  private assertFounderCommand(
    actor: DocumentPolicyActor,
    caseId: string,
    documentId: string,
    command: {
      readonly expectedRecordVersion: number;
      readonly requestId: string;
      readonly idempotencyKey: string;
    },
  ): void {
    if (!actor.isFounder) throw new DocumentPolicyError("DOCUMENT_POLICY_FOUNDER_REQUIRED");
    if (!validMutationCommand({ ...actor, caseId, documentId, ...command })) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_COMMAND_INVALID");
    }
  }

  private assertReceipt(receipt: DocumentPolicyAuditReceipt): void {
    if (!validCommandId(receipt.auditEventId) || !validCommandId(receipt.outboxMessageId)) {
      throw new DocumentPolicyError("DOCUMENT_POLICY_RECEIPT_INVALID");
    }
  }

  private now(): number {
    const value = this.clock.nowMs();
    if (!isValidTimestamp(value)) throw new DocumentPolicyError("DOCUMENT_POLICY_COMMAND_INVALID");
    return value;
  }
}

function isPrivateHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}
