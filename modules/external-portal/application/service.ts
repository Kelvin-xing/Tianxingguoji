import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
} from "../../audit/public.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import {
  PORTAL_GRANT_MAX_TTL_MS,
  PORTAL_SESSION_ABSOLUTE_TTL_MS,
  PORTAL_SESSION_IDLE_TTL_MS,
  PORTAL_CAPABILITY_SET_VERSION,
  PortalPolicyError,
  type PortalCaseReadV1,
} from "../domain/contract.ts";
import { buildPortalCaseReadV1 } from "../domain/policy.ts";
import type {
  PortalAccessGrant,
  PortalRepository,
  PortalSessionRecord,
} from "./repository-port.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCESS_KEY_PARTS = 5;
const SESSION_KEY_PARTS = 5;

export interface PortalClock { nowMs(): number; }

export interface PortalInternalCommandActor {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly workspaceCapabilities: readonly string[];
  readonly roles: readonly string[];
}

export interface PortalServiceOptions {
  readonly repository: PortalRepository;
  readonly secretPepper: string;
  readonly clock?: PortalClock;
  readonly createId?: () => string;
}

export interface PortalGrantCommandInput {
  readonly actor: PortalInternalCommandActor;
  readonly serviceCaseId: string;
  readonly portalViewerId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface PortalGrantResult {
  readonly grantId: string;
  readonly rawSecretOnce: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
  readonly status: "active";
  readonly recordVersion: number;
}

export class PortalService {
  private readonly repository: PortalRepository;
  private readonly pepper: Buffer;
  private readonly clock: PortalClock;
  private readonly createId: () => string;

  constructor(options: PortalServiceOptions) {
    if (options.secretPepper.trim().length < 32) throw new PortalPolicyError("PORTAL_RUNTIME_UNAVAILABLE");
    this.repository = options.repository;
    this.pepper = Buffer.from(options.secretPepper, "utf8");
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async issueGrant(input: PortalGrantCommandInput): Promise<PortalGrantResult> {
    assertInternalInput(input);
    assertGrantCommandActor(input.actor, "issue");
    const nowMs = this.clock.nowMs();
    const grantId = this.createId();
    const secret = randomBytes(32).toString("base64url");
    const keyedSecretHash = this.keyedDigest(`grant:${grantId}:${secret}`);
    const fingerprint = createHash("sha256").update(keyedSecretHash).digest("hex");
    const effects = this.effects({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.actorUserId,
      aggregateId: grantId,
      operation: "issue",
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      occurredAtMs: nowMs,
    });
    const grant = await this.repository.issueGrant({
      organizationId: input.actor.organizationId,
      serviceCaseId: input.serviceCaseId,
      actorUserId: input.actor.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hashRequestPayload({
        operation: "issue",
        service_case_id: input.serviceCaseId,
        portal_viewer_id: input.portalViewerId,
      }),
      effects,
      grantId,
      lifecycleId: grantId,
      portalViewerId: input.portalViewerId,
      issuedByUserId: input.actor.actorUserId,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + PORTAL_GRANT_MAX_TTL_MS,
      capabilitySetVersion: PORTAL_CAPABILITY_SET_VERSION,
      keyedSecretHash,
      secretFingerprint: fingerprint,
    });
    return toGrantResult(grant, this.accessKey(input.actor.organizationId, input.serviceCaseId, grant.id, secret), fingerprint);
  }

  async revokeGrant(input: PortalGrantCommandInput & {
    readonly grantId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: string;
  }): Promise<{ readonly grantId: string; readonly status: "revoked"; readonly recordVersion: number }> {
    assertInternalInput(input);
    assertGrantCommandActor(input.actor, "revoke");
    if (!UUID.test(input.grantId) || !Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 1) {
      throw new PortalPolicyError("PORTAL_INPUT_INVALID");
    }
    const nowMs = this.clock.nowMs();
    const effects = this.effects({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.actorUserId,
      aggregateId: input.grantId,
      operation: "revoke",
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      occurredAtMs: nowMs,
    });
    const result = await this.repository.revokeGrant({
      organizationId: input.actor.organizationId,
      serviceCaseId: input.serviceCaseId,
      actorUserId: input.actor.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hashRequestPayload({ operation: "revoke", grant_id: input.grantId, reason: input.reasonCode }),
      effects,
      grantId: input.grantId,
      expectedRecordVersion: input.expectedRecordVersion,
      revokedAtMs: nowMs,
      reasonCode: input.reasonCode,
    });
    return { grantId: result.id, status: "revoked", recordVersion: result.recordVersion };
  }

  async reissueGrant(input: PortalGrantCommandInput & {
    readonly grantId: string;
    readonly expectedRecordVersion: number;
  }): Promise<PortalGrantResult> {
    assertInternalInput(input);
    assertGrantCommandActor(input.actor, "reissue");
    if (!UUID.test(input.grantId) || !Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 1) {
      throw new PortalPolicyError("PORTAL_INPUT_INVALID");
    }
    const nowMs = this.clock.nowMs();
    const newGrantId = this.createId();
    const secret = randomBytes(32).toString("base64url");
    const keyedSecretHash = this.keyedDigest(`grant:${newGrantId}:${secret}`);
    const fingerprint = createHash("sha256").update(keyedSecretHash).digest("hex");
    const effects = this.effects({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.actorUserId,
      aggregateId: newGrantId,
      operation: "reissue",
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      occurredAtMs: nowMs,
    });
    const grant = await this.repository.rotateGrant({
      organizationId: input.actor.organizationId,
      serviceCaseId: input.serviceCaseId,
      actorUserId: input.actor.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hashRequestPayload({ operation: "reissue", grant_id: input.grantId }),
      effects,
      oldGrantId: input.grantId,
      newGrantId,
      lifecycleId: newGrantId,
      portalViewerId: input.portalViewerId,
      expectedRecordVersion: input.expectedRecordVersion,
      rotatedAtMs: nowMs,
      expiresAtMs: nowMs + PORTAL_GRANT_MAX_TTL_MS,
      capabilitySetVersion: PORTAL_CAPABILITY_SET_VERSION,
      keyedSecretHash,
      secretFingerprint: fingerprint,
    });
    return toGrantResult(grant, this.accessKey(input.actor.organizationId, input.serviceCaseId, grant.id, secret), fingerprint);
  }

  async listGrants(input: Readonly<{ actor: PortalInternalCommandActor; serviceCaseId: string }>) {
    if (!this.repository.listGrants) throw new PortalPolicyError("PORTAL_RUNTIME_UNAVAILABLE");
    if (!UUID.test(input.serviceCaseId)) throw new PortalPolicyError("PORTAL_INPUT_INVALID");
    return this.repository.listGrants({
      organizationId: input.actor.organizationId,
      serviceCaseId: input.serviceCaseId,
      actorUserId: input.actor.actorUserId,
    });
  }

  async redeem(input: Readonly<{ accessKey: string; idempotencyKey: string; requestId: string }>): Promise<Readonly<{ sessionSecret: string; absoluteExpiresAt: string }>> {
    if (!this.repository.redeemAccess || !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new PortalPolicyError("PORTAL_RUNTIME_UNAVAILABLE");
    const parsed = parseBearerKey(input.accessKey, ACCESS_KEY_PARTS, "access");
    // Derive both values from the idempotent request so a replay returns a
    // cookie that still matches the already persisted session digest.
    const sessionSecret = createHmac("sha256", this.pepper)
      .update(`session-secret:${input.accessKey}:${input.idempotencyKey}`)
      .digest("base64url");
    const sessionId = deterministicUuid(this.keyedDigest(`session-id:${input.accessKey}:${input.idempotencyKey}`));
    const session = await this.repository.redeemAccess({
      accessKey: input.accessKey,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      nowMs: this.clock.nowMs(),
      sessionId,
      keyedSessionHash: this.keyedDigest(`session:${parsed.grantId}:${sessionSecret}`),
      sessionSecret,
    });
    return { sessionSecret: this.sessionKey(parsed.organizationId, parsed.caseId, session.id, sessionSecret), absoluteExpiresAt: new Date(session.absoluteExpiresAtMs).toISOString() };
  }

  async readWorkspace(input: Readonly<{ sessionSecret: string; requestId: string }>): Promise<PortalCaseReadV1> {
    if (!this.repository.readSession) throw new PortalPolicyError("PORTAL_RUNTIME_UNAVAILABLE");
    const parsed = parseBearerKey(input.sessionSecret, SESSION_KEY_PARTS, "session");
    const value = await this.repository.readSession({ sessionSecret: input.sessionSecret, requestId: input.requestId, nowMs: this.clock.nowMs() });
    if (value.session.id !== parsed.sessionId) throw new PortalPolicyError("PORTAL_SESSION_INVALID");
    return buildPortalCaseReadV1(value.workspace);
  }

  async revokeSession(input: Readonly<{ sessionSecret: string; requestId: string }>): Promise<void> {
    if (!this.repository.revokeSessionBySecret) throw new PortalPolicyError("PORTAL_RUNTIME_UNAVAILABLE");
    parseBearerKey(input.sessionSecret, SESSION_KEY_PARTS, "session");
    await this.repository.revokeSessionBySecret({ sessionSecret: input.sessionSecret, requestId: input.requestId, nowMs: this.clock.nowMs() });
  }

  private keyedDigest(value: string): string {
    return createHmac("sha256", this.pepper).update(value).digest("hex");
  }

  private accessKey(organizationId: string, caseId: string, grantId: string, secret: string): string {
    return `p1.${organizationId}.${caseId}.${grantId}.${secret}`;
  }

  private sessionKey(organizationId: string, caseId: string, sessionId: string, secret: string): string {
    return `p1.${organizationId}.${caseId}.${sessionId}.${secret}`;
  }

  private effects(input: Readonly<{
    organizationId: string; actorUserId: string; aggregateId: string; operation: string;
    idempotencyKey: string; requestId: string; occurredAtMs: number;
  }>) {
    const occurredAt = new Date(input.occurredAtMs).toISOString();
    const audit = buildAuditEvent({
      id: this.createId(), organizationId: input.organizationId, actorUserId: input.actorUserId,
      actorKind: "user", eventType: `portal.grant.${input.operation}`, eventVersion: 1,
      action: input.operation, resourceType: "portal_access_grant", resourceId: input.aggregateId,
      outcome: "succeeded", requestId: input.requestId, occurredAt,
      metadata: { effect_type: input.operation, request_id: input.requestId },
    });
    const outbox = buildOutboxMessage({
      id: this.createId(), auditEventId: audit.id, organizationId: input.organizationId,
      aggregateType: "portal_access_grant", aggregateId: input.aggregateId,
      eventType: audit.eventType, eventVersion: 1, idempotencyKey: input.idempotencyKey,
      requestId: input.requestId, payload: { aggregate_id: input.aggregateId, request_id: input.requestId, effect_type: input.operation, operation: input.operation },
      availableAt: occurredAt, createdAt: occurredAt,
    });
    return buildAtomicMutationEffects({ audit, outbox });
  }
}

function assertInternalInput(input: PortalGrantCommandInput): void {
  if (!input || !input.actor || !UUID.test(input.serviceCaseId) || !UUID.test(input.portalViewerId) ||
      !UUID.test(input.actor.actorUserId) || !UUID.test(input.actor.organizationId) ||
      !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey) || input.requestId.length < 1) {
    throw new PortalPolicyError("PORTAL_INPUT_INVALID");
  }
}

function assertGrantCommandActor(actor: PortalInternalCommandActor, operation: "issue" | "reissue" | "revoke"): void {
  if (!actor.workspaceCapabilities.includes("cases.workflow.manage")) throw new PortalPolicyError("PORTAL_ISSUER_UNAUTHORIZED");
  const isAdvisor = actor.roles.some((role) => role === "advisor");
  const isFounder = actor.roles.some((role) => role === "founder");
  if ((operation === "issue" || operation === "reissue") && !isAdvisor) throw new PortalPolicyError("PORTAL_ISSUER_UNAUTHORIZED");
  if (operation === "revoke" && !isAdvisor && !isFounder) throw new PortalPolicyError("PORTAL_ISSUER_UNAUTHORIZED");
}

function parseBearerKey(value: string, parts: number, kind: "access" | "session") {
  const segments = value.split(".");
  if (segments.length !== parts || segments[0] !== "p1" || !UUID.test(segments[1]) || !UUID.test(segments[2]) || !UUID.test(segments[3]) || !/^[A-Za-z0-9_-]{32,128}$/.test(segments[4])) {
    throw new PortalPolicyError(kind === "access" ? "PORTAL_SECRET_INVALID" : "PORTAL_SESSION_INVALID");
  }
  return { organizationId: segments[1], caseId: segments[2], grantId: segments[3], sessionId: segments[3], secret: segments[4] };
}

function toGrantResult(grant: PortalAccessGrant, _accessKey: string, fingerprint: string): PortalGrantResult {
  return {
    grantId: grant.id,
    rawSecretOnce: _accessKey,
    fingerprint,
    expiresAt: new Date(grant.expiresAtMs).toISOString(),
    status: "active",
    recordVersion: grant.recordVersion,
  };
}

function deterministicUuid(hex: string): string {
  const bytes = Buffer.from(hex, "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
