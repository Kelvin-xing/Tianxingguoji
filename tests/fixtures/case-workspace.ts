import {
  parseCaseWorkspaceTab,
  type CaseWorkspaceProjection,
  type CaseWorkspaceTab,
} from "../../components/cases/workspace-model.ts";

const routeBase = "/cases/__fixtures/workspace";

/** Visual-only fixture. It is imported only by the development-gated preview route. */
export function createCaseWorkspaceVisualFixture(tabValue?: string): CaseWorkspaceProjection {
  const activeTab = parseCaseWorkspaceTab(tabValue) ?? "overview";
  const tabs = [
    { id: "overview", label: "概覽", visible: true, capability: "view" as const },
    { id: "assessment", label: "Assessment", visible: true, capability: "edit" as const },
    { id: "schools", label: "學校", visible: true, capability: "view" as const, count: 2 },
    { id: "tasks", label: "任務", visible: true, capability: "edit" as const, count: 3 },
    { id: "documents", label: "文件", visible: true, capability: "view" as const, count: 2 },
    { id: "timeline", label: "時間線", visible: true, capability: "view" as const },
  ] satisfies CaseWorkspaceProjection["tabs"];

  return {
    routeBase,
    header: {
      caseNumber: "CASE-VISUAL-014",
      studentLabel: "Workspace visual fixture with a deliberately long operational label",
      stageLabel: "背景資料收集",
      updatedLabel: "Updated just now",
      summary: "K12 · 2026 · Primary Advisor",
    },
    tabs,
    activeTab,
    panel: fixturePanel(activeTab),
    conflict: activeTab === "assessment"
      ? {
          title: "Assessment answer changed",
          draftSummary: "Your draft: school preference pending family confirmation",
          currentSummary: "Current value: school preference updated by another advisor",
          currentVersion: 4,
          retryHref: `${routeBase}?tab=assessment`,
        }
      : null,
  };
}

function fixturePanel(tab: CaseWorkspaceTab): CaseWorkspaceProjection["panel"] {
  if (tab === "overview") {
    return {
      kind: "ready",
      data: {
        tab,
        facts: [
          { label: "Application", value: "K12" },
          { label: "Primary Advisor", value: "Assigned" },
          { label: "Assessment", value: "Background collection" },
          { label: "Updated", value: "Today" },
        ],
        blockers: ["Confirm the current school system before the next stage."],
        nextAction: { label: "Review assessment", href: `${routeBase}?tab=assessment` },
      },
    };
  }
  if (tab === "assessment") {
    return { kind: "empty", title: "No assessment answers in the visual fixture", detail: "The production editor is supplied only by the authorized assessment projection.", action: null };
  }
  if (tab === "timeline") {
    return {
      kind: "ready",
      data: {
        tab,
        events: [
          { id: "1", title: "Case workspace opened", detail: "Visual fixture event only", occurredLabel: "Now", tone: "info" },
          { id: "2", title: "Task requires attention", detail: "No personal data is included in this event", occurredLabel: "Earlier", tone: "warning" },
        ],
      },
    };
  }
  const labels: Record<Exclude<CaseWorkspaceTab, "overview" | "assessment" | "timeline">, string> = {
    schools: "School target",
    tasks: "Task",
    documents: "Document",
  };
  return {
    kind: "ready",
    data: {
      tab,
      rows: [
        { id: "one", title: `${labels[tab]} with a deliberately long label for responsive wrapping`, detail: "Visible fixture row", statusLabel: "Needs review", statusTone: "warning", meta: "Today" },
        { id: "two", title: `${labels[tab]} status example`, detail: "Safe operational metadata", statusLabel: "Ready", statusTone: "success", meta: "Yesterday" },
      ],
      action: null,
    },
  };
}
