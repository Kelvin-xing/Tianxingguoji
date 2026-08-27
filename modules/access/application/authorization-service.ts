import type { IdentityPrincipal } from "../../identity/public.ts";
import {
  buildAccessContext,
  type AccessContext,
  type AccessResolutionFacts,
  type AuthorizationRequest,
  type AuthorizationDecision,
} from "../domain/authorization.ts";
import {
  evaluateContractorTaskAccess,
  type ContractorTaskAssignmentContext,
} from "../domain/policy.ts";

export interface AccessAuthorizationRepository {
  /** Must query current Membership, RoleBinding and organization facts per call. */
  resolveAccessFacts(input: Readonly<{
    readonly userId: string;
    readonly organizationId: string;
    readonly membershipId: string;
  }>): Promise<AccessResolutionFacts | null>;
}

export class AccessAuthorizationService {
  private readonly repository: AccessAuthorizationRepository;

  constructor(options: Readonly<{ repository: AccessAuthorizationRepository }>) {
    this.repository = options.repository;
  }

  async resolveWorkspaceContext(principal: IdentityPrincipal): Promise<AccessContext | null> {
    const facts = await this.repository.resolveAccessFacts({
      userId: principal.userId,
      organizationId: principal.organizationId,
      membershipId: principal.membershipId,
    });
    if (!facts || facts.userId !== principal.userId || facts.roles.length === 0) return null;
    return buildAccessContext(facts);
  }

  async evaluateCapability(
    principal: IdentityPrincipal,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    const context = await this.resolveWorkspaceContext(principal);
    if (!context || !context.workspaceCapabilities.includes(request.capability)) {
      return Object.freeze({ allowed: false, code: "ACCESS_CAPABILITY_DENIED" });
    }
    return Object.freeze({
      allowed: true,
      policyVersion: context.authorizationVersion,
    });
  }

  evaluateContractorTask(
    context: AccessContext,
    input: Omit<ContractorTaskAssignmentContext, "actorOrganizationId" | "actorUserId" | "actorRole" | "actorIsActive">,
  ) {
    const isContractorOnly = context.roles.length === 1 && context.roles[0] === "contractor";
    return evaluateContractorTaskAccess({
      ...input,
      actorOrganizationId: context.organizationId,
      actorUserId: context.userId,
      actorRole: isContractorOnly ? "contractor" : "advisor",
      actorIsActive: true,
    });
  }
}
