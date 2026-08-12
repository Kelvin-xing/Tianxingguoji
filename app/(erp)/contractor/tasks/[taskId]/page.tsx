import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { TaskTransitionControls } from "@/components/tasks/TaskTransitionControls";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import {
  ContractorTaskWorkspaceError,
  type ContractorTaskWorkspaceResult,
} from "@/modules/tasks/contractor-workspace";
import {
  ContractorTaskWorkspaceRuntimeUnavailable,
  getContractorTaskWorkspaceRuntime,
} from "@/modules/tasks/contractor-workspace-runtime";
import {
  CONTRACTOR_TASK_ALLOWED_TRANSITIONS,
  buildContractorTaskWorkspaceModel,
} from "@/modules/tasks/contractor-workspace-model";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly taskId: string }>;
}

export default async function ContractorTaskPage({ params }: PageProps) {
  if (process.env.CONTRACTOR_TASK_WORKSPACE_ENABLED !== "true") notFound();

  const { taskId } = await params;
  if (!isUuid(taskId)) notFound();

  let task: ContractorTaskWorkspaceResult;
  try {
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) redirect("/login");
    const actor = await getIdentityRuntime().service.requireSession({
      cookieSecret,
      sensitiveAction: false,
    });
    if (actor.role !== "contractor") notFound();
    task = await getContractorTaskWorkspaceRuntime().service.getAssignedTask({ actor, taskId });
  } catch (error) {
    if (error instanceof IdentityServiceError) redirect("/login");
    if (
      error instanceof IdentityRuntimeUnavailable ||
      error instanceof ContractorTaskWorkspaceRuntimeUnavailable ||
      (error instanceof ContractorTaskWorkspaceError &&
        error.code === "CONTRACTOR_TASK_PROJECTION_INVALID")
    ) {
      return <UnavailableTaskWorkspace />;
    }
    if (error instanceof ContractorTaskWorkspaceError) notFound();
    throw error;
  }

  const model = buildContractorTaskWorkspaceModel(task);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="border-b pb-5" style={{ borderColor: "var(--border)" }}>
        <p className="eyebrow">My task</p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="page-title min-w-0 break-words">{model.title}</h1>
          <span className="status-pill shrink-0">{model.stateLabel}</span>
        </div>
      </header>

      <section aria-labelledby="task-brief-heading" className="space-y-4">
        <div>
          <h2 id="task-brief-heading" className="section-title">Task brief</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
            {model.brief}
          </p>
        </div>
        <dl className="grid gap-3 border-y py-4 sm:grid-cols-2" style={{ borderColor: "var(--border)" }}>
          <div>
            <dt className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Due</dt>
            <dd className="mt-1 break-words text-sm" style={{ color: "var(--text-primary)" }}>
              <time dateTime={model.dueLabel}>{model.dueLabel}</time>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Status</dt>
            <dd className="mt-1 text-sm" style={{ color: "var(--text-primary)" }}>{model.stateLabel}</dd>
          </div>
        </dl>
      </section>

      {model.actions.length > 0 ? (
        <section aria-labelledby="task-action-heading" className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
          <h2 id="task-action-heading" className="section-title mb-4">Update task</h2>
          <TaskTransitionControls
            taskId={model.taskId}
            state={model.state}
            recordVersion={model.recordVersion}
            allowedActions={CONTRACTOR_TASK_ALLOWED_TRANSITIONS}
          />
        </section>
      ) : null}
    </div>
  );
}

function UnavailableTaskWorkspace() {
  return (
    <div className="mx-auto max-w-3xl" role="status">
      <h1 className="page-title">Task workspace unavailable</h1>
      <p className="page-subtitle">The assigned task cannot be loaded right now.</p>
    </div>
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
