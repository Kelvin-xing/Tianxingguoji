"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import type { CaseWorkspaceStage } from "@/modules/cases/client";
import { listTasks, type CaseWorkspaceTask } from "@/modules/tasks/client";

const STAGES: ReadonlyArray<{ readonly key: CaseWorkspaceStage; readonly label: string }> = [
  { key: "signed", label: "已簽約" },
  { key: "background_collection", label: "背景資料" },
  { key: "school_selection_confirmed", label: "選校確認" },
  { key: "application_in_progress", label: "申請處理" },
  { key: "closed", label: "已結案" },
];

const TERMINAL_TASK_STATES = new Set(["completed", "cancelled", "rejected"]);

interface CaseStageTimelineProps {
  readonly caseId: string;
  readonly stage: CaseWorkspaceStage;
  readonly primaryOwnerLabel: string;
}

/**
 * The case record owns the primary Advisor binding. Application and interview
 * ownership is task data, so this component refreshes that small projection
 * without changing the case API contract.
 */
export function CaseStageTimeline({
  caseId,
  stage,
  primaryOwnerLabel,
}: CaseStageTimelineProps) {
  const [tasks, setTasks] = useState<readonly CaseWorkspaceTask[]>([]);
  const stageIndex = STAGES.findIndex((item) => item.key === stage);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;

    void listTasks(caseId, controller.signal)
      .then((result) => {
        if (mounted && result.audience === "case_workspace") setTasks(result.tasks);
      })
      .catch(() => {
        // The primary Advisor remains the truthful fallback when task data is
        // unavailable; the timeline itself must not become a blocking screen.
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [caseId]);

  const applicationOwners = activeTaskOwners(tasks, ["application_prepare_submit", "interview_support"]);

  return (
    <section className="workspace-section" aria-labelledby="case-stage-heading">
      <div className="mb-5">
        <h3 id="case-stage-heading" className="section-title">案件階段</h3>
        <p className="section-detail">評估完成後，請按流程逐步推進案件；每個階段均顯示目前負責人。</p>
      </div>
      <div className="overflow-x-auto">
        <div className="stage-track">
          {STAGES.map((item, index) => {
            const done = index < stageIndex;
            const active = index === stageIndex;
            return (
              <div className="stage-node" key={item.key}>
                <div className={`stage-dot ${done ? "done" : ""} ${active ? "active" : ""}`}>
                  {done ? <Icon name="check" size={13} /> : index + 1}
                </div>
                <div className="stage-node-copy">
                  <span className={active ? "active-label" : ""}>{item.label}</span>
                  <span className="stage-node-owner">負責人：{ownerForStage(item.key, primaryOwnerLabel, applicationOwners)}</span>
                </div>
                {index < STAGES.length - 1 ? <div className={`stage-line ${done ? "done" : ""}`} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ownerForStage(
  stage: CaseWorkspaceStage,
  primaryOwnerLabel: string,
  applicationOwners: readonly string[],
): string {
  if (stage === "school_selection_confirmed") return `${primaryOwnerLabel}、Founder、家長`;
  if (stage === "application_in_progress" && applicationOwners.length > 0) return applicationOwners.join("、");
  if (stage === "closed") return "Founder";
  return primaryOwnerLabel;
}

function activeTaskOwners(
  tasks: readonly CaseWorkspaceTask[],
  kinds: readonly CaseWorkspaceTask["task_kind"][],
): readonly string[] {
  const owners: string[] = [];
  for (const task of tasks) {
    if (!kinds.includes(task.task_kind) || TERMINAL_TASK_STATES.has(task.state)) continue;
    if (!owners.includes(task.assignee.label)) owners.push(task.assignee.label);
  }
  return owners;
}
