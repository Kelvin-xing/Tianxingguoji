import type { CaseWorkspaceStage } from "@/modules/cases/client";

export const CASE_WORKSPACE_TABS = [
  "overview",
  "assessment",
  "schools",
  "tasks",
  "documents",
  "timeline",
] as const;

export type CaseWorkspaceTab = (typeof CASE_WORKSPACE_TABS)[number];
export type WorkspaceCapability = "view" | "comment" | "edit";
export type WorkspaceStatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface CaseWorkspaceHeader {
  readonly caseNumber: string;
  readonly studentLabel: string;
  readonly stageLabel: string;
  readonly updatedLabel: string;
  readonly summary: string;
}

/**
 * This is a server-produced entitlement projection. The browser may only
 * render this list; it must not derive visibility from role or scope values.
 */
export interface CaseWorkspaceTabProjection {
  readonly id: CaseWorkspaceTab;
  readonly label: string;
  readonly visible: boolean;
  readonly capability: WorkspaceCapability | null;
  readonly count?: number;
}

export interface WorkspaceAction {
  readonly label: string;
  readonly href: string | null;
  readonly unavailableLabel?: string;
}

export interface WorkspaceFact {
  readonly label: string;
  readonly value: string;
}

export interface WorkspaceRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly statusLabel?: string;
  readonly statusTone?: WorkspaceStatusTone;
  readonly meta?: string;
}

export interface WorkspaceTimelineEvent {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly occurredLabel: string;
  readonly tone: WorkspaceStatusTone;
}

export interface WorkspaceConflict {
  readonly title: string;
  readonly draftSummary: string;
  readonly currentSummary: string;
  readonly currentVersion: number;
  readonly retryHref: string;
}

export type WorkspacePanelData =
  | {
      readonly tab: "overview";
      readonly facts: readonly WorkspaceFact[];
      readonly blockers: readonly string[];
      readonly nextAction: WorkspaceAction | null;
    }
  | {
      readonly tab: "assessment";
      readonly answeredLabel: string;
      readonly editor: {
        readonly caseId: string;
        readonly caseStage: CaseWorkspaceStage;
      } | null;
    }
  | {
      readonly tab: "schools" | "tasks" | "documents";
      readonly rows: readonly WorkspaceRow[];
      readonly action: WorkspaceAction | null;
    }
  | {
      readonly tab: "timeline";
      readonly events: readonly WorkspaceTimelineEvent[];
    };

export type WorkspacePanelState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "empty";
      readonly title: string;
      readonly detail: string;
      readonly action: WorkspaceAction | null;
    }
  | { readonly kind: "denied" }
  | {
      readonly kind: "error";
      readonly title: string;
      readonly detail: string;
      readonly requestReference: string;
      readonly retryHref: string;
    }
  | { readonly kind: "ready"; readonly data: WorkspacePanelData };

export interface CaseWorkspaceProjection {
  readonly routeBase: string;
  readonly header: CaseWorkspaceHeader | null;
  readonly tabs: readonly CaseWorkspaceTabProjection[];
  readonly activeTab: CaseWorkspaceTab;
  readonly panel: WorkspacePanelState;
  readonly conflict: WorkspaceConflict | null;
}

export function parseCaseWorkspaceTab(value: string | undefined): CaseWorkspaceTab | null {
  if (value === undefined) return null;
  return (CASE_WORKSPACE_TABS as readonly string[]).includes(value)
    ? value as CaseWorkspaceTab
    : null;
}

export function resolveCaseWorkspaceTab(
  requestedTab: CaseWorkspaceTab | null,
  tabs: readonly CaseWorkspaceTabProjection[],
): CaseWorkspaceTab | null {
  const visibleTabs = tabs.filter((tab) => tab.visible);
  if (visibleTabs.length === 0) return null;
  if (requestedTab && visibleTabs.some((tab) => tab.id === requestedTab)) return requestedTab;
  return visibleTabs[0]?.id ?? null;
}

export function workspaceTabHref(routeBase: string, tab: CaseWorkspaceTab): string {
  return `${routeBase}?tab=${encodeURIComponent(tab)}`;
}

export function moveCaseWorkspaceTab(
  currentTab: CaseWorkspaceTab,
  tabs: readonly Pick<CaseWorkspaceTabProjection, "id" | "visible">[],
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): CaseWorkspaceTab | null {
  const visibleTabs = tabs.filter((tab) => tab.visible);
  if (visibleTabs.length === 0) return null;
  if (key === "Home") return visibleTabs[0]?.id ?? null;
  if (key === "End") return visibleTabs[visibleTabs.length - 1]?.id ?? null;
  const currentIndex = visibleTabs.findIndex((tab) => tab.id === currentTab);
  const index = currentIndex === -1 ? 0 : currentIndex;
  const offset = key === "ArrowRight" ? 1 : -1;
  return visibleTabs[(index + offset + visibleTabs.length) % visibleTabs.length]?.id ?? null;
}
