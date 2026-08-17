import type { TaskState } from "../domain/contract.ts";
import type { ContractorTaskWorkspaceResult } from "./contractor-workspace.ts";

const CONTRACTOR_ACTIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  created: Object.freeze([]),
  assigned: Object.freeze(["accepted", "rejected"]),
  accepted: Object.freeze(["completed"]),
  rejected: Object.freeze([]),
  reassigned: Object.freeze([]),
  completed: Object.freeze([]),
  approved: Object.freeze([]),
  overdue: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const CONTRACTOR_TASK_ALLOWED_TRANSITIONS = Object.freeze([
  "accepted",
  "rejected",
  "completed",
] as const satisfies readonly TaskState[]);

const STATE_LABELS: Readonly<Record<TaskState, string>> = Object.freeze({
  created: "Created",
  assigned: "Assigned",
  accepted: "Accepted",
  rejected: "Returned",
  reassigned: "Reassigned",
  completed: "Delivered",
  approved: "Approved",
  overdue: "Overdue",
  cancelled: "Cancelled",
});

export interface ContractorTaskWorkspaceModel {
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
  readonly dueLabel: string;
  readonly state: TaskState;
  readonly stateLabel: string;
  readonly recordVersion: number;
  readonly actions: readonly TaskState[];
}

export function contractorTaskActions(state: TaskState): readonly TaskState[] {
  return CONTRACTOR_ACTIONS[state];
}

export function buildContractorTaskWorkspaceModel(
  task: ContractorTaskWorkspaceResult,
): ContractorTaskWorkspaceModel {
  return Object.freeze({
    taskId: task.task_id,
    title: task.title,
    brief: task.task_brief,
    dueLabel: task.due_at,
    state: task.state,
    stateLabel: STATE_LABELS[task.state],
    recordVersion: task.record_version,
    actions: contractorTaskActions(task.state),
  });
}
