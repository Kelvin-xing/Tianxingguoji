"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import type { ServiceCaseStage } from "@/modules/cases/public";

interface CaseStageControlsProps {
  readonly endpoint: string;
  readonly initialStage: ServiceCaseStage;
  readonly initialRecordVersion: number;
  readonly assessmentStatus: "draft" | "background_complete" | "selection_ready";
  readonly canAdvance: boolean;
  readonly canRollback: boolean;
}

export function CaseStageControls({
  endpoint,
  initialStage,
  initialRecordVersion,
  assessmentStatus,
  canAdvance,
  canRollback,
}: CaseStageControlsProps) {
  const router = useRouter();
  const [stage, setStage] = useState(initialStage);
  const [recordVersion, setRecordVersion] = useState(initialRecordVersion);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const assessmentComplete = assessmentStatus === "background_complete" ||
    assessmentStatus === "selection_ready";
  const forwardEnabled = stage === "signed" && canAdvance && assessmentComplete;
  const rollbackEnabled = stage === "background_collection" && canRollback && reason.trim() !== "";

  async function transition(toStage: "signed" | "background_collection", transitionReason: string) {
    setPending(true);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          to_stage: toStage,
          expected_record_version: recordVersion,
          reason: transitionReason,
        }),
      });
      const payload = await response.json() as {
        readonly data?: {
          readonly stage?: "signed" | "background_collection";
          readonly record_version?: number;
        };
        readonly error?: { readonly code?: string };
      };
      if (!response.ok || payload.data?.stage === undefined ||
          typeof payload.data.record_version !== "number") {
        throw new Error(transitionErrorMessage(payload.error?.code));
      }
      setStage(payload.data.stage);
      setRecordVersion(payload.data.record_version);
      setReason("");
      setNotice(toStage === "background_collection"
        ? "案件已推進至背景資料階段。"
        : "案件已回退至已簽約階段，原因已保留在階段歷史中。");
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "案件階段更新失敗。");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const unavailableMessage = stage === "signed"
    ? !canAdvance
      ? "只有此案件目前的 Primary Advisor 可以推進。"
      : !assessmentComplete
        ? "需要先完成背景 Assessment，案件才可以推進。"
        : null
    : stage === "background_collection" && !canRollback
      ? "只有 Founder 可以把案件回退至上一階段。"
      : null;

  if (stage !== "signed" && stage !== "background_collection") return null;

  return (
    <section className="workspace-section" aria-labelledby="case-stage-command-title">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <h3 id="case-stage-command-title" className="section-title">階段操作</h3>
          <p className="section-detail">目前案件版本 {recordVersion}。每次操作都會重新驗證身份、版本與前置資料。</p>
        </div>
        {stage === "signed" ? (
          <button
            type="button"
            className="primary-button shrink-0"
            disabled={!forwardEnabled || pending}
            onClick={() => transition("background_collection", "")}
          >
            <Icon name={pending ? "clock" : "arrow-right"} size={15} />
            {pending ? "推進中…" : "推進至背景資料"}
          </button>
        ) : null}
      </div>

      {stage === "background_collection" && canRollback ? (
        <form
          className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (rollbackEnabled) void transition("signed", reason);
          }}
        >
          <label className="block text-sm font-medium" htmlFor="case-stage-rollback-reason">
            回退原因
            <textarea
              id="case-stage-rollback-reason"
              className="mt-1 w-full min-h-20"
              value={reason}
              maxLength={4000}
              required
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={!rollbackEnabled || pending}>
            <Icon name={pending ? "clock" : "rotate-ccw"} size={15} />
            {pending ? "回退中…" : "回退至已簽約"}
          </button>
        </form>
      ) : null}

      {unavailableMessage ? (
        <div className="inline-callout warning mt-4"><Icon name="shield" size={15} /><span>{unavailableMessage}</span></div>
      ) : null}
      {notice ? (
        <div className="inline-callout mt-4" role="status"><Icon name="activity" size={15} /><span>{notice}</span></div>
      ) : null}
    </section>
  );
}

function transitionErrorMessage(code: string | undefined): string {
  if (code === "STALE_VERSION") return "案件已被其他人更新，頁面正在重新載入目前版本。";
  if (code === "VALIDATION_FAILED") return "前置資料仍未完成，或回退原因不符合要求。";
  if (code === "FORBIDDEN") return "目前登入角色沒有執行這個階段操作的權限。";
  if (code === "UNAUTHENTICATED") return "登入或重新驗證已失效，請重新登入後再試。";
  if (code === "CONFLICT") return "案件目前的階段不允許這個操作。";
  return "案件階段服務暫時無法完成操作。";
}
