import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, hasRequestCapability, type OrganizationRole } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import type { DocumentVersionState } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const CASE_DOCUMENT_CLASSIFICATIONS = Object.freeze([
  "identity_and_case_evidence",
  "operational_attachment",
] as const);

export type CaseDocumentClassification = (typeof CASE_DOCUMENT_CLASSIFICATIONS)[number];
export type VisibleDocumentLifecycleState = "active" | "pending_delete";

export interface PendingDocumentUploadView {
  readonly id: string;
  readonly recordVersion: number;
}

export interface CaseDocumentView {
  readonly id: string;
  readonly caseId: string;
  readonly caseNumber: string;
  readonly displayName: string;
  readonly classification: CaseDocumentClassification;
  readonly lifecycleState: VisibleDocumentLifecycleState;
  readonly latestVersionState: DocumentVersionState | null;
  readonly pendingUpload: PendingDocumentUploadView | null;
  readonly hasActiveVersion: boolean;
  readonly recordVersion: number;
  readonly updatedAt: string;
}

export interface DocumentCollectionView {
  readonly documents: readonly CaseDocumentView[];
}

export interface DocumentAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
}

export interface DocumentActorContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: OrganizationRole;
}

export interface DocumentWorkspaceRepository {
  list(input: DocumentActorContext & { readonly caseId: string | null }): Promise<DocumentCollectionView | null>;
  detail(input: DocumentActorContext & {
    readonly caseId: string;
    readonly documentId: string;
  }): Promise<CaseDocumentView | null>;
  register(input: DocumentActorContext & {
    readonly documentId: string;
    readonly caseId: string;
    readonly displayName: string;
    readonly classification: CaseDocumentClassification;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentAcknowledgement>;
}

export type DocumentWorkspaceErrorCode =
  | "DOCUMENT_WORKSPACE_FORBIDDEN"
  | "DOCUMENT_WORKSPACE_INVALID"
  | "DOCUMENT_WORKSPACE_NOT_FOUND"
  | "DOCUMENT_WORKSPACE_CONFLICT"
  | "DOCUMENT_WORKSPACE_UNAVAILABLE";

const ERROR_CODES = new Set<DocumentWorkspaceErrorCode>([
  "DOCUMENT_WORKSPACE_FORBIDDEN",
  "DOCUMENT_WORKSPACE_INVALID",
  "DOCUMENT_WORKSPACE_NOT_FOUND",
  "DOCUMENT_WORKSPACE_CONFLICT",
  "DOCUMENT_WORKSPACE_UNAVAILABLE",
]);

export class DocumentWorkspaceError extends Error {
  readonly code: DocumentWorkspaceErrorCode;

  constructor(code: DocumentWorkspaceErrorCode) {
    super(`Document workspace rejected ${code}.`);
    this.name = "DocumentWorkspaceError";
    this.code = code;
  }
}

export function isDocumentWorkspaceError(
  value: unknown,
  code?: DocumentWorkspaceErrorCode,
): value is DocumentWorkspaceError {
  if (!(value instanceof Error) || value.name !== "DocumentWorkspaceError") return false;
  const candidate = (value as Error & { code?: unknown }).code;
  return typeof candidate === "string" &&
    ERROR_CODES.has(candidate as DocumentWorkspaceErrorCode) &&
    (code === undefined || candidate === code);
}

export class DocumentWorkspaceService {
  private readonly repository: DocumentWorkspaceRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    repository: DocumentWorkspaceRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  list(actor: IdentitySessionActor): Promise<DocumentCollectionView> {
    const context = authorize(actor, "documents.read");
    return this.repository.list({ ...context, caseId: null }).then((result) => {
      if (!result) unavailable();
      return result;
    });
  }

  listCase(actor: IdentitySessionActor, caseId: string): Promise<DocumentCollectionView | null> {
    const context = authorize(actor, "documents.read");
    if (!UUID.test(caseId)) invalid();
    return this.repository.list({ ...context, caseId });
  }

  detail(
    actor: IdentitySessionActor,
    caseId: string,
    documentId: string,
  ): Promise<CaseDocumentView | null> {
    const context = authorize(actor, "documents.read");
    if (!UUID.test(caseId) || !UUID.test(documentId)) invalid();
    return this.repository.detail({ ...context, caseId, documentId });
  }

  register(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: {
      readonly displayName: string;
      readonly classification: string;
      readonly requestId: string;
      readonly idempotencyKey: string;
    };
  }): Promise<DocumentAcknowledgement> {
    const context = authorize(input.actor, "documents.create");
    const command = input.command;
    if (!UUID.test(input.caseId) ||
        command.displayName !== command.displayName.trim() ||
        command.displayName.length < 1 || command.displayName.length > 200 ||
        !isCaseDocumentClassification(command.classification) ||
        !REQUEST_ID.test(command.requestId)) {
      invalid();
    }
    try {
      validateIdempotencyKey(command.idempotencyKey);
    } catch {
      invalid();
    }

    const documentId = checkedId(this.createId);
    const occurredAt = checkedNow(this.now);
    const effects = mutationEffects({
      actor: input.actor,
      documentId,
      requestId: command.requestId,
      occurredAt,
      createId: this.createId,
    });
    return this.repository.register({
      ...context,
      documentId,
      caseId: input.caseId,
      displayName: command.displayName,
      classification: command.classification,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        classification: command.classification,
        display_name: command.displayName,
      }),
      effects,
    });
  }
}

export function isCaseDocumentClassification(value: unknown): value is CaseDocumentClassification {
  return typeof value === "string" &&
    (CASE_DOCUMENT_CLASSIFICATIONS as readonly string[]).includes(value);
}

function authorize(
  actor: IdentitySessionActor,
  capability: "documents.read" | "documents.create",
): DocumentActorContext {
  const allowed = actor.workspaceCapabilities !== undefined
    ? hasRequestCapability(actor, capability)
    : evaluateBootstrapAuthorization(actor.role, { capability }).allowed;
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !allowed) {
    forbidden();
  }
  return Object.freeze({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
}

function mutationEffects(input: {
  readonly actor: IdentitySessionActor;
  readonly documentId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly createId: () => string;
}): MutationEffectBundle {
  const auditId = checkedId(input.createId);
  const audit = buildAuditEvent({
    id: auditId,
    organizationId: input.actor.organizationId,
    actorUserId: input.actor.userId,
    actorKind: "user",
    eventType: "documents.document_registered",
    eventVersion: 1,
    action: "register",
    resourceType: "Document",
    resourceId: input.documentId,
    outcome: "succeeded",
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata: { effect_type: "documents.register", record_version: 1, status: "active" },
  });
  const outbox = buildOutboxMessage({
    id: checkedId(input.createId),
    auditEventId: auditId,
    organizationId: input.actor.organizationId,
    aggregateType: "Document",
    aggregateId: input.documentId,
    eventType: "documents.document_registered",
    eventVersion: 1,
    idempotencyKey: `document-${auditId}`,
    requestId: input.requestId,
    payload: {
      aggregate_id: input.documentId,
      effect_type: "documents.register",
      record_version: 1,
      request_id: input.requestId,
      status: "active",
    },
    availableAt: input.occurredAt,
    createdAt: input.occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}

function checkedId(createId: () => string): string {
  const value = createId();
  if (!UUID.test(value)) invalid();
  return value;
}

function checkedNow(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value) || value <= 0) invalid();
  return new Date(value).toISOString();
}

function invalid(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");
}

function forbidden(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_FORBIDDEN");
}

function unavailable(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_UNAVAILABLE");
}
