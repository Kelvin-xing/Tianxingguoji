"use client";

import { useState } from "react";

import { Icon } from "@/components/workspace/Icon";

type SemanticState = "provided" | "unknown" | "not_applicable" | "declined_to_provide";
type AssessmentValueType = "text" | "date" | "integer" | "enum" | "enum_set";

export interface AssessmentEditorView {
  readonly assessment_id: string;
  readonly manifest_id: string;
  readonly status: "draft" | "background_complete" | "selection_ready";
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
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  async function save(field: AssessmentEditorView["schema"]["fields"][number]) {
    const draft = drafts[field.field_id];
    if (!draft) return;
    setNotice(null);
    setSavingFieldId(field.field_id);
    try {
      const typedValue = draft.semanticState === "provided" ? toTypedValue(field, draft.value) : null;
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify({
          field_id: field.field_id,
          semantic_state: draft.semanticState,
          value: typedValue,
          value_type: draft.semanticState === "provided" ? field.value_type : null,
          expected_record_version: draft.recordVersion,
        }),
      });
      const payload = (await response.json()) as {
        data?: {
          readonly field_id?: string;
          readonly semantic_state?: SemanticState;
          readonly value?: { readonly type: string; readonly value: unknown } | null;
          readonly value_type?: string | null;
          readonly record_version?: number;
        };
        error?: { readonly code?: string; readonly details?: { readonly current_version?: number } };
      };
      if (!response.ok || !payload.data?.record_version) {
        if (payload.error?.code === "STALE_VERSION") {
          const latestView = await fetchCurrentView(endpoint);
          const latestAnswer = latestView.answers.find((answer) => answer.field_id === field.field_id);
          if (latestAnswer) {
            setView(latestView);
            setConflict({
              fieldId: field.field_id,
              current: toDraft(latestAnswer),
              draft,
            });
          }
          setNotice("此欄位已被更新；請比較目前值與草稿後再確認。 ");
          return;
        }
        throw new Error(payload.error?.code ?? "UPDATE_FAILED");
      }
      const savedRecordVersion = payload.data.record_version;
      const savedAnswer = {
        field_id: payload.data.field_id ?? field.field_id,
        semantic_state: payload.data.semantic_state ?? draft.semanticState,
        value:
          payload.data.value ??
          typedValue,
        value_type:
          payload.data.value_type ??
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
        [field.field_id]: { ...draft, recordVersion: payload.data?.record_version ?? draft.recordVersion },
      }));
      setConflict(null);
      setNotice("已儲存。");
    } catch {
      setNotice("無法儲存此欄位，草稿已保留。");
    } finally {
      setSavingFieldId(null);
    }
  }

  return (
    <section className="workspace-section" aria-labelledby="assessment-editor-title">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h3 id="assessment-editor-title" tabIndex={-1} className="section-title">Assessment</h3>
          <p className="section-detail">{view.schema.composition_version} · {view.status}</p>
        </div>
        <span className="status-pill status-success">{view.answers.length} answered</span>
      </div>
      {notice && <div className="inline-callout mb-4" role="status"><Icon name="info" size={15} /><span>{notice}</span></div>}
      <div className="space-y-4">
        {view.schema.fields.map((field) => {
          const draft = drafts[field.field_id];
          if (!draft) return null;
          return (
            <div key={field.field_id} className="border-b pb-4 last:border-b-0 last:pb-0" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{field.label ?? field.field_id}</div>
                  <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{field.layer} · {field.value_type} · {field.visibility}</div>
                </div>
                <span className="inline-status" style={{ color: "var(--text-muted)" }}>v{draft.recordVersion}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,.6fr)_auto] gap-2 mt-3">
                <AssessmentValueControl
                  field={field}
                  draft={draft}
                  onChange={(value) => setDrafts((current) => ({
                    ...current,
                    [field.field_id]: { ...draft, value },
                  }))}
                />
                <select
                  aria-label={`${field.field_id} semantic state`}
                  value={draft.semanticState}
                  onChange={(event) => setDrafts((current) => ({
                    ...current,
                    [field.field_id]: {
                      ...draft,
                      semanticState: event.target.value as SemanticState,
                    },
                  }))}
                >
                  <option value="provided">provided</option>
                  <option value="unknown">unknown</option>
                  <option value="not_applicable">not applicable</option>
                  <option value="declined_to_provide">declined to provide</option>
                </select>
                <button
                  type="button"
                  className="primary-button"
                  disabled={savingFieldId === field.field_id}
                  onClick={() => void save(field)}
                >
                  <Icon name={savingFieldId === field.field_id ? "clock" : "check"} size={15} />
                  Save
                </button>
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
    </section>
  );
}

async function fetchCurrentView(endpoint: string): Promise<AssessmentEditorView> {
  const response = await fetch(endpoint, { cache: "no-store" });
  const payload = (await response.json()) as { readonly data?: AssessmentEditorView };
  if (!response.ok || !payload.data || !Array.isArray(payload.data.answers)) {
    throw new Error("CURRENT_VIEW_UNAVAILABLE");
  }
  return payload.data;
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

function toDraft(answer: AssessmentEditorView["answers"][number]): DraftAnswer {
  return {
    semanticState: answer.semantic_state,
    value: answer.semantic_state === "provided" ? toDraftValue(answer.value?.value) : "",
    recordVersion: answer.record_version,
  };
}

function describeDraft(draft: DraftAnswer): string {
  if (draft.semanticState !== "provided") return draft.semanticState;
  return Array.isArray(draft.value) ? draft.value.join(", ") || "(empty)" : draft.value || "(empty)";
}

function AssessmentValueControl({
  field,
  draft,
  onChange,
}: {
  readonly field: AssessmentEditorView["schema"]["fields"][number];
  readonly draft: DraftAnswer;
  readonly onChange: (value: string | readonly string[]) => void;
}) {
  const disabled = draft.semanticState !== "provided";
  if (field.value_type === "enum") {
    return (
      <select aria-label={`${field.field_id} value`} disabled={disabled} value={asText(draft.value)} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select</option>
        {(field.enum_values ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    );
  }
  if (field.value_type === "enum_set") {
    const selected = Array.isArray(draft.value) ? draft.value : [];
    return (
      <select aria-label={`${field.field_id} values`} disabled={disabled} multiple value={selected} onChange={(event) => onChange([...event.currentTarget.selectedOptions].map(({ value }) => value))}>
        {(field.enum_values ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    );
  }
  return (
    <input
      type={field.value_type === "date" ? "date" : field.value_type === "integer" ? "number" : "text"}
      step={field.value_type === "integer" ? "1" : undefined}
      aria-label={`${field.field_id} value`}
      disabled={disabled}
      value={asText(draft.value)}
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
  return Array.isArray(value) ? "" : value;
}
