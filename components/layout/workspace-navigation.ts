import {
  isWorkspaceCapability as isAccessWorkspaceCapability,
  type OrganizationRole,
  type WorkspaceCapability,
} from "../../modules/access/public.ts";

export interface WorkspaceAuthDto {
  readonly user_id: string;
  readonly organization_id: string;
  readonly role: OrganizationRole;
  readonly capabilities: readonly WorkspaceCapability[];
}

export interface WorkspaceNavigationItem {
  readonly href: string;
  readonly labelKey: string;
  readonly icon: "activity" | "book-open" | "briefcase" | "clipboard" | "file-text" | "layout-dashboard" | "shield" | "users";
  readonly capability: WorkspaceCapability;
  readonly exact?: boolean;
}

export const WORKSPACE_NAVIGATION = Object.freeze([
  { href: "/today", labelKey: "nav.today", icon: "layout-dashboard", capability: "today.read", exact: true },
  { href: "/cases", labelKey: "nav.cases", icon: "briefcase", capability: "cases.read" },
  { href: "/students", labelKey: "nav.studentsAndGuardians", icon: "users", capability: "students.read" },
  { href: "/schools", labelKey: "nav.schoolData", icon: "book-open", capability: "schools.read" },
  { href: "/tasks", labelKey: "nav.tasks", icon: "clipboard", capability: "tasks.read" },
  { href: "/documents", labelKey: "nav.documents", icon: "file-text", capability: "documents.read" },
] as const satisfies readonly WorkspaceNavigationItem[]);

export const ADMIN_NAVIGATION = Object.freeze([
  { href: "/admin/access", labelKey: "nav.access", icon: "shield", capability: "access.manage" },
] as const satisfies readonly WorkspaceNavigationItem[]);

const ALL_NAVIGATION: readonly WorkspaceNavigationItem[] = [...WORKSPACE_NAVIGATION, ...ADMIN_NAVIGATION];

export function hasWorkspaceCapability(capabilities: readonly WorkspaceCapability[], capability: WorkspaceCapability): boolean {
  return capabilities.includes(capability);
}

export function visibleWorkspaceNavigation(capabilities: readonly WorkspaceCapability[]): readonly WorkspaceNavigationItem[] {
  return ALL_NAVIGATION.filter((item) => hasWorkspaceCapability(capabilities, item.capability));
}

export function capabilityForPath(pathname: string): WorkspaceCapability | null {
  const item = ALL_NAVIGATION.find((candidate) => candidate.exact ? pathname === candidate.href : pathname === candidate.href || pathname.startsWith(`${candidate.href}/`));
  return item?.capability ?? null;
}

export function defaultWorkspacePath(capabilities: readonly WorkspaceCapability[]): "/today" | "/tasks" {
  return hasWorkspaceCapability(capabilities, "today.read") ? "/today" : "/tasks";
}

export function isContractorWorkspace(capabilities: readonly WorkspaceCapability[]): boolean {
  return hasWorkspaceCapability(capabilities, "tasks.read") && !hasWorkspaceCapability(capabilities, "today.read") && !hasWorkspaceCapability(capabilities, "cases.read") && !hasWorkspaceCapability(capabilities, "students.read") && !hasWorkspaceCapability(capabilities, "documents.read");
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === "founder" || value === "admin" || value === "advisor" || value === "data_reviewer" || value === "contractor";
}

/** Data Reviewer and crawler surfaces are retained only for historical compatibility, not Release 1 entry. */
export function isReleaseOneInternalRole(role: OrganizationRole): role is Exclude<OrganizationRole, "data_reviewer"> {
  return role !== "data_reviewer";
}

export function isWorkspaceCapability(value: unknown): value is WorkspaceCapability {
  return isAccessWorkspaceCapability(value);
}

export function decodeWorkspaceAuth(value: unknown): WorkspaceAuthDto {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid workspace identity response.");
  const record = value as Record<string, unknown>;
  if (typeof record.user_id !== "string" || typeof record.organization_id !== "string" || !isOrganizationRole(record.role) || !Array.isArray(record.capabilities) || !record.capabilities.every(isWorkspaceCapability)) throw new TypeError("Invalid workspace identity response.");
  return { user_id: record.user_id, organization_id: record.organization_id, role: record.role, capabilities: Object.freeze([...record.capabilities]) };
}

export function roleLabel(role: OrganizationRole): string {
  if (role === "founder") return "Founder";
  if (role === "admin") return "Admin";
  if (role === "advisor") return "Advisor";
  if (role === "contractor") return "Contractor";
  return "Data Reviewer";
}
