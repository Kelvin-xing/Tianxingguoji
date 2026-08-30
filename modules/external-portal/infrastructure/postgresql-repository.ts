import "server-only";

import { createHash, createHmac } from "node:crypto";

import { appendAtomicMutationEffects, type AtomicMutationTransaction } from "../../audit/server.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
} from "../../audit/public.ts";
import {
  runIdempotentTransaction,
  type IdempotentTransactionResult,
} from "../../shared/server.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import type { AccessPortalReadPort } from "../../access/server.ts";
import type { CasesPortalReadPort } from "../../cases/server.ts";
import type { CrmPortalReadPort } from "../../crm/server.ts";
import type { SchoolsPortalReadPort } from "../../schools/server.ts";
import type { PortalWorkspaceSource } from "../domain/contract.ts";
import type {
  PortalAccessGrant,
  PortalGrantMutationContext,
  PortalGrantSecretInput,
  PortalRepository,
  PortalRepositoryErrorCode,
  PortalSessionRecord,
  PortalViewerRecord,
} from "../application/repository-port.ts";
import { PortalRepositoryError } from "../application/repository-port.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Queryable = TenantTransaction;
function asAtomicTransaction(transaction: TenantTransaction): AtomicMutationTransaction {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await transaction.query<Row>({ text, values });
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

export interface PostgreSqlPortalRepositoryOptions {
  readonly runner: TenantTransactionRunner;
  readonly secretPepper: string;
  readonly accessReadPort?: AccessPortalReadPort;
  readonly casesReadPort?: CasesPortalReadPort;
  readonly crmReadPort?: CrmPortalReadPort;
  readonly schoolsReadPort?: SchoolsPortalReadPort;
}

export class PostgreSqlPortalRepository implements PortalRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly pepper: Buffer;
  private readonly accessReadPort: AccessPortalReadPort;
  private readonly casesReadPort: CasesPortalReadPort;
  private readonly crmReadPort: CrmPortalReadPort;
  private readonly schoolsReadPort: SchoolsPortalReadPort;

  constructor(options: PostgreSqlPortalRepositoryOptions) {
    if (options.secretPepper.trim().length < 32) throw new PortalRepositoryError("PORTAL_SECRET_CONFLICT");
    this.runner = options.runner;
    this.pepper = Buffer.from(options.secretPepper, "utf8");
    if (!options.accessReadPort || !options.casesReadPort || !options.crmReadPort || !options.schoolsReadPort) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    this.accessReadPort = options.accessReadPort;
    this.casesReadPort = options.casesReadPort;
    this.crmReadPort = options.crmReadPort;
    this.schoolsReadPort = options.schoolsReadPort;
  }

  async ensureViewer(input: Parameters<NonNullable<PortalRepository["ensureViewer"]>>[0]): Promise<PortalViewerRecord> {
    const result = await runIdempotentTransaction<PortalViewerRecord>({
      runner: this.runner,
      context: userContext(input),
      claim: claim(input, "portal.viewer.ensure"),
      revalidate: async (tx) => {
        await tx.query({
          text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          values: [`portal-viewer:${input.organizationId}:${input.serviceCaseId}`],
        });
        const [actor, caseFacts] = await Promise.all([
          this.accessReadPort.readActorFacts(tx, {
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
          }),
          this.casesReadPort.readCaseFacts(tx, {
            organizationId: input.organizationId,
            serviceCaseId: input.serviceCaseId,
          }),
        ]);
        const relationship = caseFacts ? await this.crmReadPort.readGuardianRelationship(tx, {
          organizationId: input.organizationId,
          relationshipId: input.guardianRelationshipId,
          studentId: caseFacts.studentId,
        }) : null;
        if (!actor || !caseFacts || !relationship?.active ||
            actor.organizationStatus !== "active" || actor.userStatus !== "active" ||
            actor.membershipStatus !== "active" || !isPortalCaseAvailable(caseFacts.workflowStatus) ||
            caseFacts.primaryUserId !== input.actorUserId) {
          throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
        }
      },
      execute: async (tx) => {
        const existing = await tx.query<ViewerRow>({
          text: `SELECT * FROM portal_viewers
            WHERE organization_id=$1 AND service_case_id=$2
              AND guardian_relationship_id=$3 AND status='active'
            ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
          values: [input.organizationId, input.serviceCaseId, input.guardianRelationshipId],
        });
        if (existing.rows[0]) {
          const viewer = mapViewer(existing.rows[0]);
          return terminal(viewer, viewer.id, input.effects.outbox.eventType);
        }
        const inserted = await tx.query<ViewerRow>({
          text: `INSERT INTO portal_viewers
            (id,organization_id,service_case_id,subject_type,guardian_relationship_id,
             applicant_student_id,status,record_version,created_at,updated_at)
            VALUES ($1,$2,$3,'guardian',$4,NULL,'active',1,
              to_timestamp($5/1000.0),to_timestamp($5/1000.0))
            RETURNING *`,
          values: [input.viewerId, input.organizationId, input.serviceCaseId,
            input.guardianRelationshipId, input.createdAtMs],
        });
        const viewer = mapViewer(inserted.rows[0]);
        await appendAtomicMutationEffects(asAtomicTransaction(tx), input.effects);
        return terminal(viewer, viewer.id, input.effects.outbox.eventType);
      },
    });
    if (result.status === "executed") return result.value;
    return this.findViewer(input.organizationId, input.serviceCaseId, result.resultReference);
  }

  async issueGrant(input: Parameters<PortalRepository["issueGrant"]>[0]): Promise<PortalAccessGrant> {
    const result = await runIdempotentTransaction<PortalAccessGrant>({
      runner: this.runner,
      context: userContext(input),
      claim: claim(input, "portal.grant.issue"),
      revalidate: (tx) => this.assertInternalAuthorization(tx, input.organizationId, input.serviceCaseId, input.actorUserId, input.portalViewerId, "issue"),
      execute: async (tx) => {
        const row = await tx.query<GrantRow>({
          text: `INSERT INTO portal_access_grants
            (id,lifecycle_id,organization_id,service_case_id,portal_viewer_id,keyed_secret_hash,
             secret_fingerprint,capability_set_version,status,issued_by_user_id,issued_at,expires_at,
             record_version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),$7,$8,'active',$9,to_timestamp($10/1000.0),to_timestamp($11/1000.0),1,to_timestamp($10/1000.0),to_timestamp($10/1000.0))
           RETURNING *`,
          values: [input.grantId, input.lifecycleId, input.organizationId, input.serviceCaseId,
            input.portalViewerId, input.keyedSecretHash, input.secretFingerprint, input.capabilitySetVersion,
            input.issuedByUserId, input.issuedAtMs, input.expiresAtMs],
        });
        const grant = mapGrant(row.rows[0]);
        await appendAtomicMutationEffects(asAtomicTransaction(tx), input.effects);
        return terminal(grant, grant.id, input.effects.outbox.eventType);
      },
    });
    return this.resolveExecutedOrReplay(result, input.organizationId, input.serviceCaseId, "portal.grant.issue");
  }

  async revokeGrant(input: Parameters<PortalRepository["revokeGrant"]>[0]): Promise<PortalAccessGrant> {
    const result = await runIdempotentTransaction<PortalAccessGrant>({
      runner: this.runner,
      context: userContext(input),
      claim: claim(input, "portal.grant.revoke"),
      revalidate: (tx) => this.assertInternalAuthorization(tx, input.organizationId, input.serviceCaseId, input.actorUserId, null, "revoke"),
      execute: async (tx) => {
        const row = await tx.query<GrantRow>({
          text: `UPDATE portal_access_grants
                    SET status='revoked', revoked_by_user_id=$4, revoked_at=to_timestamp($5/1000.0),
                        revoke_reason_code=$6, keyed_secret_hash=NULL, record_version=record_version+1,
                        updated_at=to_timestamp($5/1000.0)
                  WHERE id=$1 AND organization_id=$2 AND service_case_id=$3
                    AND status='active' AND record_version=$7
               RETURNING *`,
          values: [input.grantId, input.organizationId, input.serviceCaseId, input.actorUserId,
            input.revokedAtMs, input.reasonCode, input.expectedRecordVersion],
        });
        if (row.rows.length !== 1) throw new PortalRepositoryError("PORTAL_VERSION_CONFLICT");
        const grant = mapGrant(row.rows[0]);
        await appendAtomicMutationEffects(asAtomicTransaction(tx), input.effects);
        return terminal(grant, grant.id, input.effects.outbox.eventType);
      },
    });
    return this.resolveExecutedOrReplay(result, input.organizationId, input.serviceCaseId, "portal.grant.revoke");
  }

  async rotateGrant(input: Parameters<PortalRepository["rotateGrant"]>[0]): Promise<PortalAccessGrant> {
    const result = await runIdempotentTransaction<PortalAccessGrant>({
      runner: this.runner,
      context: userContext(input),
      claim: claim(input, "portal.grant.reissue"),
      revalidate: (tx) => this.assertInternalAuthorization(tx, input.organizationId, input.serviceCaseId, input.actorUserId, null, "reissue"),
      execute: async (tx) => {
        const old = await tx.query<GrantRow>({
          text: `UPDATE portal_access_grants
                    SET status='revoked', revoked_by_user_id=$4, revoked_at=to_timestamp($5/1000.0),
                        revoke_reason_code='reissued', keyed_secret_hash=NULL, record_version=record_version+1,
                        updated_at=to_timestamp($5/1000.0)
                  WHERE id=$1 AND organization_id=$2 AND service_case_id=$3
                    AND status='active' AND record_version=$6
               RETURNING *`,
          values: [input.oldGrantId, input.organizationId, input.serviceCaseId, input.actorUserId,
            input.rotatedAtMs, input.expectedRecordVersion],
        });
        if (old.rows.length !== 1) throw new PortalRepositoryError("PORTAL_VERSION_CONFLICT");
        const row = await tx.query<GrantRow>({
          text: `INSERT INTO portal_access_grants
            (id,lifecycle_id,organization_id,service_case_id,portal_viewer_id,keyed_secret_hash,
             secret_fingerprint,capability_set_version,status,issued_by_user_id,issued_at,expires_at,
             record_version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),$7,$8,'active',$9,to_timestamp($10/1000.0),to_timestamp($11/1000.0),1,to_timestamp($10/1000.0),to_timestamp($10/1000.0))
           RETURNING *`,
          values: [input.newGrantId, input.lifecycleId, input.organizationId, input.serviceCaseId,
            old.rows[0].portal_viewer_id, input.keyedSecretHash, input.secretFingerprint, input.capabilitySetVersion,
            input.actorUserId, input.rotatedAtMs, input.expiresAtMs],
        });
        const grant = mapGrant(row.rows[0]);
        await appendAtomicMutationEffects(asAtomicTransaction(tx), input.effects);
        return terminal(grant, grant.id, input.effects.outbox.eventType);
      },
    });
    return this.resolveExecutedOrReplay(result, input.organizationId, input.serviceCaseId, "portal.grant.reissue");
  }

  async createSession(input: Parameters<PortalRepository["createSession"]>[0]): Promise<PortalSessionRecord> {
    const row = await this.runner.run({ organizationId: input.organizationId, actorUserId: input.organizationId }, async (tx) => {
      const grant = await tx.query<GrantRow>({
        text: `SELECT * FROM portal_access_grants WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR UPDATE`,
        values: [input.grantId, input.organizationId, input.serviceCaseId],
      });
      if (grant.rows.length !== 1 || grant.rows[0].status !== "active") throw new PortalRepositoryError("PORTAL_GRANT_NOT_ACTIVE");
      const active = await tx.query<{ count: number }>({
        text: `SELECT count(*)::int AS count FROM portal_sessions WHERE grant_id=$1 AND organization_id=$2 AND status='active' AND idle_expires_at>transaction_timestamp()`,
        values: [input.grantId, input.organizationId],
      });
      if (Number(active.rows[0]?.count ?? 0) >= 3) throw new PortalRepositoryError("PORTAL_SESSION_LIMIT_REACHED");
      const slot = await tx.query<{ slot: number }>({
        text: `SELECT slot FROM generate_series(1,3) AS slot WHERE NOT EXISTS (SELECT 1 FROM portal_sessions WHERE grant_id=$1 AND session_slot=slot AND status='active') ORDER BY slot LIMIT 1`,
        values: [input.grantId],
      });
      if (slot.rows.length !== 1) throw new PortalRepositoryError("PORTAL_SESSION_LIMIT_REACHED");
      const inserted = await tx.query<SessionRow>({
        text: `INSERT INTO portal_sessions
          (id,organization_id,service_case_id,grant_id,session_slot,keyed_session_hash,status,
           grant_expires_at,last_seen_at,idle_expires_at,absolute_expires_at,record_version,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),'active',to_timestamp($7/1000.0),to_timestamp($8/1000.0),to_timestamp($9/1000.0),to_timestamp($10/1000.0),1,to_timestamp($8/1000.0),to_timestamp($8/1000.0))
         RETURNING *`,
        values: [input.sessionId, input.organizationId, input.serviceCaseId, input.grantId, slot.rows[0].slot,
          input.keyedSessionHash, new Date(grant.rows[0].expires_at).getTime(), input.createdAtMs,
          input.idleExpiresAtMs, input.absoluteExpiresAtMs],
      });
      await appendAtomicMutationEffects(asAtomicTransaction(tx), input.effects);
      return mapSession(inserted.rows[0]);
    });
    return row;
  }

  async findGrant(organizationId: string, serviceCaseId: string, grantId: string): Promise<PortalAccessGrant | null> {
    return this.runner.run({ organizationId, actorUserId: organizationId }, async (tx) => {
      const result = await tx.query<GrantRow>({ text: "SELECT * FROM portal_access_grants WHERE id=$1 AND organization_id=$2 AND service_case_id=$3", values: [grantId, organizationId, serviceCaseId] });
      return result.rows[0] ? mapGrant(result.rows[0]) : null;
    });
  }

  private async findViewer(organizationId: string, serviceCaseId: string, viewerId: string): Promise<PortalViewerRecord> {
    const viewer = await this.runner.run({ organizationId, actorUserId: organizationId }, async (tx) => {
      const result = await tx.query<ViewerRow>({
        text: "SELECT * FROM portal_viewers WHERE id=$1 AND organization_id=$2 AND service_case_id=$3",
        values: [viewerId, organizationId, serviceCaseId],
      });
      return result.rows[0] ? mapViewer(result.rows[0]) : null;
    });
    if (!viewer) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    return viewer;
  }

  async listGrants(input: { organizationId: string; serviceCaseId: string; actorUserId: string }) {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.actorUserId }, async (tx) => {
      await this.assertInternalAuthorization(tx, input.organizationId, input.serviceCaseId, input.actorUserId, null, "list");
      const result = await tx.query<GrantRow>({ text: "SELECT * FROM portal_access_grants WHERE organization_id=$1 AND service_case_id=$2 ORDER BY issued_at DESC", values: [input.organizationId, input.serviceCaseId] });
      return result.rows.map((row) => ({ ...mapGrant(row), secretFingerprint: row.secret_fingerprint }));
    });
  }

  async redeemAccess(input: NonNullable<PortalRepository["redeemAccess"]> extends (arg: infer A) => Promise<unknown> ? A : never): Promise<PortalSessionRecord> {
    const key = parseBearerKey(input.accessKey);
    const secretHash = this.keyedDigest(`grant:${key.grantId}:${key.secret}`);
    const claimInput = {
      organizationId: key.organizationId, actorUserId: key.grantId, requestId: input.requestId,
      idempotencyKey: input.idempotencyKey, requestHash: createHash("sha256").update(`portal:${key.grantId}:${key.secret}`).digest("hex"),
    };
    const result = await runIdempotentTransaction<PortalSessionRecord>({
      runner: this.runner,
      context: { organizationId: key.organizationId, actorKind: "portal", actorOpaqueId: key.grantId, requestId: input.requestId },
      claim: { id: this.syntheticId(`${key.grantId}:${input.idempotencyKey}`), organizationId: key.organizationId, actorKind: "portal", actorOpaqueId: key.grantId, operation: "portal.session.redeem", key: input.idempotencyKey, requestHash: claimInput.requestHash, createdAt: new Date(input.nowMs).toISOString() },
      revalidate: (tx) => this.assertPublicGrant(tx, key.organizationId, key.caseId, key.grantId, secretHash, input.nowMs),
      execute: async (tx) => {
        const grantResult = await tx.query<GrantRow>({ text: "SELECT * FROM portal_access_grants WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR UPDATE", values: [key.grantId, key.organizationId, key.caseId] });
        if (grantResult.rows.length !== 1) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
        const grant = grantResult.rows[0];
        const active = await tx.query<{ count: number }>({ text: "SELECT count(*)::int AS count FROM portal_sessions WHERE grant_id=$1 AND organization_id=$2 AND status='active' AND idle_expires_at>to_timestamp($3/1000.0)", values: [key.grantId, key.organizationId, input.nowMs] });
        if (Number(active.rows[0]?.count ?? 0) >= 3) throw new PortalRepositoryError("PORTAL_SESSION_LIMIT_REACHED");
        const slot = await tx.query<{ slot: number }>({ text: "SELECT slot FROM generate_series(1,3) AS slot WHERE NOT EXISTS (SELECT 1 FROM portal_sessions WHERE grant_id=$1 AND session_slot=slot AND status='active') ORDER BY slot LIMIT 1", values: [key.grantId] });
        if (slot.rows.length !== 1) throw new PortalRepositoryError("PORTAL_SESSION_LIMIT_REACHED");
        const idle = Math.min(input.nowMs + 15 * 60_000, new Date(grant.expires_at).getTime());
        const absolute = Math.min(input.nowMs + 8 * 60 * 60_000, new Date(grant.expires_at).getTime());
        const inserted = await tx.query<SessionRow>({ text: `INSERT INTO portal_sessions
          (id,organization_id,service_case_id,grant_id,session_slot,keyed_session_hash,status,grant_expires_at,last_seen_at,idle_expires_at,absolute_expires_at,record_version,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,decode($6,'hex'),'active',to_timestamp($7/1000.0),to_timestamp($8/1000.0),to_timestamp($9/1000.0),to_timestamp($10/1000.0),1,to_timestamp($8/1000.0),to_timestamp($8/1000.0)) RETURNING *`, values: [input.sessionId, key.organizationId, key.caseId, key.grantId, slot.rows[0].slot, input.keyedSessionHash, new Date(grant.expires_at).getTime(), input.nowMs, idle, absolute] });
        await appendPortalEffects(tx, key.organizationId, key.grantId, input.requestId, input.idempotencyKey, "redeem", input.nowMs);
        return terminal(mapSession(inserted.rows[0]), input.sessionId, "portal.session.redeemed");
      },
    });
    if (result.status === "executed") return result.value;
    const replay = await this.runner.run({ organizationId: key.organizationId, actorKind: "portal", actorOpaqueId: key.grantId, requestId: input.requestId }, async (tx) => {
      const row = await tx.query<SessionRow>({ text: "SELECT * FROM portal_sessions WHERE id=$1 AND organization_id=$2", values: [result.resultReference, key.organizationId] });
      if (!row.rows[0]) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
      return mapSession(row.rows[0]);
    });
    return replay;
  }

  async readSession(input: NonNullable<PortalRepository["readSession"]> extends (arg: infer A) => Promise<unknown> ? A : never) {
    const key = parseBearerKey(input.sessionSecret);
    return this.runner.run({ organizationId: key.organizationId, actorKind: "portal", actorOpaqueId: key.sessionId, requestId: input.requestId }, async (tx) => {
      const row = await tx.query<SessionRow>({ text: `SELECT * FROM portal_sessions
        WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR UPDATE`, values: [key.sessionId, key.organizationId, key.caseId] });
      const found = row.rows[0];
      if (!found || found.status !== "active" || !this.equalHash(found.keyed_session_hash, this.keyedDigest(`session:${found.grant_id}:${key.secret}`))) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
      await this.assertPublicGrant(tx, key.organizationId, key.caseId, found.grant_id, undefined, input.nowMs);
      const grantRow = await tx.query<GrantRow>({ text: "SELECT * FROM portal_access_grants WHERE id=$1 AND organization_id=$2 AND service_case_id=$3", values: [found.grant_id, key.organizationId, key.caseId] });
      const grant = mapGrant(grantRow.rows[0]);
      const idle = Math.min(input.nowMs + 15 * 60_000, new Date(found.absolute_expires_at).getTime(), grant.expiresAtMs);
      const updated = await tx.query<SessionRow>({ text: "UPDATE portal_sessions SET last_seen_at=to_timestamp($4/1000.0), idle_expires_at=to_timestamp($5/1000.0), record_version=record_version+1, updated_at=to_timestamp($4/1000.0) WHERE id=$1 AND organization_id=$2 AND status='active' AND idle_expires_at>to_timestamp($3/1000.0) RETURNING *", values: [key.sessionId, key.organizationId, input.nowMs, input.nowMs, idle] });
      if (!updated.rows[0]) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
      const workspace = await this.readWorkspaceSource(tx, key.organizationId, key.caseId);
      await appendPortalAudit(tx, key.organizationId, key.sessionId, input.requestId, "read", input.nowMs);
      return { session: mapSession(updated.rows[0]), grant, workspace };
    });
  }

  async revokeSessionBySecret(input: NonNullable<PortalRepository["revokeSessionBySecret"]> extends (arg: infer A) => Promise<unknown> ? A : never): Promise<void> {
    const key = parseBearerKey(input.sessionSecret);
    await this.runner.run({ organizationId: key.organizationId, actorKind: "portal", actorOpaqueId: key.sessionId, requestId: input.requestId }, async (tx) => {
      const row = await tx.query<SessionRow>({ text: "SELECT * FROM portal_sessions WHERE id=$1 AND organization_id=$2 AND service_case_id=$3 FOR UPDATE", values: [key.sessionId, key.organizationId, key.caseId] });
      const session = row.rows[0];
      if (!session || !this.equalHash(session.keyed_session_hash, this.keyedDigest(`session:${session.grant_id}:${key.secret}`))) return;
      await tx.query({ text: "UPDATE portal_sessions SET status='revoked', keyed_session_hash=NULL, revoked_at=to_timestamp($4/1000.0), revoke_reason_code='logout', record_version=record_version+1, updated_at=to_timestamp($4/1000.0) WHERE id=$1 AND organization_id=$2 AND status='active'", values: [key.sessionId, key.organizationId, key.caseId, input.nowMs] });
      await appendPortalAudit(tx, key.organizationId, key.sessionId, input.requestId, "logout", input.nowMs);
    });
  }

  private async resolveExecutedOrReplay(result: IdempotentTransactionResult<PortalAccessGrant>, organizationId: string, caseId: string, _operation: string) {
    if (result.status === "executed") return result.value;
    const found = await this.findGrant(organizationId, caseId, result.resultReference);
    if (!found) throw new PortalRepositoryError("PORTAL_GRANT_NOT_FOUND");
    return found;
  }

  private async assertInternalAuthorization(tx: Queryable, organizationId: string, caseId: string, actorUserId: string, viewerId: string | null, operation: "issue" | "reissue" | "revoke" | "list") {
    const [actor, caseFacts] = await Promise.all([
      this.accessReadPort.readActorFacts(tx, { organizationId, actorUserId }),
      this.casesReadPort.readCaseFacts(tx, { organizationId, serviceCaseId: caseId }),
    ]);
    if (!actor || !caseFacts || actor.organizationStatus !== "active" || actor.userStatus !== "active" || actor.membershipStatus !== "active" || !isPortalCaseAvailable(caseFacts.workflowStatus)) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    if (viewerId) {
      const viewer = await tx.query<{ guardian_relationship_id: string | null; status: string }>({ text: "SELECT guardian_relationship_id,status FROM portal_viewers WHERE id=$1 AND organization_id=$2 AND service_case_id=$3", values: [viewerId, organizationId, caseId] });
      const relationshipId = viewer.rows[0]?.guardian_relationship_id;
      const relationship = await this.crmReadPort.readGuardianRelationship(tx, { organizationId, relationshipId: relationshipId ?? "00000000-0000-4000-8000-000000000000", studentId: caseFacts.studentId });
      if (viewer.rows[0]?.status !== "active" || !relationship?.active) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    }
    if ((operation === "issue" || operation === "reissue") && caseFacts.primaryUserId !== actorUserId) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    if ((operation === "revoke" || operation === "list") && caseFacts.primaryUserId !== actorUserId && !actor.isFounder) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
  }

  private async assertPublicGrant(tx: Queryable, organizationId: string, caseId: string, grantId: string, secretHash: string | undefined, nowMs: number, found?: any) {
    const row = found ?? (await tx.query<GrantRow & { viewer_status: string; guardian_relationship_id: string | null }>({ text: `SELECT g.*, viewer.status AS viewer_status, viewer.guardian_relationship_id
      FROM portal_access_grants AS g JOIN portal_viewers AS viewer ON viewer.id=g.portal_viewer_id
      WHERE g.id=$1 AND g.organization_id=$2 AND g.service_case_id=$3`, values: [grantId, organizationId, caseId] })).rows[0];
    const caseFacts = await this.casesReadPort.readCaseFacts(tx, { organizationId, serviceCaseId: caseId });
    const issuer = row ? await this.accessReadPort.readActorFacts(tx, { organizationId, actorUserId: row.issued_by_user_id }) : null;
    const relationshipId = row?.guardian_relationship_id;
    const relationship = row && relationshipId && caseFacts ? await this.crmReadPort.readGuardianRelationship(tx, { organizationId, relationshipId, studentId: caseFacts.studentId }) : null;
    if (!row || row.status !== "active" || new Date(row.expires_at).getTime() <= nowMs || (secretHash && !this.equalHash(row.keyed_secret_hash, secretHash)) || row.viewer_status !== "active" || !relationship?.active || !issuer || issuer.organizationStatus !== "active" || issuer.userStatus !== "active" || issuer.membershipStatus !== "active" || !caseFacts || !isPortalCaseAvailable(caseFacts.workflowStatus) || caseFacts.primaryUserId !== row.issued_by_user_id) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
  }

  private async readWorkspaceSource(tx: Queryable, organizationId: string, caseId: string): Promise<PortalWorkspaceSource> {
    const row = await this.casesReadPort.readWorkspaceFacts(tx, { organizationId, serviceCaseId: caseId });
    if (!row) throw new PortalRepositoryError("PORTAL_GRANT_NOT_FOUND");
    const labels = await this.schoolsReadPort.readLabels(tx, { organizationId, schoolIds: row.schoolTargets.map((target) => target.schoolId) });
    return { customerFacingStage: row.stage, lastCustomerVisibleUpdateAt: new Date(row.updatedAt).toISOString(), schoolTargets: row.schoolTargets.map((target) => ({ name: labels.get(target.schoolId) ?? target.schoolId, status: target.status, customerVisible: true })), actionItems: row.actionItems, messages: row.messages };
  }

  private keyedDigest(value: string): string { return createHmac("sha256", this.pepper).update(value).digest("hex"); }
  private equalHash(a: unknown, b: string): boolean { return Buffer.isBuffer(a) ? a.toString("hex") === b : typeof a === "string" && a === b; }
  private syntheticId(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 8) + "-0000-4000-8000-000000000000"; }
}

type GrantRow = Record<string, any> & { id: string; organization_id: string; service_case_id: string; record_version: number; status: string; issued_at: string | Date; expires_at: string | Date; secret_fingerprint: string; keyed_secret_hash: Buffer | string | null; portal_viewer_id: string; issued_by_user_id: string; lifecycle_id: string; capability_set_version: "portal_case_read_v1"; revoked_by_user_id: string | null; revoked_at: string | Date | null; revoke_reason_code: string | null };
type SessionRow = Record<string, any> & { id: string; organization_id: string; service_case_id: string; grant_id: string; status: string; created_at: string | Date; last_seen_at: string | Date; idle_expires_at: string | Date; absolute_expires_at: string | Date; record_version: number; keyed_session_hash: Buffer | string | null };
type ViewerRow = Record<string, any> & { id: string; organization_id: string; service_case_id: string; guardian_relationship_id: string; status: string; record_version: number };

function isPortalCaseAvailable(status: string): boolean {
  return status === "active" || status === "paused";
}

function mapGrant(row: GrantRow | undefined): PortalAccessGrant {
  if (!row) throw new PortalRepositoryError("PORTAL_GRANT_NOT_FOUND");
  return { id: row.id, lifecycleId: row.lifecycle_id, organizationId: row.organization_id, serviceCaseId: row.service_case_id, portalViewerId: row.portal_viewer_id, capabilitySetVersion: row.capability_set_version, status: row.status as PortalAccessGrant["status"], issuedByUserId: row.issued_by_user_id, issuedAtMs: new Date(row.issued_at).getTime(), expiresAtMs: new Date(row.expires_at).getTime(), revokedByUserId: row.revoked_by_user_id, revokedAtMs: row.revoked_at ? new Date(row.revoked_at).getTime() : null, revokeReasonCode: row.revoke_reason_code, recordVersion: Number(row.record_version) };
}

function mapSession(row: SessionRow): PortalSessionRecord {
  return { id: row.id, organizationId: row.organization_id, serviceCaseId: row.service_case_id, grantId: row.grant_id, status: row.status as PortalSessionRecord["status"], createdAtMs: new Date(row.created_at).getTime(), lastSeenAtMs: new Date(row.last_seen_at).getTime(), idleExpiresAtMs: new Date(row.idle_expires_at).getTime(), absoluteExpiresAtMs: new Date(row.absolute_expires_at).getTime(), recordVersion: Number(row.record_version) };
}

function mapViewer(row: ViewerRow | undefined): PortalViewerRecord {
  if (!row) throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
  return {
    id: row.id,
    organizationId: row.organization_id,
    serviceCaseId: row.service_case_id,
    guardianRelationshipId: row.guardian_relationship_id,
    status: row.status as PortalViewerRecord["status"],
    recordVersion: Number(row.record_version),
  };
}

function parseBearerKey(value: string) {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "p1" || !UUID.test(parts[1]) || !UUID.test(parts[2]) || !UUID.test(parts[3]) || !/^[A-Za-z0-9_-]{32,128}$/.test(parts[4])) throw new PortalRepositoryError("PORTAL_SECRET_INVALID");
  return { organizationId: parts[1], caseId: parts[2], grantId: parts[3], sessionId: parts[3], secret: parts[4] };
}

function userContext(input: { organizationId: string; actorUserId: string; requestId?: string }) { return { organizationId: input.organizationId, actorKind: "user" as const, actorOpaqueId: input.actorUserId, actorUserId: input.actorUserId, requestId: input.requestId ?? "portal-internal" }; }
function claim(input: { organizationId: string; actorUserId: string; idempotencyKey: string; requestHash: string; effects: { audit: { id: string }; outbox: { eventType: string } } }, operation: string) { return { id: input.effects.audit.id, organizationId: input.organizationId, actorKind: "user" as const, actorOpaqueId: input.actorUserId, operation, key: input.idempotencyKey, requestHash: input.requestHash, createdAt: new Date().toISOString() }; }
function terminal<T>(value: T, reference: string, eventType: string) { return { state: "completed" as const, resultReference: reference, responseHash: createHash("sha256").update(JSON.stringify({ reference, eventType })).digest("hex"), updatedAt: new Date().toISOString(), value }; }

async function appendPortalEffects(tx: TenantTransaction, organizationId: string, aggregateId: string, requestId: string, idempotencyKey: string, operation: string, nowMs: number) {
  const effects = portalEffects(organizationId, aggregateId, requestId, idempotencyKey, operation, nowMs);
        await appendAtomicMutationEffects(asAtomicTransaction(tx), effects);
}
async function appendPortalAudit(tx: TenantTransaction, organizationId: string, aggregateId: string, requestId: string, operation: string, nowMs: number) {
  await appendPortalEffects(tx, organizationId, aggregateId, requestId, `portal-${operation}-${aggregateId}`, operation, nowMs);
}
function portalEffects(organizationId: string, aggregateId: string, requestId: string, idempotencyKey: string, operation: string, nowMs: number) {
  const eventId = cryptoId(`${aggregateId}:${requestId}:${operation}`); const audit = buildAuditEvent({ id: eventId, organizationId, actorUserId: null, actorKind: "portal", eventType: `portal.session.${operation}`, eventVersion: 1, action: operation, resourceType: "portal_session", resourceId: aggregateId, outcome: "succeeded", requestId, occurredAt: new Date(nowMs).toISOString(), metadata: { effect_type: operation, request_id: requestId } }); const outbox = buildOutboxMessage({ id: cryptoId(`${eventId}:outbox`), auditEventId: eventId, organizationId, aggregateType: "portal_session", aggregateId, eventType: audit.eventType, eventVersion: 1, idempotencyKey, requestId, payload: { aggregate_id: aggregateId, request_id: requestId, effect_type: operation, operation }, availableAt: audit.occurredAt, createdAt: audit.occurredAt }); return buildAtomicMutationEffects({ audit, outbox });
}
function cryptoId(value: string) { const hex = createHash("sha256").update(value).digest("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`; }
