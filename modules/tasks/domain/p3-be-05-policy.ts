import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";

export type P3TaskKind = "application_prepare_submit" | "interview_support";
export type P3AssigneeRole = "advisor" | "contractor";
export type P3TargetState = "candidate" | "preparing" | "submitted" | "interview" | "waitlisted" | "accepted" | "rejected" | "withdrawn" | "offer_confirmed" | "offer_declined";

export function canCreateTargetTask(input: Readonly<{
  actor: RequestAccessActor; kind: P3TaskKind; assigneeRole: P3AssigneeRole;
  isPrimaryAdvisor: boolean; isCaseAdvisorCollaborator: boolean;
  targetState: P3TargetState; workflowStatus: "active" | "paused" | "termination_pending" | "closed";
}>): boolean {
  if (!hasRequestCapability(input.actor, "tasks.create") || input.workflowStatus !== "active") return false;
  if (input.kind === "application_prepare_submit") {
    return input.assigneeRole === "advisor" &&
      (input.isPrimaryAdvisor || input.isCaseAdvisorCollaborator) && input.targetState === "preparing";
  }
  return input.assigneeRole === "advisor" || input.assigneeRole === "contractor";
}

export function canCompleteTargetTask(input: Readonly<{
  actor: RequestAccessActor; kind: P3TaskKind; isAssignee: boolean;
  targetState: P3TargetState; hasSubmissionReceipt: boolean; hasEvidenceReference: boolean;
}>): boolean {
  if (!hasRequestCapability(input.actor, "tasks.transition") || !input.isAssignee) return false;
  if (input.kind === "interview_support") return input.targetState === "interview";
  return input.targetState === "preparing" && input.hasSubmissionReceipt && input.hasEvidenceReference;
}

export function isValidApplicationCompletion(value: Readonly<Record<string, unknown>>): boolean {
  if (typeof value.submitted_at !== "string" || Number.isNaN(Date.parse(value.submitted_at)) ||
      typeof value.submission_channel !== "string" || value.submission_channel.trim() === "" ||
      typeof value.submitter_user_id !== "string" || !value.checklist_snapshot ||
      typeof value.checklist_snapshot !== "object" || Array.isArray(value.checklist_snapshot) ||
      typeof value.no_reference_declared !== "boolean") return false;

  if (value.no_reference_declared) return value.official_submission_reference === null;
  return typeof value.official_submission_reference === "string" &&
    value.official_submission_reference.trim() !== "";
}

export function isTaskDueAtStableWhenPaused(dueAt: string, pausedAt: string): boolean {
  return Date.parse(dueAt) > 0 && Date.parse(pausedAt) > 0;
}
