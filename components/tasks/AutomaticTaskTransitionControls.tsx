"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import {
  TaskIdempotencyAttempt,
  automaticTaskTransitionFingerprint,
  classifyTaskFailure,
  completeApplicationTask,
  getTask,
  getTaskAssigneeOptions,
  transitionAutomaticTask,
  type AssignedTask,
  type AutomaticTaskAction,
  type CaseWorkspaceTask,
  type CompleteApplicationTaskInput,
  type TaskAssignee,
  type SubmissionChannel,
  type TaskDetailResult,
} from "@/modules/tasks/client";

type TaskItem = CaseWorkspaceTask | AssignedTask;
type Notice = "validation" | "stale" | "conflict" | "denied" | "unavailable" | null;
export type AutomaticTaskOutcome = "updated" | "target_completed" | "target_pending" | "stale";

const ACTION_LABELS: Readonly<Record<AutomaticTaskAction, string>> = {
  accept: "接受任務",
  reject: "拒絕任務",
  reassign: "重新指派",
  complete: "完成並記錄申請",
  cancel: "取消任務",
};

const CHANNEL_LABELS: Readonly<Record<SubmissionChannel, string>> = {
  school_portal: "學校申請平台",
  email: "電郵",
  courier: "速遞",
  in_person: "親身遞交",
  other: "其他",
};

export function AutomaticTaskTransitionControls({
  task,
  actorUserId,
  onAuthoritativeChange,
}: {
  readonly task: TaskItem;
  readonly actorUserId: string;
  readonly onAuthoritativeChange: (result: TaskDetailResult, outcome: AutomaticTaskOutcome) => void;
}) {
  const submitting = useRef(false);
  const attempt = useRef<TaskIdempotencyAttempt | null>(null);
  const actionSelect = useRef<HTMLSelectElement | null>(null);
  if (attempt.current === null) attempt.current = new TaskIdempotencyAttempt();

  const caseId = "case_id" in task ? task.case_id : null;
  const selectableActions = task.task_kind === "interview_support"
    ? task.allowed_actions.filter((action) => action !== "complete" && action !== "reassign")
    : task.allowed_actions.filter((action) => action !== "reassign" || caseId !== null);
  const interviewCompletionPending = task.task_kind === "interview_support" && task.allowed_actions.includes("complete");
  const [selectedAction, setSelectedAction] = useState<AutomaticTaskAction | "">("");
  const [reason, setReason] = useState("");
  const [nextAssigneeId, setNextAssigneeId] = useState("");
  const [assignees, setAssignees] = useState<readonly TaskAssignee[]>([]);
  const [assigneesLoading, setAssigneesLoading] = useState(false);
  const [submittedAt, setSubmittedAt] = useState("");
  const [confirmedAt, setConfirmedAt] = useState("");
  const [submissionChannel, setSubmissionChannel] = useState<SubmissionChannel>("school_portal");
  const [checklistComplete, setChecklistComplete] = useState(false);
  const [officialReference, setOfficialReference] = useState("");
  const [noReferenceDeclared, setNoReferenceDeclared] = useState(false);
  const [evidenceReference, setEvidenceReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [validationDetail, setValidationDetail] = useState<string | null>(null);

  useEffect(() => {
    if (selectedAction !== "reassign" || caseId === null) {
      queueMicrotask(() => {
        setAssignees([]);
        setAssigneesLoading(false);
      });
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => setAssigneesLoading(true));
    getTaskAssigneeOptions(caseId, controller.signal)
      .then((result) => setAssignees(result.assignees))
      .catch(() => {
        setAssignees([]);
        setNotice("unavailable");
      })
      .finally(() => setAssigneesLoading(false));
    return () => controller.abort();
  }, [caseId, selectedAction]);

  function commandChanged() {
    attempt.current!.rotate();
    setNotice(null);
    setValidationDetail(null);
    setConfirmed(false);
  }

  function resetForm(nextNotice: Notice) {
    setSelectedAction("");
    setReason("");
    setNextAssigneeId("");
    setSubmittedAt("");
    setConfirmedAt("");
    setSubmissionChannel("school_portal");
    setChecklistComplete(false);
    setOfficialReference("");
    setNoReferenceDeclared(false);
    setEvidenceReference("");
    setConfirmed(false);
    setNotice(nextNotice);
    setValidationDetail(null);
    queueMicrotask(() => actionSelect.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || selectedAction === "") return;
    const commandConfirmed = new FormData(event.currentTarget).has("command_confirmed");
    if (!commandConfirmed) {
      setValidationDetail("請先勾選確認執行這項操作。");
      setNotice("validation");
      return;
    }
    const completionInput = selectedAction === "complete" ? buildCompletionInput(event.currentTarget) : null;
    if ((["reject", "reassign", "cancel"] as const).includes(selectedAction as "reject" | "reassign" | "cancel") && reason.trim() === "" ||
        (selectedAction === "reassign" && nextAssigneeId === "") ||
        (selectedAction === "complete" && completionInput === null)) {
      setNotice("validation");
      return;
    }

    const input = completionInput ?? (selectedAction === "accept"
      ? { action: "accept", expected_record_version: task.record_version } as const
      : selectedAction === "reassign"
        ? { action: "reassign", expected_record_version: task.record_version, reason: reason.trim(), next_assignee_user_id: nextAssigneeId } as const
        : { action: selectedAction as "reject" | "cancel", expected_record_version: task.record_version, reason: reason.trim() } as const);
    submitting.current = true;
    setPending(true);
    setNotice(null);
    try {
      const key = attempt.current!.keyFor(automaticTaskTransitionFingerprint(task.id, input));
      if (input.action === "complete") {
        const receipt = await completeApplicationTask(task.id, task.school_target_id!, input, key);
        const authoritative = await getTask(task.id);
        if (authoritative.task.id !== receipt.id || authoritative.task.record_version !== receipt.record_version) {
          throw new TypeError("Task authority mismatch.");
        }
        attempt.current!.complete();
        resetForm(null);
        onAuthoritativeChange(
          authoritative,
          receipt.automation.target_transition === "pending" ? "target_pending" : "target_completed",
        );
        return;
      }
      const receipt = await transitionAutomaticTask(task.id, input, key);
      const authoritative = await getTask(task.id);
      if (authoritative.task.id !== receipt.id || authoritative.task.record_version !== receipt.record_version) {
        throw new TypeError("Task authority mismatch.");
      }
      attempt.current!.complete();
      resetForm(null);
      onAuthoritativeChange(authoritative, "updated");
    } catch (error) {
      const failure = classifyTaskFailure(error);
      if (failure === "stale") {
        attempt.current!.rotate();
        try {
          const authoritative = await getTask(task.id);
          resetForm("stale");
          onAuthoritativeChange(authoritative, "stale");
        } catch {
          setNotice("unavailable");
        }
      } else {
        if (failure !== "unavailable") attempt.current!.rotate();
        setNotice(
          failure === "validation" ? "validation"
            : failure === "conflict" ? "conflict"
              : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
                : "unavailable",
        );
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function buildCompletionInput(form: HTMLFormElement): CompleteApplicationTaskInput | null {
    const formData = new FormData(form);
    const submittedValue = formData.get("submitted_at");
    const confirmedValue = formData.get("confirmed_at");
    const channelValue = formData.get("submission_channel");
    const referenceValue = formData.get("official_reference");
    const evidenceValue = formData.get("evidence_reference");
    if (task.task_kind !== "application_prepare_submit" || task.school_target_id === null) {
      setValidationDetail("這項申請任務缺少學校目標資料，暫時不能完成。");
      return null;
    }
    if (typeof submittedValue !== "string" || typeof confirmedValue !== "string" ||
        typeof channelValue !== "string" || !(channelValue in CHANNEL_LABELS) ||
        !formData.has("checklist_complete")) {
      setValidationDetail("請填妥提交時間、提交渠道、核對時間，並確認資料已完成。");
      return null;
    }
    const submittedIso = localDateTimeToIso(submittedValue);
    const confirmedIso = localDateTimeToIso(confirmedValue);
    if (submittedIso === null || confirmedIso === null || Date.parse(submittedIso) > Date.now() || Date.parse(confirmedIso) > Date.now()) {
      setValidationDetail("提交時間與核對時間必須是有效且不晚於目前的香港時間。");
      return null;
    }
    const reference = typeof referenceValue === "string" ? referenceValue.trim() : "";
    const evidence = typeof evidenceValue === "string" ? evidenceValue.trim() : "";
    const noReference = formData.has("no_reference_declared");
    if ((!noReference && reference === "") || (noReference && (reference !== "" || !isUuid(evidence))) ||
        (evidence !== "" && !isUuid(evidence))) {
      setValidationDetail("請填寫官方提交編號；如學校沒有編號，須改為勾選無編號並提供有效的證據文件識別碼。");
      return null;
    }
    setValidationDetail(null);
    return {
      action: "complete",
      expected_record_version: task.record_version,
      completion_record: {
        submitted_at: submittedIso,
        submission_channel: channelValue as SubmissionChannel,
        submitter_user_id: actorUserId,
        checklist_snapshot: {
          all_required_items_complete: true,
          confirmed_at: confirmedIso,
        },
        official_submission_reference: noReference ? null : reference,
        no_reference_declared: noReference,
      },
      evidence_reference: evidence === "" ? null : evidence,
    };
  }

  if (selectableActions.length === 0 && !interviewCompletionPending) return null;

  return (
    <section className="workspace-section space-y-4" aria-labelledby="automatic-task-transition-heading">
      <div>
        <h3 id="automatic-task-transition-heading" className="section-title">處理自動任務</h3>
        <p className="section-detail">可用操作會隨任務狀態更新。</p>
      </div>
      {interviewCompletionPending ? (
        <div className="inline-callout" role="status">
          <Icon name="clock" size={15} />
          <span>面試完成記錄尚未開放；可先處理接受、拒絕或取消。</span>
        </div>
      ) : null}
      {selectableActions.length > 0 ? (
        <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
          <label className="field-label" htmlFor={`automatic-task-action-${task.id}`}>
            操作
            <select
              ref={actionSelect}
              id={`automatic-task-action-${task.id}`}
              value={selectedAction}
              disabled={pending}
              required
              onChange={(event) => {
                commandChanged();
                setSelectedAction(event.target.value as AutomaticTaskAction | "");
                setReason("");
                setNextAssigneeId("");
              }}
            >
              <option value="">選擇操作</option>
              {selectableActions.map((action) => <option value={action} key={action}>{ACTION_LABELS[action]}</option>)}
            </select>
          </label>

          {selectedAction === "reject" || selectedAction === "cancel" ? (
            <label className="field-label" htmlFor={`automatic-task-reason-${task.id}`}>
              原因 <span aria-hidden="true">*</span>
              <textarea
                id={`automatic-task-reason-${task.id}`}
                value={reason}
                maxLength={4_000}
                rows={3}
                required
                disabled={pending}
                onChange={(event) => { commandChanged(); setReason(event.target.value); }}
              />
            </label>
          ) : null}

          {selectedAction === "reassign" ? (
            <label className="field-label" htmlFor={`automatic-task-assignee-${task.id}`}>
              新的負責人 <span aria-hidden="true">*</span>
              <select
                id={`automatic-task-assignee-${task.id}`}
                value={nextAssigneeId}
                disabled={pending || assigneesLoading}
                required
                onChange={(event) => { commandChanged(); setNextAssigneeId(event.target.value); }}
              >
                <option value="">{assigneesLoading ? "正在載入負責人" : "選擇負責人"}</option>
                {assignees
                  .filter((assignee) => task.task_kind === "application_prepare_submit" || assignee.role === "advisor")
                  .map((assignee) => (
                  <option value={assignee.id} key={assignee.id}>{assignee.label} · {assignee.role === "advisor" ? "顧問" : "外部協作人員"}</option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedAction === "complete" && task.task_kind === "application_prepare_submit" ? (
            <ApplicationCompletionFields
              taskId={task.id}
              values={{ submittedAt, confirmedAt, submissionChannel, checklistComplete, officialReference, noReferenceDeclared, evidenceReference }}
              pending={pending}
              onChange={(field, value) => {
                commandChanged();
                if (field === "submittedAt") setSubmittedAt(value as string);
                else if (field === "confirmedAt") setConfirmedAt(value as string);
                else if (field === "submissionChannel") setSubmissionChannel(value as SubmissionChannel);
                else if (field === "checklistComplete") setChecklistComplete(value as boolean);
                else if (field === "officialReference") { setOfficialReference(value as string); if ((value as string).trim() !== "") setNoReferenceDeclared(false); }
                else if (field === "noReferenceDeclared") { setNoReferenceDeclared(value as boolean); if (value) setOfficialReference(""); }
                else setEvidenceReference(value as string);
              }}
            />
          ) : null}

          {selectedAction ? (
            <label className="flex items-start gap-3 text-sm">
              <input name="command_confirmed" type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => { attempt.current!.rotate(); setNotice(null); setConfirmed(event.target.checked); }} />
              <span>我確認執行「{ACTION_LABELS[selectedAction]}」，並儲存這次處理記錄。</span>
            </label>
          ) : null}

          <AutomaticTransitionNotice notice={notice} validationDetail={validationDetail} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" className="secondary-button justify-center" disabled={pending} onClick={() => { attempt.current!.complete(); resetForm(null); }}>重設</button>
            <button type="submit" className="primary-button justify-center min-w-36" disabled={pending || selectedAction === ""} aria-busy={pending}>
              <Icon name={pending ? "clock" : "check"} size={15} />{pending ? "正在更新" : "確認更新"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function ApplicationCompletionFields({ taskId, values, pending, onChange }: {
  readonly taskId: string;
  readonly values: Readonly<{
    submittedAt: string; confirmedAt: string; submissionChannel: SubmissionChannel;
    checklistComplete: boolean; officialReference: string; noReferenceDeclared: boolean; evidenceReference: string;
  }>;
  readonly pending: boolean;
  readonly onChange: (field: keyof typeof values, value: string | boolean) => void;
}) {
  return (
    <fieldset className="space-y-4 border-y py-4" style={{ borderColor: "var(--border)" }}>
      <legend className="section-title px-1">申請提交記錄</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="field-label" htmlFor={`task-submitted-at-${taskId}`}>提交時間 <span aria-hidden="true">*</span>
          <input id={`task-submitted-at-${taskId}`} name="submitted_at" type="datetime-local" value={values.submittedAt} disabled={pending} required onInput={(event) => onChange("submittedAt", event.currentTarget.value)} onBlur={(event) => onChange("submittedAt", event.currentTarget.value)} onChange={(event) => onChange("submittedAt", event.target.value)} />
        </label>
        <label className="field-label" htmlFor={`task-submission-channel-${taskId}`}>提交渠道 <span aria-hidden="true">*</span>
          <select id={`task-submission-channel-${taskId}`} name="submission_channel" value={values.submissionChannel} disabled={pending} required onChange={(event) => onChange("submissionChannel", event.target.value)}>
            {Object.entries(CHANNEL_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input name="checklist_complete" type="checkbox" checked={values.checklistComplete} disabled={pending} required onChange={(event) => onChange("checklistComplete", event.target.checked)} />
        <span>所有必需申請資料已完成並核對。</span>
      </label>
      <label className="field-label" htmlFor={`task-checklist-confirmed-at-${taskId}`}>核對完成時間 <span aria-hidden="true">*</span>
        <input id={`task-checklist-confirmed-at-${taskId}`} name="confirmed_at" type="datetime-local" value={values.confirmedAt} disabled={pending} required onInput={(event) => onChange("confirmedAt", event.currentTarget.value)} onBlur={(event) => onChange("confirmedAt", event.currentTarget.value)} onChange={(event) => onChange("confirmedAt", event.target.value)} />
      </label>
      <label className="field-label" htmlFor={`task-official-reference-${taskId}`}>學校官方提交編號
        <input id={`task-official-reference-${taskId}`} name="official_reference" type="text" value={values.officialReference} disabled={pending || values.noReferenceDeclared} onChange={(event) => onChange("officialReference", event.target.value)} />
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input name="no_reference_declared" type="checkbox" checked={values.noReferenceDeclared} disabled={pending} onChange={(event) => onChange("noReferenceDeclared", event.target.checked)} />
        <span>學校沒有提供官方提交編號。</span>
      </label>
      <label className="field-label" htmlFor={`task-evidence-reference-${taskId}`}>
        證據文件識別碼{values.noReferenceDeclared ? <span aria-hidden="true"> *</span> : null}
        <input id={`task-evidence-reference-${taskId}`} name="evidence_reference" type="text" value={values.evidenceReference} disabled={pending} required={values.noReferenceDeclared} inputMode="text" autoComplete="off" onChange={(event) => onChange("evidenceReference", event.target.value)} />
        <small>沒有官方編號時，必須引用一份已授權且通過檢查的案件文件。</small>
      </label>
      <div className="inline-callout">
        <Icon name="shield" size={15} /><span>提交人會使用目前登入帳號自動記錄，不能在此更改。</span>
      </div>
    </fieldset>
  );
}

function AutomaticTransitionNotice({ notice, validationDetail }: { readonly notice: Notice; readonly validationDetail: string | null }) {
  if (notice === null) return null;
  const message = notice === "validation" ? validationDetail ?? "請填妥所有必填資料；時間不能在未來，官方編號與無編號聲明只能選一項。"
    : notice === "stale" ? "任務已有較新版本，已重新載入最新內容。"
      : notice === "conflict" ? "目前狀態不接受這項操作，請重新確認。"
        : notice === "denied" ? "目前帳號不能執行這項任務操作。"
          : "結果暫時無法確認，請稍後重試；重試不會重複更新。";
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}</span></div>;
}

function localDateTimeToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
