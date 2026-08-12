import {
  COLLABORATOR_CAPABILITIES,
  COLLABORATOR_SCOPES,
  GRANT_POLICY,
  type CollaboratorCapability,
  type CollaboratorScope,
} from "./contract.ts";
import type { OrganizationRole } from "./contract.ts";

export interface ContractorTaskAssignmentContext {
  readonly requestOrganizationId: string;
  readonly actorOrganizationId: string;
  readonly actorUserId: string;
  readonly actorRole: OrganizationRole;
  readonly actorIsActive: boolean;
  readonly taskOrganizationId: string;
  readonly currentAssigneeUserId: string | null;
  readonly currentAssigneeRole: OrganizationRole | null;
  readonly assignmentStatus: "active" | "revoked" | "reassigned";
  readonly redactionLevel: "task_only" | "full";
}

export type ContractorTaskAccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: "CONTRACTOR_TASK_ACCESS_DENIED" };

export class AccessScopePolicyError extends Error {
  constructor() {
    super("Collaborator scope policy rejected the command.");
    this.name = "AccessScopePolicyError";
  }
}

/**
 * Pure transaction-local decision for the contractor read path. The owning
 * Task repository supplies these facts from authoritative rows in one RDS
 * transaction; browser role or assignment claims are never inputs.
 */
export function evaluateContractorTaskAccess(
  input: ContractorTaskAssignmentContext,
): ContractorTaskAccessDecision {
  if (
    input.actorRole !== "contractor" ||
    !input.actorIsActive ||
    input.requestOrganizationId !== input.actorOrganizationId ||
    input.requestOrganizationId !== input.taskOrganizationId ||
    input.currentAssigneeUserId !== input.actorUserId ||
    input.currentAssigneeRole !== "contractor" ||
    input.assignmentStatus !== "active" ||
    input.redactionLevel !== "task_only"
  ) {
    return { allowed: false, code: "CONTRACTOR_TASK_ACCESS_DENIED" };
  }

  return { allowed: true };
}

export function isCollaboratorScope(value: unknown): value is CollaboratorScope {
  return typeof value === "string" && (COLLABORATOR_SCOPES as readonly string[]).includes(value);
}

export function isCollaboratorCapability(value: unknown): value is CollaboratorCapability {
  return (
    typeof value === "string" &&
    (COLLABORATOR_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isSensitiveCollaboratorScope(scope: CollaboratorScope): boolean {
  return (GRANT_POLICY.sensitiveScopes as readonly CollaboratorScope[]).includes(scope);
}

export function resolveGrantExpiry(input: {
  readonly startsAtMs: number;
  readonly requestedExpiresAtMs: number | null;
}): number {
  if (!Number.isSafeInteger(input.startsAtMs) || input.startsAtMs <= 0) {
    throw new AccessScopePolicyError();
  }

  const defaultExpiry = input.startsAtMs + GRANT_POLICY.defaultDurationMs;
  const expiresAtMs = input.requestedExpiresAtMs ?? defaultExpiry;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= input.startsAtMs ||
    expiresAtMs > defaultExpiry
  ) {
    throw new AccessScopePolicyError();
  }

  return expiresAtMs;
}
