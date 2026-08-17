import {
  BillingContractError,
  type BillingErrorCode,
} from "./contract.ts";

export const PLATFORM_BILLING_ROLES = Object.freeze([
  "platform_admin",
  "platform_finance",
  "platform_billing_approver",
  "tenant_founder",
  "organization_user",
] as const);

export type PlatformBillingRole = (typeof PLATFORM_BILLING_ROLES)[number];

export interface PlatformBillingActor {
  readonly actorId: string;
  readonly role: PlatformBillingRole;
  readonly status: "active" | "disabled";
}

export type BillingPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: BillingErrorCode };

export type UnavailablePlatformBillingOperation =
  | "calculate_payable_amount"
  | "generate_notice"
  | "approve_notice"
  | "deliver_notice"
  | "record_manual_receipt"
  | "suspend_subscription"
  | "terminate_subscription"
  | "purge_record"
  | "activate_second_tenant";

export interface SubscriptionProjection {
  readonly status: "active" | "past_due";
  readonly aggregateException: "past_due" | null;
  readonly authorizationEffect: "none";
}

const ACTOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isActiveActorWithRole(
  actor: PlatformBillingActor,
  role: PlatformBillingRole,
): boolean {
  return (
    ACTOR_ID_PATTERN.test(actor.actorId) &&
    actor.status === "active" &&
    actor.role === role
  );
}

export function evaluateContractDraftCreation(
  actor: PlatformBillingActor,
): BillingPolicyDecision {
  return isActiveActorWithRole(actor, "platform_finance")
    ? { allowed: true }
    : { allowed: false, code: "BILLING_COMMAND_DENIED" };
}

export function evaluateContractActivation(input: {
  readonly creatorActorId: string;
  readonly approver: PlatformBillingActor;
}): BillingPolicyDecision {
  if (!isActiveActorWithRole(input.approver, "platform_billing_approver")) {
    return { allowed: false, code: "BILLING_COMMAND_DENIED" };
  }
  if (input.creatorActorId === input.approver.actorId) {
    return { allowed: false, code: "BILLING_SELF_APPROVAL_DENIED" };
  }
  return { allowed: true };
}

export function evaluatePlatformBillingExport(
  _actor: PlatformBillingActor,
): BillingPolicyDecision {
  return { allowed: false, code: "BILLING_EXPORT_DENIED" };
}

export function evaluatePlatformBillingOperation(
  operation: UnavailablePlatformBillingOperation,
): BillingPolicyDecision {
  switch (operation) {
    case "purge_record":
      return { allowed: false, code: "BILLING_RETENTION_PENDING" };
    case "activate_second_tenant":
      return { allowed: false, code: "BILLING_SECOND_TENANT_UNAVAILABLE" };
    case "suspend_subscription":
    case "terminate_subscription":
      return {
        allowed: false,
        code: "BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE",
      };
    case "calculate_payable_amount":
    case "generate_notice":
    case "approve_notice":
    case "deliver_notice":
    case "record_manual_receipt":
      return { allowed: false, code: "BILLING_POLICY_UNAVAILABLE" };
  }
}

export function projectSubscriptionStatus(
  status: "active" | "past_due" | "suspended" | "terminated",
): SubscriptionProjection {
  if (status === "suspended" || status === "terminated") {
    throw new BillingContractError("BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE");
  }
  return Object.freeze({
    status,
    aggregateException: status === "past_due" ? "past_due" : null,
    authorizationEffect: "none",
  });
}
