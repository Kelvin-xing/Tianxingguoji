import type { WorkspaceCapability } from "../../modules/access/public.ts";
import type { IconName } from "../workspace/Icon.tsx";

export type NavigationAudience = "workspace" | "administration";
export type NavigationActiveMatch = "exact" | "prefix";
export type NavigationLabelKey =
  | "nav.today"
  | "nav.cases"
  | "nav.studentsAndGuardians"
  | "nav.schoolData"
  | "nav.tasks"
  | "nav.documents"
  | "nav.access"
  | "nav.schoolGovernance"
  | "nav.dataReview";

export interface NavigationRegistryItem {
  readonly route: string;
  readonly labelKey: NavigationLabelKey;
  readonly iconKey: IconName;
  readonly requiredCapability: WorkspaceCapability;
  readonly audience: NavigationAudience;
  readonly activeMatch: NavigationActiveMatch;
}

export const NAVIGATION_REGISTRY = Object.freeze([
  defineNavigationItem({ route: "/today", labelKey: "nav.today", iconKey: "layout-dashboard", requiredCapability: "today.read", audience: "workspace", activeMatch: "exact" }),
  defineNavigationItem({ route: "/cases", labelKey: "nav.cases", iconKey: "briefcase", requiredCapability: "cases.read", audience: "workspace", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/students", labelKey: "nav.studentsAndGuardians", iconKey: "users", requiredCapability: "students.read", audience: "workspace", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/schools", labelKey: "nav.schoolData", iconKey: "book-open", requiredCapability: "schools.read", audience: "workspace", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/tasks", labelKey: "nav.tasks", iconKey: "clipboard", requiredCapability: "tasks.read", audience: "workspace", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/documents", labelKey: "nav.documents", iconKey: "file-text", requiredCapability: "documents.read", audience: "workspace", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/admin/access", labelKey: "nav.access", iconKey: "shield", requiredCapability: "access.manage", audience: "administration", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/admin/schools", labelKey: "nav.schoolGovernance", iconKey: "book-open", requiredCapability: "schools.manage", audience: "administration", activeMatch: "prefix" }),
  defineNavigationItem({ route: "/admin/crawler", labelKey: "nav.dataReview", iconKey: "settings", requiredCapability: "crawler.manage", audience: "administration", activeMatch: "prefix" }),
] as const satisfies readonly NavigationRegistryItem[]);

function defineNavigationItem<const T extends NavigationRegistryItem>(item: T): Readonly<T> {
  return Object.freeze(item);
}
