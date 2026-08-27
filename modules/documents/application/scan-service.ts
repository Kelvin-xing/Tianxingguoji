import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import {
  evaluateDocumentVersionTransition,
  isOpaqueDocumentObjectKey,
  type DocumentScanVerdict,
} from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,255}$/;
const PROVIDER_VERSION = /^\S{1,1024}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/;
export const MAX_DOCUMENT_SCAN_ATTEMPTS = 3;
export const DOCUMENT_SCANNER_ENGINES = Object.freeze([
  "clamav-release1",
  "deterministic-fake-release1",
] as const);
export type DocumentScannerEngine = (typeof DOCUMENT_SCANNER_ENGINES)[number];

export interface DocumentScanClock {
  nowMs(): number;
}

export interface DocumentScanEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly scanPolicyVersion: string;
  readonly deliveryAttempt: number;
}

export interface DocumentScanWork {
  readonly id: string;
  readonly organizationId: string;
  readonly documentVersionId: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly scanPolicyVersion: string;
  readonly attemptCount: number;
  readonly state: "running" | "clean" | "rejected" | "failed";
}

export type DocumentScanClaim =
  | { readonly status: "claimed"; readonly work: DocumentScanWork }
  | {
      readonly status: "duplicate";
      readonly workId: string;
      readonly terminalState: "running" | "clean" | "rejected" | "failed";
      readonly attemptCount: number;
    };

export interface DocumentScanVerdictResult {
  readonly status: "available" | "rejected";
  readonly workId: string;
  readonly documentVersionId: string;
}

export interface DocumentScanFailureResult {
  readonly status: "retry" | "dead_letter";
  readonly workId: string;
  readonly documentVersionId: string;
  readonly attemptCount: number;
}

export interface DocumentScanReconciliationCandidate {
  readonly kind: "missed_event" | "stuck_scan";
  readonly organizationId: string;
  readonly documentVersionId: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly scanPolicyVersion: string;
  readonly attemptCount: number;
  readonly observedUpdatedAtMs: number;
}

export interface DocumentScanReconciliationResult {
  readonly inspected: number;
  readonly requeued: number;
  readonly deadLettered: number;
  readonly ignored: number;
}

export interface DocumentScanRepository {
  /**
   * The production adapter locks the exact `(bucket, key, version_id,
   * scan_policy_version)` tuple, rechecks private HK object/document state,
   * and atomically creates or resumes one scan work row with the transition
   * to `scanning`, idempotency evidence, audit, and outbox facts.
   */
  claimScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly workId: string;
    readonly startedAtMs: number;
    readonly createEffects: (context: {
      readonly organizationId: string;
      readonly documentVersionId: string;
    }) => MutationEffectBundle;
  }): Promise<DocumentScanClaim>;
  /** Records only an explicit clean or malicious scanner result atomically. */
  completeScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly verdict: "clean" | "malicious";
    readonly scannerEngine?: DocumentScannerEngine;
    readonly completedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentScanVerdictResult>;
  /**
   * Atomically leaves the version `scan_failed`, increments the bounded
   * attempt receipt, and records retry or DLQ intent without scanner detail.
   */
  failScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly failedAtMs: number;
    readonly scannerEngine?: DocumentScannerEngine;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentScanFailureResult>;
  /** This read returns only opaque object/work identifiers and states. */
  findReconciliationCandidates(input: {
    readonly nowMs: number;
    readonly staleAfterMs: number;
    readonly limit: number;
  }): Promise<readonly DocumentScanReconciliationCandidate[]>;
  /**
   * Production implementations lock and recheck a candidate before atomically
   * recording a redacted outbox recovery request. A missed event remains
   * quarantined; a stuck scan becomes `scan_failed`, never `available`.
   */
  reconcileScanCandidate(input: {
    readonly candidate: DocumentScanReconciliationCandidate;
    readonly reconciledAtMs: number;
    readonly effects: MutationEffectBundle;
    readonly publishMissedEvent?: () => Promise<void>;
  }): Promise<"requeued" | "dead_letter" | "ignored">;
}

export interface DocumentScanRequeuePublisher {
  publish(candidate: DocumentScanReconciliationCandidate): Promise<void>;
}

export type DocumentScanErrorCode =
  | "DOCUMENT_SCAN_EVENT_INVALID"
  | "DOCUMENT_SCAN_RECONCILIATION_INVALID"
  | "DOCUMENT_SCAN_RESULT_INVALID"
  | "DOCUMENT_SCAN_TRANSITION_INVALID";

export class DocumentScanError extends Error {
  readonly code: DocumentScanErrorCode;

  constructor(code: DocumentScanErrorCode) {
    super(`Document scan rejected ${code}.`);
    this.name = "DocumentScanError";
    this.code = code;
  }
}

export interface DocumentScanServiceOptions {
  readonly repository: DocumentScanRepository;
  readonly requeuePublisher?: DocumentScanRequeuePublisher;
  readonly clock?: DocumentScanClock;
  readonly createId?: () => string;
}

/** Documents owns scan state policy; its repository owns each durable transaction. */
export class DocumentScanService {
  private readonly repository: DocumentScanRepository;
  private readonly requeuePublisher: DocumentScanRequeuePublisher | null;
  private readonly clock: DocumentScanClock;
  private readonly createId: () => string;

  constructor(options: DocumentScanServiceOptions) {
    this.repository = options.repository;
    this.requeuePublisher = options.requeuePublisher ?? null;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async claimScanWork(event: DocumentScanEvent): Promise<DocumentScanClaim> {
    assertEvent(event);
    const startedAtMs = this.now();
    const workId = this.id();
    return this.repository.claimScanWork({
      event,
      workId,
      startedAtMs,
      createEffects: ({ organizationId, documentVersionId }) =>
        this.effects({
          organizationId,
          documentVersionId,
          requestId: event.requestId,
          occurredAtMs: startedAtMs,
          eventType: "documents.scan_claimed",
          action: "update",
          status: "scanning",
          effectType: "document_scan_claimed",
        }),
    });
  }

  async completeScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly verdict: "clean" | "malicious";
    readonly scannerEngine?: DocumentScannerEngine;
  }): Promise<DocumentScanVerdictResult> {
    assertEvent(input.event);
    assertWorkMatchesEvent(input.work, input.event);
    const transition = evaluateDocumentVersionTransition({
      from: "scanning",
      to: input.verdict === "clean" ? "available" : "rejected",
      scanVerdict: input.verdict satisfies DocumentScanVerdict,
    });
    if (!transition.allowed) throw new DocumentScanError("DOCUMENT_SCAN_TRANSITION_INVALID");

    const completedAtMs = this.now();
    const scannerEngine = checkedScannerEngine(input.scannerEngine);
    const effects = this.effects({
      organizationId: input.work.organizationId,
      documentVersionId: input.work.documentVersionId,
      requestId: input.event.requestId,
      occurredAtMs: completedAtMs,
      eventType: input.verdict === "clean" ? "documents.scan_clean" : "documents.scan_rejected",
      action: "update",
      status: input.verdict === "clean" ? "available" : "rejected",
      effectType: input.verdict === "clean" ? "document_scan_clean" : "document_scan_rejected",
    });
    return this.repository.completeScanWork({
      event: input.event,
      work: input.work,
      verdict: input.verdict,
      scannerEngine,
      completedAtMs,
      effects,
    });
  }

  async failScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly scannerEngine?: DocumentScannerEngine;
  }): Promise<DocumentScanFailureResult> {
    assertEvent(input.event);
    assertWorkMatchesEvent(input.work, input.event);
    const transition = evaluateDocumentVersionTransition({
      from: "scanning",
      to: "scan_failed",
      scanVerdict: "failed",
    });
    if (!transition.allowed) throw new DocumentScanError("DOCUMENT_SCAN_TRANSITION_INVALID");

    const failedAtMs = this.now();
    const scannerEngine = checkedScannerEngine(input.scannerEngine);
    const isFinalAttempt = input.work.attemptCount === MAX_DOCUMENT_SCAN_ATTEMPTS ||
      input.event.deliveryAttempt === MAX_DOCUMENT_SCAN_ATTEMPTS;
    const effects = this.effects({
      organizationId: input.work.organizationId,
      documentVersionId: input.work.documentVersionId,
      requestId: input.event.requestId,
      occurredAtMs: failedAtMs,
      eventType: isFinalAttempt ? "documents.scan_dead_lettered" : "documents.scan_failed",
      action: "update",
      status: isFinalAttempt ? "dead_letter" : "scan_failed",
      effectType: isFinalAttempt ? "document_scan_dead_lettered" : "document_scan_failed",
    });
    const result = await this.repository.failScanWork({
      event: input.event,
      work: input.work,
      failedAtMs,
      scannerEngine,
      effects,
    });
    if (
      result.workId !== input.work.id ||
      result.documentVersionId !== input.work.documentVersionId ||
      result.attemptCount !== input.work.attemptCount ||
      (isFinalAttempt ? result.status !== "dead_letter" : result.status !== "retry")
    ) {
      throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
    }
    return result;
  }

  async reconcileDocumentScans(input: {
    readonly staleAfterMs: number;
    readonly limit: number;
  }): Promise<DocumentScanReconciliationResult> {
    if (
      !Number.isSafeInteger(input.staleAfterMs) ||
      input.staleAfterMs < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new DocumentScanError("DOCUMENT_SCAN_RECONCILIATION_INVALID");
    }
    const reconciledAtMs = this.now();
    const candidates = await this.repository.findReconciliationCandidates({
      nowMs: reconciledAtMs,
      staleAfterMs: input.staleAfterMs,
      limit: input.limit,
    });
    if (candidates.length > input.limit) {
      throw new DocumentScanError("DOCUMENT_SCAN_RECONCILIATION_INVALID");
    }

    let requeued = 0;
    let deadLettered = 0;
    let ignored = 0;
    for (const candidate of candidates) {
      assertCandidate(candidate);
      const effects = this.effects({
        organizationId: candidate.organizationId,
        documentVersionId: candidate.documentVersionId,
        requestId: `document-scan-reconcile-${candidate.documentVersionId}`,
        occurredAtMs: reconciledAtMs,
        eventType: "documents.scan_reconciled",
        action: "update",
        status: candidate.kind === "stuck_scan" ? "scan_failed" : "quarantined",
        effectType: "document_scan_reconciled",
      });
      const outcome = await this.repository.reconcileScanCandidate({
        candidate,
        reconciledAtMs,
        effects,
        publishMissedEvent: candidate.kind === "missed_event"
          ? async () => {
              if (!this.requeuePublisher) {
                throw new DocumentScanError("DOCUMENT_SCAN_RECONCILIATION_INVALID");
              }
              await this.requeuePublisher.publish(candidate);
            }
          : undefined,
      });
      if (outcome === "requeued") requeued += 1;
      else if (outcome === "dead_letter") deadLettered += 1;
      else ignored += 1;
    }
    return Object.freeze({
      inspected: candidates.length,
      requeued,
      deadLettered,
      ignored,
    });
  }

  private effects(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
    readonly requestId: string;
    readonly occurredAtMs: number;
    readonly eventType: string;
    readonly action: "update";
    readonly status: string;
    readonly effectType: string;
  }): MutationEffectBundle {
    const auditId = this.id();
    const outboxId = this.id();
    for (const id of [auditId, outboxId]) assertUuid(id);
    const organizationId = input.organizationId;
    const documentVersionId = input.documentVersionId;
    assertUuid(organizationId);
    assertUuid(documentVersionId);
    const occurredAt = new Date(input.occurredAtMs).toISOString();
    const audit = buildAuditEvent({
      id: auditId,
      organizationId,
      actorUserId: null,
      actorKind: "worker",
      eventType: input.eventType,
      eventVersion: 1,
      action: input.action,
      resourceType: "DocumentVersion",
      resourceId: documentVersionId,
      outcome: "succeeded",
      requestId: input.requestId,
      occurredAt,
      afterHashSha256: hashRequestPayload({ documentVersionId, status: input.status }),
      metadata: {
        effect_type: input.effectType,
        status: input.status,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId,
      aggregateType: "DocumentVersion",
      aggregateId: documentVersionId,
      eventType: input.eventType,
      eventVersion: 1,
      idempotencyKey: `document-scan-${outboxId}`,
      requestId: input.requestId,
      payload: {
        aggregate_id: documentVersionId,
        effect_type: input.effectType,
        request_id: input.requestId,
        status: input.status,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });
    return buildAtomicMutationEffects({ audit, outbox });
  }

  private now(): number {
    const nowMs = this.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new DocumentScanError("DOCUMENT_SCAN_EVENT_INVALID");
    }
    return nowMs;
  }

  private id(): string {
    const id = this.createId();
    assertUuid(id);
    return id;
  }
}

function checkedScannerEngine(value: DocumentScannerEngine | undefined): DocumentScannerEngine {
  const engine = value ?? "clamav-release1";
  if (!(DOCUMENT_SCANNER_ENGINES as readonly string[]).includes(engine)) {
    throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
  }
  return engine;
}

function assertEvent(event: DocumentScanEvent): void {
  if (
    !SAFE_ID.test(event.eventId) ||
    !SAFE_CODE.test(event.requestId) ||
    !SAFE_BUCKET.test(event.bucket) ||
    !isOpaqueDocumentObjectKey(event.key) ||
    !PROVIDER_VERSION.test(event.versionId) ||
    !SAFE_CODE.test(event.scanPolicyVersion) ||
    !Number.isSafeInteger(event.deliveryAttempt) ||
    event.deliveryAttempt < 1 ||
    event.deliveryAttempt > MAX_DOCUMENT_SCAN_ATTEMPTS
  ) {
    throw new DocumentScanError("DOCUMENT_SCAN_EVENT_INVALID");
  }
}

function assertWorkMatchesEvent(work: DocumentScanWork, event: DocumentScanEvent): void {
  if (
    !UUID.test(work.id) ||
    !UUID.test(work.organizationId) ||
    !UUID.test(work.documentVersionId) ||
    work.bucket !== event.bucket ||
    work.key !== event.key ||
    work.versionId !== event.versionId ||
    work.scanPolicyVersion !== event.scanPolicyVersion ||
    !Number.isSafeInteger(work.attemptCount) ||
    work.attemptCount < 1 ||
    work.attemptCount > MAX_DOCUMENT_SCAN_ATTEMPTS ||
    work.state !== "running"
  ) {
    throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
  }
}

function assertCandidate(candidate: DocumentScanReconciliationCandidate): void {
  if (
    (candidate.kind !== "missed_event" && candidate.kind !== "stuck_scan") ||
    !UUID.test(candidate.organizationId) ||
    !UUID.test(candidate.documentVersionId) ||
    !SAFE_BUCKET.test(candidate.bucket) ||
    !isOpaqueDocumentObjectKey(candidate.key) ||
    !PROVIDER_VERSION.test(candidate.versionId) ||
    !SAFE_CODE.test(candidate.scanPolicyVersion) ||
    !Number.isSafeInteger(candidate.attemptCount) ||
    candidate.attemptCount < 0 ||
    candidate.attemptCount > MAX_DOCUMENT_SCAN_ATTEMPTS ||
    !Number.isSafeInteger(candidate.observedUpdatedAtMs) ||
    candidate.observedUpdatedAtMs <= 0
  ) {
    throw new DocumentScanError("DOCUMENT_SCAN_RECONCILIATION_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new DocumentScanError("DOCUMENT_SCAN_EVENT_INVALID");
}
