"use client";

import { useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import { ApiClientError, expectRecord, requestApi, type ApiRequestBody } from "@/lib/api/client";

type SemanticState = "provided" | "unknown" | "not_applicable" | "declined_to_provide";
type AssessmentValueType = "text" | "date" | "integer" | "enum" | "enum_set";

export interface AssessmentEditorView {
  readonly assessment_id: string;
  readonly manifest_id: string;
  readonly record_version: number;
  readonly status: "draft" | "background_complete" | "selection_ready";
  readonly access: {
    readonly mode: "full" | "education_profile";
    readonly can_edit: boolean;
    readonly editable_field_ids: readonly string[];
    readonly can_complete_background: boolean;
  };
  readonly schema: {
    readonly manifest_id: string;
    readonly composition_version: "k12-structural-v1" | "k12-catalogue-v1";
    readonly fields: readonly {
      readonly field_id: string;
      readonly label?: string;
      readonly layer: "base" | "education_stage" | "school_system" | "admission_route";
      readonly module_id?: string;
      readonly module_version?: string;
      readonly value_type: AssessmentValueType;
      readonly enum_values?: readonly string[];
      readonly visibility: string;
      readonly blocking_stages: readonly string[];
    }[];
  };
  readonly answers: readonly {
    readonly field_id: string;
    readonly semantic_state: SemanticState;
    readonly value: { readonly type: string; readonly value: unknown } | null;
    readonly value_type: string | null;
    readonly record_version: number;
  }[];
}

interface DraftAnswer {
  readonly semanticState: SemanticState;
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
  endpoint,
  initialView,
}: {
  readonly endpoint: string;
  readonly initialView: AssessmentEditorView;
}) {
  const [view, setView] = useState(initialView);
  const [drafts, setDrafts] = useState(() => createDrafts(initialView));
  const [dirtyFieldIds, setDirtyFieldIds] = useState<ReadonlySet<string>>(() => new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const answeredFieldIds = new Set(
    view.answers
      .filter((answer) => answer.semantic_state === "provided")
      .map((answer) => answer.field_id),
  );
  const blockingFieldIds = view.schema.fields
    .filter((field) => field.blocking_stages.includes("background_collection"))
    .map((field) => field.field_id);
  const completedBlockers = blockingFieldIds.filter((fieldId) => answeredFieldIds.has(fieldId)).length;
  const canComplete = view.access.can_complete_background &&
    view.status === "draft" && completedBlockers === blockingFieldIds.length;
  const editableFields = view.schema.fields.filter((field) =>
    view.access.can_edit && view.access.editable_field_ids.includes(field.field_id),
  );
  const dirtyEditableFields = editableFields.filter((field) => dirtyFieldIds.has(field.field_id));

  async function save(field: AssessmentEditorView["schema"]["fields"][number]): Promise<boolean> {
    const draft = drafts[field.field_id];
    if (!draft) return false;
    setNotice(null);
    try {
      const typedValue = draft.semanticState === "provided" ? toTypedValue(field, draft.value) : null;
      const payload = await requestApi({
        path: endpoint as `/${string}`,
        method: "PATCH",
        idempotencyKey: globalThis.crypto.randomUUID(),
        body: {
          field_id: field.field_id,
          semantic_state: draft.semanticState,
          value: typedValue,
          value_type: draft.semanticState === "provided" ? field.value_type : null,
          expected_record_version: draft.recordVersion,
        } as ApiRequestBody,
      }, expectRecord);
      if (!payload.record_version) {
        throw new Error("UPDATE_FAILED");
      }
      const savedRecordVersion = Number(payload.record_version);
      const savedAnswer = {
        field_id: typeof payload.field_id === "string" ? payload.field_id : field.field_id,
        semantic_state: payload.semantic_state as SemanticState ?? draft.semanticState,
        value:
          payload.value as { readonly type: string; readonly value: unknown } | null ??
          typedValue,
        value_type:
          (payload.value_type as string | null | undefined) ??
          (draft.semanticState === "provided" ? field.value_type : null),
        record_version: savedRecordVersion,
      };
      setView((current) => ({
        ...current,
        answers: [
          ...current.answers.filter((answer) => answer.field_id !== field.field_id),
          savedAnswer,
        ],
      }));
      setDrafts((current) => ({
        ...current,
        [field.field_id]: { ...draft, recordVersion: savedRecordVersion },
      }));
      setDirtyFieldIds((current) => {
        const next = new Set(current);
        next.delete(field.field_id);
        return next;
      });
      setConflict(null);
      setNotice("已儲存。");
      return true;
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "STALE_VERSION") {
        try {
          const latestView = await fetchCurrentView(endpoint);
          const latestAnswer = latestView.answers.find((answer) => answer.field_id === field.field_id);
          if (latestAnswer) { setView(latestView); setConflict({ fieldId: field.field_id, current: toDraft(latestAnswer), draft }); }
        } catch { /* preserve the local draft when refresh is unavailable */ }
        setNotice("此欄位已被更新；請比較目前值與草稿後再確認。 ");
      } else {
        setNotice("無法儲存此欄位，草稿已保留。");
      }
      return false;
    }
  }

  async function saveAll(): Promise<void> {
    if (savingAll || dirtyEditableFields.length === 0) return;
    setNotice(null);
    setSavingAll(true);
    for (const field of dirtyEditableFields) {
      const saved = await save(field);
      if (!saved) break;
    }
    setSavingAll(false);
  }

  async function completeBackgroundCollection() {
    if (!canComplete) return;
    setNotice(null);
    setCompleting(true);
    try {
      const payload = await requestApi({
        path: `${endpoint}/background-completion` as `/${string}`,
        method: "POST",
        idempotencyKey: globalThis.crypto.randomUUID(),
        body: { expected_record_version: view.record_version },
      }, expectRecord);
      if (payload.id !== view.assessment_id || typeof payload.record_version !== "number") {
        throw new Error("COMPLETION_FAILED");
      }
      setView((current) => ({
        ...current,
        status: "background_complete",
        record_version: Number(payload.record_version),
      }));
      setNotice("背景資料收集已完成。");
    } catch (error) {
      if (error instanceof ApiClientError && (error.code === "STALE_VERSION" || error.code === "VALIDATION_FAILED")) {
        try { const latestView = await fetchCurrentView(endpoint); setView(latestView); setDrafts((current) => mergeDrafts(current, latestView)); } catch { /* retain current state */ }
        setNotice(error.code === "STALE_VERSION" ? "評估狀態已更新，已重新載入目前版本。" : "仍有背景資料尚未儲存，已重新計算進度。");
        return;
      }
      setNotice("目前無法完成背景資料收集，已儲存的答案不受影響。");
    } finally {
      setCompleting(false);
    }
  }

  return (
    <section className="workspace-section" aria-labelledby="assessment-editor-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
        <div>
          <h3 id="assessment-editor-title" tabIndex={-1} className="section-title">學生評估</h3>
          <p className="section-detail">15 項資料 · {assessmentStatusLabel(view.status)} · 評估版本 {view.record_version}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="status-pill">已儲存 {view.answers.length} / {view.schema.fields.length}</span>
          <span className={`status-pill ${canComplete || view.status !== "draft" ? "status-success" : "status-warning"}`}>
            背景必填 {completedBlockers} / {blockingFieldIds.length}
          </span>
        </div>
      </div>
      {!view.access.can_edit ? (
        <div className="inline-callout" role="status">你目前可以查看評估，但沒有編輯權限。</div>
      ) : null}
      {notice && <div className="inline-callout mb-4" role="status"><Icon name="activity" size={15} /><span>{notice}</span></div>}
      <div className="space-y-4">
        {view.schema.fields.map((field) => {
          const draft = drafts[field.field_id];
          if (!draft) return null;
          const editable = view.access.can_edit && view.access.editable_field_ids.includes(field.field_id);
          const dirty = dirtyFieldIds.has(field.field_id);
          return (
            <div key={field.field_id} className="border-b pb-4 last:border-b-0 last:pb-0" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="grid grid-cols-1 md:grid-cols-[minmax(12rem,.38fr)_minmax(0,1fr)] gap-x-6 gap-y-2 items-start max-w-4xl">
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fieldLabel(field)}</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                    {layerLabel(field.layer)}
                    {field.blocking_stages.includes("background_collection") ? " · 背景收集必填" : " · 後續選校資料"}
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: dirty ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {dirty ? "有未儲存修改" : `版本 v${draft.recordVersion}`}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(150px,12rem)] gap-2 max-w-xl">
                  <AssessmentValueControl
                    field={field}
                    draft={draft}
                    disabled={!editable || savingAll}
                    onChange={(value) => {
                      setDrafts((current) => ({
                        ...current,
                        [field.field_id]: { ...draft, value },
                      }));
                      setDirtyFieldIds((current) => new Set(current).add(field.field_id));
                    }}
                  />
                  <select
                    aria-label={`${field.field_id} semantic state`}
                    className="assessment-control"
                    disabled={!editable || savingAll}
                    value={draft.semanticState}
                    onChange={(event) => {
                      setDrafts((current) => ({
                        ...current,
                        [field.field_id]: {
                          ...draft,
                          semanticState: event.target.value as SemanticState,
                        },
                      }));
                      setDirtyFieldIds((current) => new Set(current).add(field.field_id));
                    }}
                  >
                    <option value="provided">已提供</option>
                    <option value="unknown">暫時未知</option>
                    <option value="not_applicable">不適用</option>
                    <option value="declined_to_provide">拒絕提供</option>
                  </select>
                </div>
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
                          setDirtyFieldIds((current) => {
                            const next = new Set(current);
                            next.delete(field.field_id);
                            return next;
                          });
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
                          setDirtyFieldIds((current) => new Set(current).add(field.field_id));
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
      {view.access.can_edit ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-6 pt-5 border-t" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            {dirtyEditableFields.length > 0 ? `有 ${dirtyEditableFields.length} 項未儲存修改` : "修改內容會集中儲存"}
          </div>
          <button
            type="button"
            className="primary-button justify-center"
            disabled={dirtyEditableFields.length === 0 || savingAll}
            aria-busy={savingAll}
            onClick={() => void saveAll()}
          >
            <Icon name={savingAll ? "clock" : "check"} size={15} />
            {savingAll ? "儲存中…" : "儲存全部修改"}
          </button>
        </div>
      ) : null}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-6 pt-5 border-t" style={{ borderColor: "var(--border-subtle)" }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>背景資料收集</div>
          <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {view.status === "draft"
              ? `尚需儲存 ${blockingFieldIds.length - completedBlockers} 個背景必填項目`
              : `目前狀態：${assessmentStatusLabel(view.status)}`}
          </div>
        </div>
        {view.access.can_complete_background ? (
          <button
            type="button"
            className="primary-button"
            disabled={!canComplete || completing || savingAll}
            onClick={() => void completeBackgroundCollection()}
          >
            <Icon name={completing ? "clock" : "check-circle"} size={15} />
            {completing ? "處理中" : view.status === "draft" ? "完成背景收集" : "背景收集已完成"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

async function fetchCurrentView(endpoint: string): Promise<AssessmentEditorView> {
  return requestApi({ path: endpoint as `/${string}` }, (value) => {
    const payload = expectRecord(value);
    if (!Array.isArray(payload.answers)) throw new Error("CURRENT_VIEW_UNAVAILABLE");
    return payload as unknown as AssessmentEditorView;
  });
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
  disabled: readOnly,
  onChange,
}: {
  readonly field: AssessmentEditorView["schema"]["fields"][number];
  readonly draft: DraftAnswer;
  readonly disabled: boolean;
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
): { readonly type: AssessmentValueType; readonly value: unknown } {
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

function semanticStateLabel(state: SemanticState): string {
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
