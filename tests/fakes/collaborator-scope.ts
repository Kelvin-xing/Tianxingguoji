import {
  evaluateScopeGrant,
  type CollaboratorCapability,
  type CollaboratorScope,
  type ScopeGrantDecision,
  type ScopeGrantStatus,
} from "../../modules/access/contract.ts";
import type {
  AccessScopeRepository,
  GrantCollaboratorScopeResult,
} from "../../modules/access/service.ts";
import { AccessScopeError } from "../../modules/access/service.ts";

interface StoredCollaborator {
  readonly id: string;
  readonly organizationId: string;
  readonly caseId: string;
  readonly userId: string;
}

interface StoredGrant {
  readonly collaboratorId: string;
  readonly grantId: string;
  readonly scope: CollaboratorScope;
  readonly capability: CollaboratorCapability;
  readonly status: ScopeGrantStatus;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly recordVersion: number;
  readonly organizationId: string;
  readonly caseId: string;
  readonly collaboratorUserId: string;
}

interface StoredIdempotencyResult {
  readonly requestHash: string;
  readonly result: GrantCollaboratorScopeResult;
}

/** A deterministic transaction-port fake; it is not a runtime persistence adapter. */
export class InMemoryCollaboratorScopeRepository implements AccessScopeRepository {
  private readonly activeCases = new Set<string>();
  private readonly primaryAdvisorKeys = new Set<string>();
  private readonly activeAdvisorKeys = new Set<string>();
  private readonly collaborators = new Map<string, StoredCollaborator>();
  private readonly grants = new Map<string, StoredGrant>();
  private readonly grantResultsByIdempotency = new Map<string, StoredIdempotencyResult>();
  private readonly auditIds = new Set<string>();
  private readonly outboxIds = new Set<string>();
  private failNextCommit = false;

  activateCase(input: { readonly organizationId: string; readonly caseId: string }): void {
    this.activeCases.add(caseKey(input));
  }

  assignPrimaryAdvisor(input: {
    readonly organizationId: string;
    readonly caseId: string;
    readonly userId: string;
  }): void {
    this.primaryAdvisorKeys.add(`${caseKey(input)}:${input.userId}`);
  }

  activateAdvisor(input: { readonly organizationId: string; readonly userId: string }): void {
    this.activeAdvisorKeys.add(`${input.organizationId}:${input.userId}`);
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{ collaborators: number; grants: number; audits: number; outbox: number }> {
    return Object.freeze({
      collaborators: this.collaborators.size,
      grants: this.grants.size,
      audits: this.auditIds.size,
      outbox: this.outboxIds.size,
    });
  }

  evaluateGrant(input: {
    readonly organizationId: string;
    readonly caseId: string;
    readonly userId: string;
    readonly scope: CollaboratorScope;
    readonly capability: CollaboratorCapability | "export";
    readonly nowMs?: number;
  }): ScopeGrantDecision {
    const collaborator = [...this.collaborators.values()].find(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.caseId === input.caseId &&
        candidate.userId === input.userId,
    );
    const grant = [...this.grants.values()].find(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.caseId === input.caseId &&
        candidate.collaboratorUserId === input.userId &&
        candidate.scope === input.scope &&
        (input.capability === "export" || candidate.capability === input.capability),
    );
    if (!collaborator || !grant) return { allowed: false, code: "GRANT_NOT_ACTIVE" };

    return evaluateScopeGrant({
      nowMs: input.nowMs ?? grant.startsAtMs,
      organizationId: input.organizationId,
      caseId: input.caseId,
      requestedScope: input.scope,
      requestedCapability: input.capability,
      userStatus: "active",
      organizationStatus: "active",
      membershipStatus: "active",
      advisorRoleBindingStatus: "active",
      collaboratorStatus: "active",
      grantStatus: grant.status as ScopeGrantStatus,
      grantOrganizationId: grant.organizationId,
      grantCaseId: grant.caseId,
      grantScope: grant.scope,
      grantCapability: grant.capability,
      startsAtMs: grant.startsAtMs,
      expiresAtMs: grant.expiresAtMs,
      requestedByUserId: "11111111-1111-4111-8111-111111111111",
      approvedByUserId: null,
      approverRole: null,
    });
  }

  async grantCollaboratorScope(input: Parameters<AccessScopeRepository["grantCollaboratorScope"]>[0]) {
    const idempotencyScope = `${input.organizationId}:${input.actorUserId}:access.scope_grant.create:${input.idempotencyKey}`;
    const replay = this.grantResultsByIdempotency.get(idempotencyScope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new AccessScopeError("COLLABORATOR_SCOPE_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }
    if (!this.activeCases.has(caseKey(input))) {
      throw new AccessScopeError("COLLABORATOR_CASE_NOT_ACTIVE");
    }
    if (!this.primaryAdvisorKeys.has(`${caseKey(input)}:${input.actorUserId}`)) {
      throw new AccessScopeError("COLLABORATOR_PRIMARY_ADVISOR_REQUIRED");
    }
    if (!this.activeAdvisorKeys.has(`${input.organizationId}:${input.collaboratorUserId}`)) {
      throw new AccessScopeError("COLLABORATOR_TARGET_ADVISOR_REQUIRED");
    }

    const existingCollaborator = [...this.collaborators.values()].find(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.caseId === input.caseId &&
        candidate.userId === input.collaboratorUserId,
    );
    const collaboratorId = existingCollaborator?.id ?? input.collaboratorId;
    if (
      [...this.grants.values()].some(
        (candidate) =>
          candidate.collaboratorId === collaboratorId &&
          candidate.scope === input.scope &&
          candidate.capability === input.capability &&
          candidate.status === "active",
      )
    ) {
      throw new AccessScopeError("COLLABORATOR_SCOPE_DUPLICATE");
    }
    const result: GrantCollaboratorScopeResult = Object.freeze({
      collaboratorId,
      grantId: input.grantId,
      scope: input.scope,
      capability: input.capability,
      status: input.status,
      startsAtMs: input.startsAtMs,
      expiresAtMs: input.expiresAtMs,
      recordVersion: 1,
    });

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    this.collaborators.set(collaboratorId, {
      id: collaboratorId,
      organizationId: input.organizationId,
      caseId: input.caseId,
      userId: input.collaboratorUserId,
    });
    this.grants.set(input.grantId, {
      ...result,
      organizationId: input.organizationId,
      caseId: input.caseId,
      collaboratorUserId: input.collaboratorUserId,
    });
    this.auditIds.add(input.effects.audit.id);
    this.outboxIds.add(input.effects.outbox.id);
    this.grantResultsByIdempotency.set(idempotencyScope, {
      requestHash: input.requestHash,
      result,
    });
    return result;
  }

  async revokeCollaboratorScope(
    input: Parameters<AccessScopeRepository["revokeCollaboratorScope"]>[0],
  ) {
    if (!this.activeCases.has(caseKey(input))) {
      throw new AccessScopeError("COLLABORATOR_CASE_NOT_ACTIVE");
    }
    if (!this.primaryAdvisorKeys.has(`${caseKey(input)}:${input.actorUserId}`)) {
      throw new AccessScopeError("COLLABORATOR_PRIMARY_ADVISOR_REQUIRED");
    }
    const collaborator = this.collaborators.get(input.collaboratorId);
    const grant = this.grants.get(input.grantId);
    if (
      !collaborator ||
      !grant ||
      collaborator.organizationId !== input.organizationId ||
      collaborator.caseId !== input.caseId ||
      grant.collaboratorId !== input.collaboratorId ||
      grant.organizationId !== input.organizationId ||
      grant.caseId !== input.caseId ||
      grant.status !== "active" ||
      grant.recordVersion !== input.expectedRecordVersion
    ) {
      throw new AccessScopeError("COLLABORATOR_SCOPE_STALE_VERSION");
    }

    const nextGrant: StoredGrant = {
      ...grant,
      status: "revoked",
      recordVersion: grant.recordVersion + 1,
    };
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }
    this.grants.set(input.grantId, nextGrant);
    this.auditIds.add(input.effects.audit.id);
    this.outboxIds.add(input.effects.outbox.id);
    return Object.freeze({
      collaboratorId: input.collaboratorId,
      grantId: input.grantId,
      status: "revoked" as const,
      recordVersion: nextGrant.recordVersion,
    });
  }
}

function caseKey(input: { readonly organizationId: string; readonly caseId: string }): string {
  return `${input.organizationId}:${input.caseId}`;
}
