import type { IdentitySessionActor } from "../../identity/public.ts";
import { TASK_STATES, type TaskState } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 300;
const MAX_BRIEF_LENGTH = 4_000;

export interface ContractorTaskWorkspaceResult {
  readonly task_id: string;
  readonly title: string;
  readonly task_brief: string;
  readonly due_at: string;
  readonly state: TaskState;
  readonly record_version: number;
}

/**
 * This record is already a transaction-local redacted projection. The service
 * still reconstructs its public result field-by-field so adapter-added fields
 * cannot cross the API boundary at runtime.
 */
export interface ContractorTaskWorkspaceRecord extends ContractorTaskWorkspaceResult {}

export interface ContractorTaskWorkspaceRepositoryInput {
  readonly organizationId: string;
  readonly actor: IdentitySessionActor;
  readonly taskId: string;
}

export interface ContractorTaskWorkspaceRepository {
  /**
   * The HK RDS adapter must perform membership, Task, current assignment,
   * organization, actor-status, and task_only checks plus the redacted select
   * in one transaction. Revoke/reassign must therefore deny the next request.
   */
  getAssignedTaskWorkspace(
    input: ContractorTaskWorkspaceRepositoryInput,
  ): Promise<ContractorTaskWorkspaceRecord>;
}

export type ContractorTaskWorkspaceErrorCode =
  | "CONTRACTOR_TASK_INVALID"
  | "CONTRACTOR_TASK_FORBIDDEN"
  | "CONTRACTOR_TASK_NOT_FOUND"
  | "CONTRACTOR_TASK_PROJECTION_INVALID";

export class ContractorTaskWorkspaceError extends Error {
  readonly code: ContractorTaskWorkspaceErrorCode;

  constructor(code: ContractorTaskWorkspaceErrorCode) {
    super(`Contractor task workspace rejected ${code}.`);
    this.name = "ContractorTaskWorkspaceError";
    this.code = code;
  }
}

export class ContractorTaskWorkspaceService {
  private readonly repository: ContractorTaskWorkspaceRepository;

  constructor(options: { readonly repository: ContractorTaskWorkspaceRepository }) {
    this.repository = options.repository;
  }

  async getAssignedTask(input: {
    readonly actor: IdentitySessionActor;
    readonly taskId: string;
  }): Promise<ContractorTaskWorkspaceResult> {
    if (!UUID.test(input.taskId) || !UUID.test(input.actor.organizationId) || !UUID.test(input.actor.userId)) {
      throw new ContractorTaskWorkspaceError("CONTRACTOR_TASK_INVALID");
    }
    if (input.actor.role !== "contractor") {
      throw new ContractorTaskWorkspaceError("CONTRACTOR_TASK_FORBIDDEN");
    }

    const record = await this.repository.getAssignedTaskWorkspace({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      taskId: input.taskId,
    });
    assertProjection(record, input.taskId);

    return Object.freeze({
      task_id: record.task_id,
      title: record.title,
      task_brief: record.task_brief,
      due_at: record.due_at,
      state: record.state,
      record_version: record.record_version,
    });
  }
}

function assertProjection(record: ContractorTaskWorkspaceRecord, taskId: string): void {
  if (
    record.task_id !== taskId ||
    !isBoundedText(record.title, MAX_TITLE_LENGTH) ||
    !isBoundedText(record.task_brief, MAX_BRIEF_LENGTH) ||
    !isIsoInstant(record.due_at) ||
    !(TASK_STATES as readonly string[]).includes(record.state) ||
    !Number.isSafeInteger(record.record_version) ||
    record.record_version < 1
  ) {
    throw new ContractorTaskWorkspaceError("CONTRACTOR_TASK_PROJECTION_INVALID");
  }
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isIsoInstant(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
