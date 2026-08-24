"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import { useCaseWorkflowContext } from "@/components/cases/CaseWorkflowContext";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  CaseWorkflowIdempotencyAttempt,
  classifyCaseRequestFailure,
  executeCaseWorkflowAction,
  getCase,
  type CaseWorkflowAction,
  type CaseWorkflowStatus,
  type CaseWorkspaceStage,
} from "@/modules/cases/client";

interface CaseWorkflowControlsProps {
  readonly caseId: string;
  readonly initialStage: CaseWorkspaceStage;
  readonly initialWorkflowStatus: CaseWorkflowStatus;
  readonly initialRecordVersion: number;
  readonly initialAvailableWorkflowActions: readonly CaseWorkflowAction[];
}

type AccessState = "loading" | "manage" | "read_only" | "unavailable";
type Feedback = Readonly<{
  kind: "success" | "stale" | "validation" | "conflict" | "unavailable";
  message: string;
}> | null;

export function CaseWorkflowControls({
  caseId,
  initialStage,
  initialWorkflowStatus,
  initialRecordVersion,
  initialAvailableWorkflowActions,
}: CaseWorkflowControlsProps) {
  const { setAuthoritativeWorkflowStatus } = useCaseWorkflowContext();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submissionLocked = useRef(false);
  const attempt = useRef(new CaseWorkflowIdempotencyAttempt());
  const [accessState, setAccessState] = useState<AccessState>("loading");
  const [stage, setStage] = useState(initialStage);
  const [workflowStatus, setWorkflowStatus] = useState(initialWorkflowStatus);
  const [recordVersion, setRecordVersion] = useState(initialRecordVersion);
  const [availableActions, setAvailableActions] = useState(initialAvailableWorkflowActions);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    const controller = new AbortController();
    getWorkspaceAccessSnapshot(controller.signal)
      .then((access) => {
        setAccessState(access.capabilities.some(
          (capability) => String(capability) === "cases.workflow.manage",
        ) ? "manage" : "read_only");
      })
      .catch(() => {
        if (!controller.signal.aborted) setAccessState("unavailable");
      });
    return () => controller.abort();
  }, []);

  async function submit(action: "pause" | "resume") {
    if (submissionLocked.current || accessState !== "manage") return;
    const normalizedReason = action === "pause" ? reason.trim() : null;
    if (action === "pause" && (!normalizedReason || normalizedReason.length > 1000)) {
      setFeedback({ kind: "validation", message: "請填寫 1 至 1000 字的暫停原因。" });
      return;
    }
    const command = {
      action,
      expected_record_version: recordVersion,
      reason: normalizedReason,
    } as const;
    submissionLocked.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const receipt = await executeCaseWorkflowAction(
        caseId,
        command,
        attempt.current.keyFor(command),
      );
      const authoritative = await getCase(caseId);
      if (
        receipt.id !== authoritative.id ||
        receipt.record_version !== authoritative.recordVersion
      ) {
        throw new TypeError("Workflow receipt does not match authoritative Case.");
      }
      applyAuthoritative(authoritative);
      attempt.current.complete();
      setReason("");
      setFeedback({
        kind: "success",
        message: action === "pause"
          ? "案件已暫停，內容已重新載入。"
          : "案件已恢復，內容已重新載入。",
      });
      headingRef.current?.focus();
    } catch (error: unknown) {
      const failure = classifyCaseRequestFailure(error);
      if (failure === "stale") {
        try {
          const authoritative = await getCase(caseId);
          applyAuthoritative(authoritative);
          attempt.current.complete();
          setFeedback({ kind: "stale", message: "案件已被其他人更新，已重新載入目前版本。" });
        } catch {
          setFeedback({ kind: "unavailable", message: "目前無法重新載入案件，請稍後重試。" });
        }
      } else if (failure === "validation") {
        setFeedback({ kind: "validation", message: "暫停原因未通過檢查，請修正後重試。" });
      } else if (failure === "conflict") {
        setFeedback({ kind: "conflict", message: "案件目前的狀態不允許這個操作。" });
      } else {
        setFeedback({ kind: "unavailable", message: "案件流程服務暫時不可用；重試不會重複操作。" });
      }
    } finally {
      submissionLocked.current = false;
      setPending(false);
    }
  }

  function applyAuthoritative(authoritative: Awaited<ReturnType<typeof getCase>>) {
    setStage(authoritative.stage);
    setWorkflowStatus(authoritative.workflowStatus);
    setRecordVersion(authoritative.recordVersion);
    setAvailableActions(authoritative.availableWorkflowActions);
    setAuthoritativeWorkflowStatus(authoritative.workflowStatus);
  }

  const canPause = accessState === "manage" && availableActions.includes("pause");
  const canResume = accessState === "manage" && availableActions.includes("resume");
  const pauseReasonValid = reason.trim().length >= 1 && reason.trim().length <= 1000;

  return (
    <section className="workspace-section" aria-labelledby="case-workflow-command-title" aria-busy={pending}>
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <h3
            ref={headingRef}
            id="case-workflow-command-title"
            className="section-title"
            tabIndex={-1}
          >
            案件流程
          </h3>
          <p className="section-detail">
            {stageLabel(stage)} · {workflowStatusLabel(workflowStatus)} · 案件版本 {recordVersion}
          </p>
        </div>
        <span className={`status-pill ${workflowStatus === "paused" ? "status-warning" : "status-success"}`}>
          {workflowStatusLabel(workflowStatus)}
        </span>
      </div>

      {accessState === "loading" ? (
        <div className="inline-callout mt-4"><Icon name="clock" size={15} /><span>正在確認流程操作權限。</span></div>
      ) : null}
      {accessState === "unavailable" ? (
        <div className="inline-callout warning mt-4" role="alert"><Icon name="x" size={15} /><span>暫時無法確認流程操作權限。</span></div>
      ) : null}
      {accessState === "read_only" ? (
        <div className="inline-callout mt-4"><Icon name="shield" size={15} /><span>你目前可以查看案件流程，但沒有暫停或恢復權限。</span></div>
      ) : null}

      {canPause ? (
        <form
          className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (pauseReasonValid) void submit("pause");
          }}
        >
          <label className="block min-w-0 text-sm font-medium" htmlFor="case-workflow-pause-reason">
            暫停原因
            <textarea
              id="case-workflow-pause-reason"
              className="mt-1 min-h-20 w-full min-w-0"
              value={reason}
              minLength={1}
              maxLength={1000}
              required
              disabled={pending}
              onChange={(event) => {
                setReason(event.target.value);
                setFeedback(null);
              }}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={!pauseReasonValid || pending}>
            <Icon name={pending ? "clock" : "activity"} size={15} />
            {pending ? "處理中…" : "暫停案件"}
          </button>
        </form>
      ) : null}

      {canResume ? (
        <button
          type="button"
          className="primary-button mt-4"
          disabled={pending}
          onClick={() => void submit("resume")}
        >
          <Icon name={pending ? "clock" : "arrow-right"} size={15} />
          {pending ? "處理中…" : "恢復案件"}
        </button>
      ) : null}

      {feedback ? (
        <div
          className={`inline-callout mt-4 ${feedback.kind === "success" ? "" : "warning"}`}
          role={feedback.kind === "success" ? "status" : "alert"}
        >
          <Icon name={feedback.kind === "success" ? "check-circle" : "activity"} size={15} />
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </section>
  );
}

function stageLabel(stage: CaseWorkspaceStage): string {
  if (stage === "signed") return "已簽約";
  if (stage === "background_collection") return "背景資料收集";
  if (stage === "school_selection_confirmed") return "選校已確認";
  if (stage === "application_in_progress") return "申請處理中";
  return "已結案";
}

function workflowStatusLabel(status: CaseWorkflowStatus): string {
  if (status === "active") return "進行中";
  if (status === "paused") return "已暫停";
  if (status === "termination_pending") return "待終止結案";
  return "已結案";
}
