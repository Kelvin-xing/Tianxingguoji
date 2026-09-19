import { notificationEffectForEvent } from "./service.ts";

export const DUE_NOTIFICATION_EVENT_TYPES = Object.freeze([
  "tasks.due_3d",
  "tasks.due_1d",
  "tasks.overdue",
] as const);

export type DueNotificationEventType = (typeof DUE_NOTIFICATION_EVENT_TYPES)[number];

export interface DueNotificationCandidate {
  readonly taskId: string;
  readonly organizationId: string;
  readonly recordVersion: number;
  readonly dueAt: string;
  readonly eventType: DueNotificationEventType;
  readonly businessDate: string;
}

export interface DueNotificationScheduleRepository {
  listDueNotificationCandidates(input: Readonly<{
    readonly organizationId: string;
    readonly nowMs: number;
  }>): Promise<readonly DueNotificationCandidate[]>;
  scheduleDueNotification(input: Readonly<{
    readonly candidate: DueNotificationCandidate;
    readonly scheduledAtMs: number;
  }>): Promise<"created" | "duplicate">;
}

export interface DueNotificationSchedulerOptions {
  readonly repository: DueNotificationScheduleRepository;
}

export interface DueNotificationScheduleResult {
  readonly scanned: number;
  readonly created: number;
  readonly duplicates: number;
}

/** Produces deterministic daily due/overdue events; delivery remains owned by the notification worker. */
export class DueNotificationScheduler {
  private readonly repository: DueNotificationScheduleRepository;

  constructor(options: DueNotificationSchedulerOptions) {
    this.repository = options.repository;
  }

  async runOnce(input: Readonly<{
    readonly organizationId: string;
    readonly nowMs?: number;
  }>): Promise<DueNotificationScheduleResult> {
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new DueNotificationSchedulerError("DUE_NOTIFICATION_INVALID_TIME");
    }
    const candidates = await this.repository.listDueNotificationCandidates({
      organizationId: input.organizationId,
      nowMs,
    });
    let created = 0;
    let duplicates = 0;
    for (const candidate of candidates) {
      assertCandidate(candidate, input.organizationId);
      const result = await this.repository.scheduleDueNotification({ candidate, scheduledAtMs: nowMs });
      if (result === "created") created += 1;
      else duplicates += 1;
    }
    return Object.freeze({ scanned: candidates.length, created, duplicates });
  }
}

export class DueNotificationSchedulerError extends Error {
  readonly code: "DUE_NOTIFICATION_INVALID_TIME" | "DUE_NOTIFICATION_INVALID_CANDIDATE";

  constructor(code: "DUE_NOTIFICATION_INVALID_TIME" | "DUE_NOTIFICATION_INVALID_CANDIDATE") {
    super(code);
    this.name = "DueNotificationSchedulerError";
    this.code = code;
  }
}

export function dueNotificationEffectType(eventType: DueNotificationEventType): string {
  return notificationEffectForEvent(eventType);
}

function assertCandidate(candidate: DueNotificationCandidate, organizationId: string): void {
  if (
    candidate.organizationId !== organizationId ||
    !UUID.test(candidate.taskId) ||
    !UUID.test(candidate.organizationId) ||
    !Number.isSafeInteger(candidate.recordVersion) ||
    candidate.recordVersion < 1 ||
    !DUE_NOTIFICATION_EVENT_TYPES.includes(candidate.eventType) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(candidate.businessDate) ||
    !Number.isFinite(Date.parse(candidate.dueAt))
  ) {
    throw new DueNotificationSchedulerError("DUE_NOTIFICATION_INVALID_CANDIDATE");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
