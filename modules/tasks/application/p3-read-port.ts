import type { TaskFactsAssigneeRole } from "../../shared/public.ts";

export interface P3TaskReadRow {
  readonly id: string;
  readonly task_kind: "application_prepare_submit" | "interview_support" | "manual";
  readonly school_target_id: string | null;
  readonly state: string;
  readonly due_at: string;
  readonly is_overdue: boolean;
  readonly record_version: number | string;
  readonly owner_user_id: string;
  readonly trial_manager?: boolean;
  readonly writable?: boolean;
  readonly current_assignment: Readonly<{
    readonly id: string;
    readonly assignee_user_id: string;
    readonly assignee_role: TaskFactsAssigneeRole;
    readonly status: string;
  }> | null;
}

export interface P3TaskReadRepository {
  readTask(input: Readonly<{
    readonly organizationId: string;
    readonly userId: string;
    readonly isFounder: boolean;
    readonly taskId: string;
    readonly actorRole: TaskFactsAssigneeRole;
  }>): Promise<P3TaskReadRow | null>;
  listAssigned(input: Readonly<{
    readonly organizationId: string;
    readonly userId: string;
    readonly isFounder: boolean;
    readonly actorRole: TaskFactsAssigneeRole;
  }>): Promise<readonly P3TaskReadRow[]>;
}
