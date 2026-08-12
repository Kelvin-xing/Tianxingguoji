"use client";

import { useMemo, useState } from "react";

import type { TaskState } from "@/modules/tasks/contract";

const ACTIONS_BY_STATE: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: [],
  assigned: ["accepted", "rejected", "reassigned", "cancelled"],
  accepted: ["completed", "reassigned", "cancelled"],
  rejected: [],
  reassigned: [],
  completed: ["approved"],
  approved: [],
  overdue: [],
  cancelled: [],
};

interface TaskTransitionControlsProps {
  readonly taskId: string;
  readonly state: TaskState;
  readonly recordVersion: number;
  readonly allowedActions?: readonly TaskState[];
}

export function TaskTransitionControls({
  taskId,
  state,
  recordVersion,
  allowedActions,
}: TaskTransitionControlsProps) {
  const [currentState, setCurrentState] = useState(state);
  const actions = ACTIONS_BY_STATE[currentState].filter(
    (action) => allowedActions === undefined || allowedActions.includes(action),
  );
  const [selectedAction, setSelectedAction] = useState<TaskState | null>(actions[0] ?? null);
  const [reason, setReason] = useState("");
  const [nextAssigneeUserId, setNextAssigneeUserId] = useState("");
  const [currentRecordVersion, setCurrentRecordVersion] = useState(recordVersion);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresAssignee = selectedAction === "reassigned";
  const submitLabel = useMemo(
    () => (selectedAction === null ? "No available transition" : `Move to ${selectedAction}`),
    [selectedAction],
  );

  if (actions.length === 0 || selectedAction === null) return null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/transitions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `task-transition-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          to: selectedAction,
          expected_record_version: currentRecordVersion,
          reason,
          next_assignee_user_id: requiresAssignee ? nextAssigneeUserId || null : null,
        }),
      });
      const payload = await response.json() as {
        readonly data?: { readonly record_version?: number; readonly state?: TaskState };
        readonly error?: { readonly message?: string };
      };
      if (
        !response.ok ||
        typeof payload.data?.record_version !== "number" ||
        payload.data.state === undefined
      ) {
        throw new Error(payload.error?.message ?? "Task transition was not accepted.");
      }
      setCurrentRecordVersion(payload.data.record_version);
      setCurrentState(payload.data.state);
      setSelectedAction(ACTIONS_BY_STATE[payload.data.state][0] ?? null);
      setReason("");
      setNextAssigneeUserId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Task transition was not accepted.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Task transition">
      <label className="block text-sm font-medium" htmlFor={`task-transition-${taskId}`}>
        Transition
      </label>
      <select
        id={`task-transition-${taskId}`}
        value={selectedAction}
        onChange={(event) => setSelectedAction(event.target.value as TaskState)}
        disabled={pending}
        className="w-full"
      >
        {actions.map((action) => <option key={action} value={action}>{action}</option>)}
      </select>
      {requiresAssignee ? (
        <label className="block text-sm font-medium" htmlFor={`task-assignee-${taskId}`}>
          Next assignee ID
          <input
            id={`task-assignee-${taskId}`}
            value={nextAssigneeUserId}
            onChange={(event) => setNextAssigneeUserId(event.target.value)}
            disabled={pending}
            required
            className="mt-1 w-full"
          />
        </label>
      ) : null}
      <label className="block text-sm font-medium" htmlFor={`task-reason-${taskId}`}>
        Reason
        <textarea
          id={`task-reason-${taskId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
          className="mt-1 w-full"
          rows={3}
        />
      </label>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <button type="submit" disabled={pending} className="primary-button">
        {pending ? "Updating" : submitLabel}
      </button>
    </form>
  );
}
