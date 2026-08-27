import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";

export const APPROVED_NOTIFICATION_EFFECTS = Object.freeze([
  "task_assigned",
  "task_reassigned",
  "task_rejected",
  "candidate_list_review_requested",
  "candidate_list_reviewed",
  "task_due_in_3_days",
  "task_due_in_1_day",
  "task_overdue_daily",
  "case_closure_choice_required",
] as const);
export type ApprovedNotificationEffect = (typeof APPROVED_NOTIFICATION_EFFECTS)[number];

export function canReceiveInAppNotification(input: Readonly<{
  actor: RequestAccessActor;
  recipientRole: "founder" | "advisor" | "admin" | "guardian" | "student" | "contractor";
}>): boolean {
  return (input.recipientRole === "founder" || input.recipientRole === "advisor") &&
    hasRequestCapability(input.actor, "today.read");
}

export function isApprovedNotificationEffect(value: string): value is ApprovedNotificationEffect {
  return (APPROVED_NOTIFICATION_EFFECTS as readonly string[]).includes(value);
}

export function notificationDeduplicationKey(input: Readonly<{
  recipientUserId: string; effectType: ApprovedNotificationEffect;
  sourceOpaqueId: string; businessDate: string; version: number;
}>): string {
  return [input.recipientUserId,input.effectType,input.sourceOpaqueId,input.businessDate,input.version].join(":");
}
