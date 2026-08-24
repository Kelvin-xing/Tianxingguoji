"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import {
  CaseAssessmentIdempotencyAttempt,
  classifyCaseRequestFailure,
  completeCaseAssessmentBackground,
  getCaseAssessment,
  updateCaseAssessmentAnswer,
  type AssessmentAnswerView,
  type AssessmentSemanticState,
  type AssessmentValueType,
  type CaseAssessmentView,
  type CaseWorkspaceStage,
} from "@/modules/cases/client";

export type AssessmentEditorView = CaseAssessmentView;

interface DraftAnswer {
  readonly semanticState: AssessmentSemanticState;
  readonly value: string | readonly string[];
  readonly recordVersion: number;
}

interface ConflictState {
  readonly fieldId: string;
  readonly current: DraftAnswer;
  readonly draft: DraftAnswer;
}

/**
 * The editor renders only server-supplied fields. It keeps failed drafts in
 * local state so a stale response cannot discard an operator's changes.
 */
export function AssessmentEditor({
  caseId,
  caseStage,
}: {
  readonly caseId: string;
  readonly caseStage: CaseWorkspaceStage;
}) {
  const submissionLocks = useRef(new Set<string>());
  const answerAttempts = useRef(new Map<string, CaseAssessmentIdempotencyAttempt>());
  const completionAttempt = useRef(new CaseAssessmentIdempotencyAttempt());
  const [view, setView] = useState<AssessmentEditorView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [loadState, setLoadState] = useState<"loading" | "ready" | "denied" | "unavailable">("loading");
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadState("loading");
      setNotice(null);
      getCaseAssessment(caseId, controller.signal)
        .then((latest) => {
          setView(latest);
          setDrafts(createDrafts(latest));
          setLoadState("ready");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const failure = classifyCaseRequestFailure(error);
          setLoadState(failure === "forbidden" || failure === "not_found" ? "denied" : "unavailable");
        });
    });
    return () => controller.abort();
  }, [caseId]);

  if (!view || loadState !== "ready") {
    return (
      <section className="workspace-section" aria-labelledby="assessment-editor-title" aria-busy={loadState === "loading"}>
        <h3 id="assessment-editor-title" tabIndex={-1} className="section-title">學生評估</h3>
        {loadState === "loading" ? <div className="inline-callout mt-4"><Icon name="clock" size={15} /><span>正在載入評估內容。</span></div> : null}
        {loadState === "denied" ? <div className="inline-callout warning mt-4" role="alert"><Icon name="shield" size={15} /><span>無法查看這份評估。</span></div> : null}
        {loadState === "unavailable" ? <div className="inline-callout warning mt-4" role="alert"><Icon name="x" size={15} /><span>評估服務暫時不可用。</span></div> : null}
      </section>
    );
  }

  const editableFieldIds = new Set(view.access.editable_field_ids);
  const blockerSatisfiedFieldIds = new Set(view.answers
    .filter((answer) => answer.semantic_state === "provided")
    .map((answer) => answer.field_id));
  const blockingFieldIds = view.schema.fields
    .filter((field) => field.blocking_stages.includes("background_collection"))
    .map((field) => field.field_id);
  const completedBlockers = blockingFieldIds.filter(
    (fieldId) => blockerSatisfiedFieldIds.has(fieldId),
  ).length;
  const canComplete = caseStage === "background_collection" &&
    view.access.can_complete_background && view.status === "draft" &&
    completedBlockers === blockingFieldIds.length;

  async function save(field: AssessmentEditorView["schema"]["fields"][number]) {
    const draft = drafts[field.field_id];
    if (!draft || !editableFieldIds.has(field.field_id) || submissionLocks.current.has(field.field_id)) return;
    const typedValue = draft.semanticState === "provided" ? toTypedValue(field, draft.value) : null;
    const command = {
      field_id: field.field_id,
      semantic_state: draft.semanticState,
      value: typedValue,
      value_type: draft.semanticState === "provided" ? field.value_type : null,
      expected_record_version: draft.recordVersion,
    } as const;
    const attempt = answerAttempts.current.get(field.field_id) ?? new CaseAssessmentIdempotencyAttempt();
    answerAttempts.current.set(field.field_id, attempt);
    submissionLocks.current.add(field.field_id);
    setNotice(null);
    setSavingFieldId(field.field_id);
    try {
      const receipt = await updateCaseAssessmentAnswer(
        caseId,
        command,
        attempt.keyFor(assessmentCommandFingerprint(command)),
      );
      const latestView = await getCaseAssessment(caseId);
      const savedAnswer = latestView.answers.find((answer) => answer.field_id === field.field_id);
      if (
        receipt.id !== latestView.assessment_id ||
        savedAnswer?.record_version !== receipt.record_version ||
        savedAnswer.semantic_state !== command.semantic_state ||
        savedAnswer.value_type !== command.value_type ||
        !assessmentValueEquals(savedAnswer.value, command.value)
      ) {
        throw new TypeError("Assessment receipt does not match authoritative GET.");
      }
      attempt.complete();
      setView(latestView);
      setDrafts(createDrafts(latestView));
      setConflict(null);
      setNotice("已儲存。");
    } catch (error: unknown) {
      if (classifyCaseRequestFailure(error) === "stale") {
        try {
          const latestView = await getCaseAssessment(caseId);
          const current = createDrafts(latestView)[field.field_id];
          attempt.complete();
          setView(latestView);
          setDrafts((currentDrafts) => mergeDrafts(currentDrafts, latestView));
          if (current) setConflict({ fieldId: field.field_id, current, draft });
          setNotice("此欄位已被更新；請比較目前值與草稿後再確認。");
        } catch {
          setNotice("無法重新載入此欄位，草稿已保留。");
        }
      } else {
        setNotice("無法儲存此欄位，草稿已保留。");
      }
    } finally {
      submissionLocks.current.delete(field.field_id);
      setSavingFieldId(null);
    }
  }

  async function completeBackgroundCollection() {
    const lockKey = "background-completion";
    if (!canComplete || submissionLocks.current.has(lockKey)) return;
    const currentView = view;
    if (currentView === null) return;
    submissionLocks.current.add(lockKey);
    setNotice(null);
    setCompleting(true);
    try {
      const receipt = await completeCaseAssessmentBackground(
        caseId,
        currentView.record_version,
        completionAttempt.current.keyFor(`complete:${currentView.record_version}`),
      );
      const latestView = await getCaseAssessment(caseId);
      if (
        receipt.id !== latestView.assessment_id ||
        receipt.record_version !== latestView.record_version ||
        latestView.status !== "background_complete"
      ) {
        throw new TypeError("Assessment completion receipt does not match authoritative GET.");
      }
      completionAttempt.current.complete();
      setView(latestView);
      setDrafts(createDrafts(latestView));
      setNotice("背景資料收集已完成。");
    } catch (error: unknown) {
      const failure = classifyCaseRequestFailure(error);
      if (failure === "stale" || failure === "validation") {
        try {
          const latestView = await getCaseAssessment(caseId);
          completionAttempt.current.complete();
          setView(latestView);
          setDrafts((current) => mergeDrafts(current, latestView));
          setNotice(failure === "stale"
            ? "評估狀態已更新，已重新載入目前版本。"
            : "仍有背景資料尚未儲存，已重新計算進度。");
        } catch {
          setNotice("目前無法重新載入評估，已儲存的答案不受影響。");
        }
      } else {
        setNotice("目前無法完成背景資料收集，已儲存的答案不受影響。");
      }
    } finally {
      submissionLocks.current.delete(lockKey);
      setCompleting(false);
    }
  }

  return (
    <section className="workspace-section" aria-labelledby="assessment-editor-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
        <div>
          <h3 id="assessment-editor-title" tabIndex={-1} className="section-title">學生評估</h3>
          <p className="section-detail">{view.schema.fields.length} 項資料 · {assessmentStatusLabel(view.status)} · 評估版本 {view.record_version}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="status-pill">已儲存 {view.answers.length} / {view.schema.fields.length}</span>
          <span className={`status-pill ${canComplete || view.status !== "draft" ? "status-success" : "status-warning"}`}>
            背景必填 {completedBlockers} / {blockingFieldIds.length}
          </span>
        </div>
      </div>
      {!view.access.can_edit ? <div className="inline-callout mb-4"><Icon name="shield" size={15} /><span>你目前可以查看評估，但沒有編輯權限。</span></div> : null}
      {notice && <div className="inline-callout mb-4" role="status"><Icon name="activity" size={15} /><span>{notice}</span></div>}
      <div className="space-y-4">
        {view.schema.fields.map((field) => {
          const draft = drafts[field.field_id];
          const canEditField = editableFieldIds.has(field.field_id);
          if (!draft) return null;
          return (
            <div key={field.field_id} className="border-b pb-4 last:border-b-0 last:pb-0" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fieldLabel(field)}</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                    {layerLabel(field.layer)}
                    {field.blocking_stages.includes("background_collection") ? " · 背景收集必填" : " · 後續選校資料"}
                  </div>
                </div>
                <span className="inline-status" style={{ color: "var(--text-muted)" }}>v{draft.recordVersion}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,.6fr)_auto] gap-2 mt-3">
                <AssessmentValueControl
                  field={field}
                  draft={draft}
                  readOnly={!canEditField}
                  onChange={(value) => setDrafts((current) => ({
                    ...current,
                    [field.field_id]: { ...draft, value },
                  }))}
                />
                <select
                  aria-label={`${field.field_id} semantic state`}
                  className="assessment-control"
                  value={draft.semanticState}
                  disabled={!canEditField}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [field.field_id]: {
                      ...draft,
                      semanticState: event.target.value as AssessmentSemanticState,
                    },
                  }))}
                >
                  <option value="provided">已提供</option>
                  <option value="unknown">暫時未知</option>
                  <option value="not_applicable">不適用</option>
                  <option value="declined_to_provide">拒絕提供</option>
                </select>
                {canEditField ? <button
                  type="button"
                  className="primary-button"
                  disabled={savingFieldId === field.field_id}
                  onClick={() => void save(field)}
                >
                  <Icon name={savingFieldId === field.field_id ? "clock" : "check"} size={15} />
                  {savingFieldId === field.field_id ? "儲存中" : "儲存"}
                </button> : null}
              </div>
              {conflict?.fieldId === field.field_id && (
                <div className="inline-callout warning mt-3" role="alert">
                  <Icon name="clock" size={15} />
                  <div className="min-w-0 flex-1">
                    <div>目前值：{describeDraft(conflict.current)}</div>
                    <div className="mt-1">你的草稿：{describeDraft(conflict.draft)}</div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setDrafts((current) => ({ ...current, [field.field_id]: conflict.current }));
                          setConflict(null);
                        }}
                      >
                        採用目前值
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          setDrafts((current) => ({
                            ...current,
                            [field.field_id]: {
                              ...conflict.draft,
                              recordVersion: conflict.current.recordVersion,
                            },
                          }));
                          setConflict(null);
                        }}
                      >
                        保留草稿並重試
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-6 pt-5 border-t" style={{ borderColor: "var(--border-subtle)" }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>背景資料收集</div>
          <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {view.status === "draft"
              ? `尚需儲存 ${blockingFieldIds.length - completedBlockers} 個背景必填項目`
              : `目前狀態：${assessmentStatusLabel(view.status)}`}
          </div>
        </div>
        {caseStage === "background_collection" && view.access.can_complete_background ? <button
          type="button"
          className="primary-button"
          disabled={!canComplete || completing}
          onClick={() => void completeBackgroundCollection()}
        >
          <Icon name={completing ? "clock" : "check-circle"} size={15} />
          {completing ? "處理中" : view.status === "draft" ? "完成背景收集" : "背景收集已完成"}
        </button> : null}
      </div>
    </section>
  );
}

function assessmentCommandFingerprint(value: unknown): string {
  const fingerprint = JSON.stringify(value);
  if (typeof fingerprint !== "string" || fingerprint.length < 1) {
    throw new TypeError("Assessment command fingerprint is invalid.");
  }
  return fingerprint;
}

function assessmentValueEquals(
  current: AssessmentAnswerView["value"],
  submitted: AssessmentAnswerView["value"],
): boolean {
  if (current === null || submitted === null) return current === submitted;
  if (current.type !== submitted.type) return false;
  const currentArray = Array.isArray(current.value) ? current.value as readonly string[] : null;
  const submittedArray = Array.isArray(submitted.value) ? submitted.value as readonly string[] : null;
  if (currentArray !== null || submittedArray !== null) {
    return currentArray !== null && submittedArray !== null &&
      currentArray.length === submittedArray.length &&
      currentArray.every((value, index) => value === submittedArray[index]);
  }
  return current.value === submitted.value;
}

function createDrafts(view: AssessmentEditorView): Record<string, DraftAnswer> {
  const answerMap = new Map(view.answers.map((answer) => [answer.field_id, answer]));
  return Object.fromEntries(
    view.schema.fields.map((field) => {
      const answer = answerMap.get(field.field_id);
      return [
        field.field_id,
        {
          semanticState: answer?.semantic_state ?? "unknown",
          value: answer ? toDraft(answer).value : defaultDraftValue(field),
          recordVersion: answer?.record_version ?? 0,
        },
      ];
    }),
  );
}

function mergeDrafts(
  current: Record<string, DraftAnswer>,
  latestView: AssessmentEditorView,
): Record<string, DraftAnswer> {
  const latest = createDrafts(latestView);
  return Object.fromEntries(
    latestView.schema.fields.map((field) => {
      const local = current[field.field_id];
      const server = latest[field.field_id]!;
      return [
        field.field_id,
        local ? { ...local, recordVersion: server.recordVersion } : server,
      ];
    }),
  );
}

function toDraft(answer: AssessmentEditorView["answers"][number]): DraftAnswer {
  return {
    semanticState: answer.semantic_state,
    value: answer.semantic_state === "provided" ? toDraftValue(answer.value?.value) : "",
    recordVersion: answer.record_version,
  };
}

function describeDraft(draft: DraftAnswer): string {
  if (draft.semanticState !== "provided") return semanticStateLabel(draft.semanticState);
  return typeof draft.value === "string"
    ? enumValueLabel(draft.value) || "未填寫"
    : draft.value.map(enumValueLabel).join("、") || "未填寫";
}

function AssessmentValueControl({
  field,
  draft,
  readOnly,
  onChange,
}: {
  readonly field: AssessmentEditorView["schema"]["fields"][number];
  readonly draft: DraftAnswer;
  readonly readOnly: boolean;
  readonly onChange: (value: string | readonly string[]) => void;
}) {
  const disabled = readOnly || draft.semanticState !== "provided";
  if (field.value_type === "enum") {
    return (
      <select className="assessment-control" aria-label={`${field.field_id} value`} disabled={disabled} value={asText(draft.value)} onChange={(event) => onChange(event.target.value)}>
        <option value="">請選擇</option>
        {(field.enum_values ?? []).map((value) => <option key={value} value={value}>{enumValueLabel(value)}</option>)}
      </select>
    );
  }
  if (field.value_type === "enum_set") {
    const selected = typeof draft.value === "string" ? [] : draft.value;
    return (
      <fieldset aria-label={`${field.field_id} values`} disabled={disabled} className="assessment-control grid grid-cols-2 gap-x-3 gap-y-2">
        {(field.enum_values ?? []).map((value) => (
          <label key={value} className="flex min-w-0 items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, value]
                : selected.filter((entry) => entry !== value))}
            />
            <span>{enumValueLabel(value)}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <input
      className="assessment-control"
      type={field.value_type === "date" ? "date" : field.value_type === "integer" ? "number" : "text"}
      step={field.value_type === "integer" ? "1" : undefined}
      aria-label={`${field.field_id} value`}
      disabled={disabled}
      value={asText(draft.value)}
      placeholder={field.value_type === "text" ? "請輸入" : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function toTypedValue(
  field: AssessmentEditorView["schema"]["fields"][number],
  value: DraftAnswer["value"],
): { readonly type: AssessmentValueType; readonly value: string | number | readonly string[] } {
  if (field.value_type === "enum_set") {
    return { type: field.value_type, value: Array.isArray(value) ? value : [] };
  }
  if (field.value_type === "integer") {
    return { type: field.value_type, value: Number(asText(value)) };
  }
  return { type: field.value_type, value: asText(value) };
}

function defaultDraftValue(field: AssessmentEditorView["schema"]["fields"][number]): DraftAnswer["value"] {
  return field.value_type === "enum_set" ? [] : "";
}

function toDraftValue(value: unknown): DraftAnswer["value"] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function asText(value: DraftAnswer["value"]): string {
  return typeof value === "string" ? value : "";
}

const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "student_profile.date_of_birth": "出生日期",
  "student_profile.residency_status": "居留身份",
  "student_profile.primary_languages": "主要語言",
  "education_profile.current_stage": "目前教育階段",
  "education_profile.current_year_level": "目前年級",
  "education_profile.current_curriculum": "目前課程體系",
  "school_preferences.target_stage": "目標教育階段",
  "school_preferences.preferred_systems": "偏好學校體系",
  "school_preferences.preferred_districts": "偏好地區",
  "school_preferences.preferred_admission_route": "偏好入學途徑",
  "school_preferences.fee_band": "學費類型偏好",
  "family_context.primary_contact_language": "主要聯絡語言",
  "family_context.education_priority": "教育重點",
  "family_context.transport_arrangement": "交通安排",
  "family_context.fee_preference": "家庭學費偏好",
});

const ENUM_VALUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  hk_permanent_resident: "香港永久居民",
  hk_non_permanent_resident: "香港非永久居民",
  dependent_visa: "受養人簽證",
  other: "其他",
  cantonese: "粵語",
  mandarin: "普通話",
  english: "英語",
  kindergarten: "幼稚園",
  primary: "小學",
  secondary: "中學",
  hk_local: "香港本地課程",
  ib: "IB 課程",
  cambridge: "Cambridge 課程",
  hk_international: "香港國際學校",
  hong_kong_island: "香港島",
  kowloon: "九龍",
  new_territories: "新界",
  any: "不限地區",
  entry: "入學",
  transfer: "插班",
  government_aided: "官立或資助",
  private: "私立",
  international: "國際學校",
  undecided: "未決定",
  academic: "學術表現",
  balanced: "均衡發展",
  language_immersion: "語言沉浸",
  supportive_environment: "支持性環境",
  family_transport: "家庭接送",
  school_bus: "校車",
  public_transport: "公共交通",
});

function fieldLabel(field: AssessmentEditorView["schema"]["fields"][number]): string {
  return FIELD_LABELS[field.field_id] ?? field.label ?? field.field_id;
}

function enumValueLabel(value: string): string {
  return ENUM_VALUE_LABELS[value] ?? value;
}

function layerLabel(layer: AssessmentEditorView["schema"]["fields"][number]["layer"]): string {
  switch (layer) {
    case "base": return "學生基本資料";
    case "education_stage": return "教育背景";
    case "school_system": return "學校偏好";
    case "admission_route": return "家庭情況";
  }
}

function semanticStateLabel(state: AssessmentSemanticState): string {
  switch (state) {
    case "provided": return "已提供";
    case "unknown": return "暫時未知";
    case "not_applicable": return "不適用";
    case "declined_to_provide": return "拒絕提供";
  }
}

function assessmentStatusLabel(status: AssessmentEditorView["status"]): string {
  switch (status) {
    case "draft": return "草稿";
    case "background_complete": return "背景資料已完成";
    case "selection_ready": return "可進入選校";
  }
}
