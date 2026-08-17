import {
  DOCUMENT_OBJECT_REGION,
  DocumentContractError,
  evaluateDocumentVersionDownload,
  validateDocumentObjectReference,
  type DocumentDecision,
  type DocumentObjectReference,
  type DocumentRecord,
  type DocumentVersionRecord,
  type DocumentObjectRegion,
} from "../domain/contract.ts";

export type ObjectStoreOperation = "upload" | "download";

export interface ObjectStoreIntentRequest {
  readonly region: DocumentObjectRegion;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string | null;
  readonly expiresAt: string;
}

export interface ObjectStoreIntent extends ObjectStoreIntentRequest {
  readonly operation: ObjectStoreOperation;
  readonly url: string;
}

export interface ObjectStoreSigner {
  issueUploadIntent(input: ObjectStoreIntentRequest): Promise<ObjectStoreIntent>;
  issueDownloadIntent(input: ObjectStoreIntentRequest): Promise<ObjectStoreIntent>;
}

export interface ObjectStoreAdapterConfig {
  readonly region: DocumentObjectRegion;
  readonly bucket: string;
}

function decisionError(decision: DocumentDecision): never {
  if (decision.allowed) throw new Error("document decision is unexpectedly allowed");
  throw new DocumentContractError(decision.code);
}

function assertFutureExpiry(now: string, expiresAt: string): void {
  const nowMs = Date.parse(now);
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs) || expiryMs <= nowMs) {
    throw new DocumentContractError("DOCUMENT_INTENT_EXPIRED");
  }
}

function assertReferenceMatches(
  reference: DocumentObjectReference,
  version: DocumentVersionRecord,
  config: ObjectStoreAdapterConfig,
): void {
  const referenceDecision = validateDocumentObjectReference(version, config.bucket);
  if (!referenceDecision.allowed) decisionError(referenceDecision);
  if (reference.region !== config.region || reference.region !== DOCUMENT_OBJECT_REGION) {
    throw new DocumentContractError("DOCUMENT_REGION_INVALID");
  }
  if (reference.bucket !== config.bucket || reference.bucket.trim() === "") {
    throw new DocumentContractError("DOCUMENT_OBJECT_BUCKET_INVALID");
  }
  if (reference.key !== version.object.key || reference.versionId !== version.object.versionId) {
    throw new DocumentContractError("DOCUMENT_OBJECT_KEY_INVALID");
  }
}

function assertSignedIntent(
  intent: ObjectStoreIntent,
  expected: ObjectStoreIntentRequest,
  operation: ObjectStoreOperation,
): ObjectStoreIntent {
  if (
    intent.operation !== operation ||
    intent.region !== expected.region ||
    intent.bucket !== expected.bucket ||
    intent.key !== expected.key ||
    intent.versionId !== expected.versionId ||
    intent.expiresAt !== expected.expiresAt
  ) {
    throw new DocumentContractError("DOCUMENT_INTENT_MISMATCH");
  }
  let url: URL;
  try {
    url = new URL(intent.url);
  } catch {
    throw new DocumentContractError("DOCUMENT_INTENT_MISMATCH");
  }
  if (url.protocol !== "https:") {
    throw new DocumentContractError("DOCUMENT_INTENT_MISMATCH");
  }
  return intent;
}

export class DocumentObjectStoreAdapter {
  private readonly signer: ObjectStoreSigner;
  private readonly config: ObjectStoreAdapterConfig;

  constructor(signer: ObjectStoreSigner, config: ObjectStoreAdapterConfig) {
    if (config.region !== DOCUMENT_OBJECT_REGION) {
      throw new DocumentContractError("DOCUMENT_REGION_INVALID");
    }
    if (config.bucket.trim() === "") {
      throw new DocumentContractError("DOCUMENT_OBJECT_BUCKET_INVALID");
    }
    this.signer = signer;
    this.config = config;
  }

  async createUploadIntent(input: {
    readonly version: DocumentVersionRecord;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<ObjectStoreIntent> {
    if (input.version.state !== "pending_upload") {
      throw new DocumentContractError("DOCUMENT_UPLOAD_VERSION_STATE_INVALID");
    }
    assertFutureExpiry(input.now, input.expiresAt);
    assertReferenceMatches(input.version.object, input.version, this.config);
    const request: ObjectStoreIntentRequest = {
      ...input.version.object,
      expiresAt: input.expiresAt,
    };
    const intent = await this.signer.issueUploadIntent(request);
    return assertSignedIntent(intent, request, "upload");
  }

  async createDownloadIntent(input: {
    readonly document: DocumentRecord;
    readonly version: DocumentVersionRecord;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<ObjectStoreIntent> {
    const decision = evaluateDocumentVersionDownload({
      document: input.document,
      version: input.version,
    });
    if (!decision.allowed) decisionError(decision);
    assertFutureExpiry(input.now, input.expiresAt);
    assertReferenceMatches(input.version.object, input.version, this.config);
    const request: ObjectStoreIntentRequest = {
      ...input.version.object,
      expiresAt: input.expiresAt,
    };
    const intent = await this.signer.issueDownloadIntent(request);
    return assertSignedIntent(intent, request, "download");
  }
}
