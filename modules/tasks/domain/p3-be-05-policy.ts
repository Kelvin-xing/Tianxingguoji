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
  hasOfficialSubmissionReference?: boolean;
}>): boolean {
  if (!hasRequestCapability(input.actor, "tasks.transition") || !input.isAssignee) return false;
  if (input.kind === "interview_support") return input.targetState === "interview";
  return input.targetState === "preparing" && input.hasSubmissionReceipt &&
    (input.hasEvidenceReference || input.hasOfficialSubmissionReference === true);
}

export function isValidApplicationCompletion(value: Readonly<Record<string, unknown>> | null): boolean {
  if (!value) return false;
  if (typeof value.submitted_at !== "string" || Number.isNaN(Date.parse(value.submitted_at)) ||
      Date.parse(value.submitted_at) > Date.now() ||
      !["school_portal", "email", "courier", "in_person", "other"].includes(String(value.submission_channel)) ||
      typeof value.submitter_user_id !== "string" || !value.checklist_snapshot ||
      typeof value.checklist_snapshot !== "object" || Array.isArray(value.checklist_snapshot) ||
      typeof value.no_reference_declared !== "boolean" ||
      !Object.keys(value).every((key) => ["submitted_at","submission_channel","submitter_user_id",
        "checklist_snapshot","official_submission_reference","no_reference_declared"].includes(key))) return false;
  const checklist = value.checklist_snapshot as Record<string, unknown>;
  if (Object.keys(checklist).sort().join(",") !== "all_required_items_complete,confirmed_at" ||
      checklist.all_required_items_complete !== true || typeof checklist.confirmed_at !== "string" ||
      Number.isNaN(Date.parse(checklist.confirmed_at)) || Date.parse(checklist.confirmed_at) > Date.now()) return false;

  if (value.no_reference_declared) return value.official_submission_reference === null;
  return typeof value.official_submission_reference === "string" &&
    value.official_submission_reference.trim() !== "";
}

export function isTaskDueAtStableWhenPaused(dueAt: string, pausedAt: string): boolean {
  return Date.parse(dueAt) > 0 && Date.parse(pausedAt) > 0;
}
