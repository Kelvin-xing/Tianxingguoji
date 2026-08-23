export type ModuleId =
  | "shared"
  | "identity"
  | "access"
  | "crm"
  | "cases"
  | "tasks"
  | "schools"
  | "documents"
  | "notifications"
  | "audit_operations"
  | "external_portal_access"
  | "platform_billing"
  | "future"
  | "adapters";

export interface ModuleDefinition {
  readonly id: ModuleId;
  readonly sourceRoots: readonly string[];
  readonly publicEntrypoints: readonly string[];
  readonly owns: readonly string[];
}

export type ModuleBoundaryErrorCode =
  | "UNKNOWN_MODULE"
  | "UNKNOWN_RESOURCE"
  | "UNREGISTERED_MODULE_PATH"
  | "CROSS_MODULE_INTERNAL_IMPORT"
  | "CROSS_MODULE_WRITE";

export class ModuleBoundaryError extends Error {
  readonly code: ModuleBoundaryErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: ModuleBoundaryErrorCode, details: Record<string, string>) {
    super(`Module boundary rejected ${code}`);
    this.name = "ModuleBoundaryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return Object.freeze({
    ...definition,
    sourceRoots: Object.freeze([...definition.sourceRoots]),
    publicEntrypoints: Object.freeze([...definition.publicEntrypoints]),
    owns: Object.freeze([...definition.owns]),
  });
}

export const MODULE_REGISTRY = Object.freeze({
  shared: defineModule({
    id: "shared",
    sourceRoots: ["modules/shared"],
    publicEntrypoints: [
      "modules/shared/public.ts",
      "modules/shared/server.ts",
    ],
    owns: ["IdempotencyRecord"],
  }),
  identity: defineModule({
    id: "identity",
    sourceRoots: ["modules/identity"],
    publicEntrypoints: [
      "modules/identity/public.ts",
      "modules/identity/server.ts",
      "modules/identity/web.ts",
    ],
    owns: ["User", "Session", "Invite"],
  }),
  access: defineModule({
    id: "access",
    sourceRoots: ["modules/access"],
    publicEntrypoints: [
      "modules/access/public.ts",
      "modules/access/server.ts",
      "modules/access/client.ts",
    ],
    owns: [
      "Organization",
      "Subscription",
      "Entitlement",
      "OrganizationMembership",
      "RoleBinding",
      "CaseCollaborator",
      "ScopeGrant",
      "SupportGrant",
    ],
  }),
  crm: defineModule({
    id: "crm",
    sourceRoots: ["modules/crm"],
    publicEntrypoints: [
      "modules/crm/public.ts",
      "modules/crm/server.ts",
      "modules/crm/client.ts",
    ],
    owns: [
      "ReferralSource",
      "Student",
      "Guardian",
      "StudentGuardianRelationship",
      "DuplicateCandidate",
      "MergeRevision",
    ],
  }),
  cases: defineModule({
    id: "cases",
    sourceRoots: ["modules/cases"],
    publicEntrypoints: [
      "modules/cases/public.ts",
      "modules/cases/server.ts",
      "modules/cases/client.ts",
    ],
    owns: [
      "ServiceCase",
      "Assessment",
      "SchemaManifest",
      "Answer",
      "SchoolTarget",
      "CaseOutcome",
      "ServiceGoalOutcome",
      "CaseReconstruction",
      "ReconstructionVersion",
      "CaseReferralSourceAssignment",
      "ReconstructionEvent",
      "ReconstructionGap",
    ],
  }),
  tasks: defineModule({
    id: "tasks",
    sourceRoots: ["modules/tasks"],
    publicEntrypoints: ["modules/tasks/public.ts", "modules/tasks/server.ts"],
    owns: ["Task", "TaskAssignment"],
  }),
  schools: defineModule({
    id: "schools",
    sourceRoots: ["modules/schools"],
    publicEntrypoints: [
      "modules/schools/public.ts",
      "modules/schools/server.ts",
      "modules/schools/client.ts",
      "modules/schools/crawler-server.ts",
    ],
    owns: [
      "School",
      "ProvisionalSchool",
      "SchoolChangeRequest",
      "OverlayRevision",
      "ResolvedSchoolRevision",
      "PublishedSnapshot",
      "Manifest",
    ],
  }),
  documents: defineModule({
    id: "documents",
    sourceRoots: ["modules/documents"],
    publicEntrypoints: ["modules/documents/public.ts", "modules/documents/server.ts"],
    owns: ["Document", "DocumentVersion", "ScanResult"],
  }),
  notifications: defineModule({
    id: "notifications",
    sourceRoots: ["modules/notifications"],
    publicEntrypoints: ["modules/notifications/public.ts", "modules/notifications/server.ts"],
    owns: ["Notification", "DeliveryReceipt"],
  }),
  audit_operations: defineModule({
    id: "audit_operations",
    sourceRoots: ["modules/audit", "modules/operations"],
    publicEntrypoints: [
      "modules/audit/public.ts",
      "modules/audit/server.ts",
      "modules/operations/public.ts",
      "modules/operations/server.ts",
    ],
    owns: [
      "AuditEvent",
      "Outbox",
      "Alert",
      "Incident",
      "RestoreEvidence",
      "ProductTelemetryEvent",
      "TelemetryRetentionManifest",
      "TelemetryOperationsState",
    ],
  }),
  external_portal_access: defineModule({
    id: "external_portal_access",
    sourceRoots: ["modules/external-portal"],
    publicEntrypoints: [
      "modules/external-portal/public.ts",
      "modules/external-portal/server.ts",
    ],
    owns: [
      "PortalViewer",
      "PortalAccessGrant",
      "PortalSession",
      "PortalSecurityEvent",
    ],
  }),
  platform_billing: defineModule({
    id: "platform_billing",
    sourceRoots: ["modules/platform-billing"],
    publicEntrypoints: [
      "modules/platform-billing/public.ts",
      "modules/platform-billing/server.ts",
    ],
    owns: [
      "PlatformBillingActor",
      "CustomerContract",
      "MonthlyTenantMetric",
      "PlatformSubscriptionProjection",
      "PlatformAuditEvent",
    ],
  }),
  future: defineModule({
    id: "future",
    sourceRoots: ["modules/future"],
    publicEntrypoints: ["modules/future/public.ts", "modules/future/server.ts"],
    owns: [],
  }),
  adapters: defineModule({
    id: "adapters",
    sourceRoots: ["app", "components", "workers"],
    publicEntrypoints: [],
    owns: [],
  }),
} as const satisfies Readonly<Record<ModuleId, ModuleDefinition>>);

const MODULES_BY_LONGEST_ROOT = Object.values(MODULE_REGISTRY)
  .flatMap((definition) => definition.sourceRoots.map((root) => ({ definition, root })))
  .sort((left, right) => right.root.length - left.root.length);

const RESOURCE_OWNERS = new Map<string, ModuleId>();
for (const definition of Object.values(MODULE_REGISTRY)) {
  for (const resource of definition.owns) {
    if (RESOURCE_OWNERS.has(resource)) {
      throw new Error(`Authoritative resource has multiple owners: ${resource}`);
    }
    RESOURCE_OWNERS.set(resource, definition.id);
  }
}

export function getModuleForPath(filePath: string): ModuleDefinition | undefined {
  const normalizedPath = normalizeRepositoryPath(filePath);
  return MODULES_BY_LONGEST_ROOT.find(
    ({ root }) => normalizedPath === root || normalizedPath.startsWith(`${root}/`),
  )?.definition;
}

export function assertModuleImportAllowed(importer: string, imported: string): void {
  const normalizedImporter = normalizeRepositoryPath(importer);
  const normalizedImported = normalizeRepositoryPath(imported);
  const importerModule = getModuleForPath(normalizedImporter);
  const importedModule = getModuleForPath(normalizedImported);

  if (!importerModule) {
    if (isGovernedPath(normalizedImporter)) {
      throw new ModuleBoundaryError("UNREGISTERED_MODULE_PATH", { path: normalizedImporter });
    }
    return;
  }

  if (!importedModule) {
    if (isGovernedPath(normalizedImported)) {
      throw new ModuleBoundaryError("UNREGISTERED_MODULE_PATH", { path: normalizedImported });
    }
    return;
  }

  if (
    importerModule.id === importedModule.id ||
    importedModule.publicEntrypoints.some(
      (entrypoint) => canonicalImportPath(entrypoint) === canonicalImportPath(normalizedImported),
    )
  ) {
    return;
  }

  throw new ModuleBoundaryError("CROSS_MODULE_INTERNAL_IMPORT", {
    importer: normalizedImporter,
    importerModule: importerModule.id,
    imported: normalizedImported,
    importedModule: importedModule.id,
  });
}

export function assertModuleWriteAllowed(writerModuleId: string, resource: string): void {
  if (!Object.hasOwn(MODULE_REGISTRY, writerModuleId)) {
    throw new ModuleBoundaryError("UNKNOWN_MODULE", { moduleId: writerModuleId });
  }

  const ownerModule = RESOURCE_OWNERS.get(resource);
  if (!ownerModule) {
    throw new ModuleBoundaryError("UNKNOWN_RESOURCE", { resource });
  }

  if (ownerModule !== writerModuleId) {
    throw new ModuleBoundaryError("CROSS_MODULE_WRITE", {
      writerModule: writerModuleId,
      resource,
      ownerModule,
    });
  }
}

function normalizeRepositoryPath(filePath: string): string {
  const segments: string[] = [];
  const repositoryPath = filePath.replaceAll("\\", "/").replace(/^@\//, "");

  for (const segment of repositoryPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function canonicalImportPath(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function isGovernedPath(filePath: string): boolean {
  return (
    filePath === "modules" ||
    filePath.startsWith("modules/") ||
    filePath === "workers" ||
    filePath.startsWith("workers/") ||
    filePath === "app" ||
    filePath.startsWith("app/") ||
    filePath === "components" ||
    filePath.startsWith("components/")
  );
}
