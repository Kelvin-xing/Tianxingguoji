import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import type { P3TaskReadRepository, P3TaskReadRow } from "./p3-read-port.ts";

export type { P3TaskReadRepository, P3TaskReadRow } from "./p3-read-port.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type P3ReadTaskKind = "application_prepare_submit" | "interview_support" | "manual";
export type P3ReadAction = "accept" | "reject" | "reassign" | "complete" | "cancel";

/** Authoritative task projection consumed by the Release 1 task UI. */
export interface P3TaskReadDto {
  readonly id: string;
  readonly task_kind: P3ReadTaskKind;
  readonly school_target_id: string | null;
  readonly state: string;
  readonly due_at: string;
  readonly is_overdue: boolean;
  readonly record_version: number;
  readonly current_assignment: Readonly<{
    readonly id: string;
    readonly assignee_user_id: string;
    readonly assignee_role: "advisor" | "contractor";
    readonly status: string;
  }> | null;
  readonly allowed_actions: readonly P3ReadAction[];
}

export class P3TaskReadError extends Error {
  readonly code: "INVALID" | "FORBIDDEN" | "UNAVAILABLE";

  constructor(code: "INVALID" | "FORBIDDEN" | "UNAVAILABLE") {
    super(`P3 task read rejected ${code}.`);
    this.name = "P3TaskReadError";
    this.code = code;
  }
}

export class P3TaskReadService {
  private readonly repository: P3TaskReadRepository;

  constructor(repository: P3TaskReadRepository) {
    this.repository = repository;
  }

  async readTask(actor: RequestAccessActor, taskId: string): Promise<P3TaskReadDto | null> {
    const access = authorize(actor);
    if (!UUID.test(taskId)) throw new P3TaskReadError("INVALID");
    let row: P3TaskReadRow | null;
    try {
      row = await this.repository.readTask({
        organizationId: actor.organizationId,
        userId: actor.userId,
        isFounder: access.isFounder,
        actorRole: access.actorRole,
        taskId,
      });
    } catch (error) {
      if (error instanceof P3TaskReadError) throw error;
      throw new P3TaskReadError("UNAVAILABLE");
    }
    return row === null ? null : project(row, actor);
  }

  async listAssigned(actor: RequestAccessActor): Promise<readonly P3TaskReadDto[]> {
    const access = authorize(actor);
    let rows: readonly P3TaskReadRow[];
    try {
      rows = await this.repository.listAssigned({
        organizationId: actor.organizationId,
        userId: actor.userId,
        isFounder: access.isFounder,
        actorRole: access.actorRole,
      });
    } catch (error) {
      if (error instanceof P3TaskReadError) throw error;
      throw new P3TaskReadError("UNAVAILABLE");
    }
    return Object.freeze(rows.map((row) => project(row, actor)));
  }
}

function authorize(actor: RequestAccessActor): Readonly<{ isFounder: boolean; actorRole: "founder" | "advisor" | "contractor" }> {
  if (!actor || !UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, "tasks.read")) {
    throw new P3TaskReadError("FORBIDDEN");
  }
  const roles = actor.roles ?? [];
  const isFounder = roles.includes("founder");
  const actorRole = isFounder ? "founder" : roles.includes("advisor") ? "advisor" : roles.includes("contractor") ? "contractor" : null;
  if (actorRole === null) throw new P3TaskReadError("FORBIDDEN");
  return Object.freeze({ isFounder, actorRole });
}

function project(row: P3TaskReadRow, actor: RequestAccessActor): P3TaskReadDto {
  if (!UUID.test(row.id) || !["application_prepare_submit", "interview_support", "manual"].includes(row.task_kind) ||
      (row.school_target_id !== null && !UUID.test(row.school_target_id)) ||
      !Number.isSafeInteger(Number(row.record_version)) || Number(row.record_version) < 1 ||
      !Number.isFinite(Date.parse(row.due_at))) {
    throw new P3TaskReadError("UNAVAILABLE");
  }
  const current = row.current_assignment === null ? null : Object.freeze({
    id: row.current_assignment.id,
    assignee_user_id: row.current_assignment.assignee_user_id,
    assignee_role: row.current_assignment.assignee_role,
    status: row.current_assignment.status,
  });
  return Object.freeze({
    id: row.id,
    task_kind: row.task_kind,
    school_target_id: row.school_target_id,
    state: row.state,
    due_at: row.due_at,
    is_overdue: row.is_overdue,
    record_version: Number(row.record_version),
    current_assignment: current,
    allowed_actions: allowedActions(row, actor.userId, actor.roles ?? []),
  });
}

function allowedActions(row: P3TaskReadRow, actorUserId: string, actorRoles: readonly string[]): readonly P3ReadAction[] {
  const actions: P3ReadAction[] = [];
  const assigned = row.current_assignment?.assignee_user_id === actorUserId;
  const owner = row.owner_user_id === actorUserId;
  if (row.state === "assigned" && assigned) actions.push("accept", "reject");
  if (row.state === "accepted" && assigned) actions.push("complete");
  if (row.state === "assigned" && row.current_assignment === null && owner &&
      row.task_kind === "application_prepare_submit" && actorRoles.includes("advisor")) actions.push("reassign");
  if (owner && !["completed", "cancelled", "rejected"].includes(row.state)) actions.push("cancel");
  return Object.freeze(actions);
}
