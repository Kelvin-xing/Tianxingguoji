export type ReleaseOneModuleId =
  | "shared"
  | "identity"
  | "access"
  | "crm"
  | "schools"
  | "cases"
  | "tasks"
  | "documents"
  | "notifications"
  | "audit"
  | "operations"
  | "external_portal";

export type HistoricalModuleId =
  | "platform_billing"
  | "future";

export type ModuleId = ReleaseOneModuleId | HistoricalModuleId | "adapters";
export type ModuleReleaseOneState = "active" | "historical_isolated" | "adapter";

export interface ModuleDefinition {
  readonly id: ModuleId;
  readonly releaseOneState: ModuleReleaseOneState;
  readonly sourceRoots: readonly string[];
  readonly publicEntrypoints: readonly string[];
  readonly historicalEntrypoints: readonly string[];
  readonly retainedHistoricalImporters: readonly string[];
  readonly owns: readonly string[];
  readonly historicalOwns: readonly string[];
}

export type ModuleBoundaryErrorCode =
  | "UNKNOWN_MODULE"
  | "UNKNOWN_RESOURCE"
  | "UNREGISTERED_MODULE_PATH"
  | "CROSS_MODULE_INTERNAL_IMPORT"
  | "HISTORICAL_ENTRYPOINT_IMPORT"
  | "RELEASE_ONE_MODULE_INACTIVE"
  | "RELEASE_ONE_RESOURCE_INACTIVE"
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
    historicalEntrypoints: Object.freeze([...definition.historicalEntrypoints]),
    retainedHistoricalImporters: Object.freeze([...definition.retainedHistoricalImporters]),
    owns: Object.freeze([...definition.owns]),
    historicalOwns: Object.freeze([...definition.historicalOwns]),
  });
}

export const RELEASE_ONE_ACTIVE_MODULE_IDS = Object.freeze([
  "shared",
  "identity",
  "access",
  "crm",
  "schools",
  "cases",
  "tasks",
  "documents",
  "notifications",
  "audit",
  "operations",
  "external_portal",
] as const satisfies readonly ReleaseOneModuleId[]);

export const MODULE_REGISTRY = Object.freeze({
  shared: defineModule({
    id: "shared",
    releaseOneState: "active",
    sourceRoots: ["modules/shared"],
    publicEntrypoints: [
      "modules/shared/public.ts",
      "modules/shared/server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["IdempotencyRecord"],
    historicalOwns: [],
  }),
  identity: defineModule({
    id: "identity",
    releaseOneState: "active",
    sourceRoots: ["modules/identity"],
    publicEntrypoints: [
      "modules/identity/public.ts",
      "modules/identity/server.ts",
      "modules/identity/web.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["User", "Session", "Invite"],
    historicalOwns: [],
  }),
  access: defineModule({
    id: "access",
    releaseOneState: "active",
    sourceRoots: ["modules/access"],
    publicEntrypoints: [
      "modules/access/public.ts",
      "modules/access/server.ts",
      "modules/access/client.ts",
    ],
    owns: [
      "Organization",
      "OrganizationMembership",
      "RoleBinding",
      "CaseCollaborator",
      "ScopeGrant",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    historicalOwns: ["Subscription", "Entitlement", "SupportGrant"],
  }),
  crm: defineModule({
    id: "crm",
    releaseOneState: "active",
    sourceRoots: ["modules/crm"],
    publicEntrypoints: [
      "modules/crm/public.ts",
      "modules/crm/server.ts",
      "modules/crm/client.ts",
    ],
    historicalEntrypoints: ["modules/crm/legacy-server.ts"],
    retainedHistoricalImporters: ["app/api/v1/crm/duplicate-handler.ts"],
    owns: [
      "ReferralSource",
      "Student",
      "Guardian",
      "StudentGuardianRelationship",
    ],
    historicalOwns: ["DuplicateCandidate", "MergeRevision"],
  }),
  cases: defineModule({
    id: "cases",
    releaseOneState: "active",
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
      "CaseReferralSourceAssignment",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    historicalOwns: [
      "CaseReconstruction",
      "ReconstructionVersion",
      "ReconstructionEvent",
      "ReconstructionGap",
    ],
  }),
  tasks: defineModule({
    id: "tasks",
    releaseOneState: "active",
    sourceRoots: ["modules/tasks"],
    publicEntrypoints: ["modules/tasks/client.ts", "modules/tasks/public.ts", "modules/tasks/server.ts"],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["Task", "TaskAssignment"],
    historicalOwns: [],
  }),
  schools: defineModule({
    id: "schools",
    releaseOneState: "active",
    sourceRoots: ["modules/schools"],
    publicEntrypoints: [
      "modules/schools/public.ts",
      "modules/schools/server.ts",
      "modules/schools/client.ts",
      "modules/schools/crawler-server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: [
      "School",
      "ProvisionalSchool",
      "SchoolChangeRequest",
      "OverlayRevision",
      "ResolvedSchoolRevision",
      "PublishedSnapshot",
      "Manifest",
    ],
    historicalOwns: [],
  }),
  documents: defineModule({
    id: "documents",
    releaseOneState: "active",
    sourceRoots: ["modules/documents"],
    publicEntrypoints: [
      "modules/documents/public.ts",
      "modules/documents/server.ts",
      "modules/documents/client.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["Document", "DocumentVersion", "ScanResult"],
    historicalOwns: [],
  }),
  notifications: defineModule({
    id: "notifications",
    releaseOneState: "active",
    sourceRoots: ["modules/notifications"],
    publicEntrypoints: ["modules/notifications/public.ts", "modules/notifications/server.ts"],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["Notification", "DeliveryReceipt"],
    historicalOwns: [],
  }),
  audit: defineModule({
    id: "audit",
    releaseOneState: "active",
    sourceRoots: ["modules/audit"],
    publicEntrypoints: [
      "modules/audit/public.ts",
      "modules/audit/server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: ["AuditEvent", "Outbox"],
    historicalOwns: [],
  }),
  operations: defineModule({
    id: "operations",
    releaseOneState: "active",
    sourceRoots: ["modules/operations"],
    publicEntrypoints: [
      "modules/operations/public.ts",
      "modules/operations/server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: [
      "Alert",
      "Incident",
      "RestoreEvidence",
      "ProductTelemetryEvent",
      "TelemetryRetentionManifest",
      "TelemetryOperationsState",
    ],
    historicalOwns: [],
  }),
  external_portal: defineModule({
    id: "external_portal",
    releaseOneState: "active",
    sourceRoots: ["modules/external-portal"],
    publicEntrypoints: [
      "modules/external-portal/public.ts",
      "modules/external-portal/server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: [
      "PortalViewer",
      "PortalAccessGrant",
      "PortalSession",
      "PortalSecurityEvent",
    ],
    historicalOwns: [],
  }),
  platform_billing: defineModule({
    id: "platform_billing",
    releaseOneState: "historical_isolated",
    sourceRoots: ["modules/platform-billing"],
    publicEntrypoints: [
      "modules/platform-billing/public.ts",
      "modules/platform-billing/server.ts",
    ],
    historicalEntrypoints: [],
    retainedHistoricalImporters: ["app/api/v1/platform/billing/overview/handler.ts"],
    owns: [],
    historicalOwns: [
      "PlatformBillingActor",
      "CustomerContract",
      "MonthlyTenantMetric",
      "PlatformSubscriptionProjection",
      "PlatformAuditEvent",
    ],
  }),
  future: defineModule({
    id: "future",
    releaseOneState: "historical_isolated",
    sourceRoots: ["modules/future"],
    publicEntrypoints: ["modules/future/public.ts", "modules/future/server.ts"],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: [],
    historicalOwns: [],
  }),
  adapters: defineModule({
    id: "adapters",
    releaseOneState: "adapter",
    sourceRoots: ["app", "components", "workers"],
    publicEntrypoints: [],
    historicalEntrypoints: [],
    retainedHistoricalImporters: [],
    owns: [],
    historicalOwns: [],
  }),
} as const satisfies Readonly<Record<ModuleId, ModuleDefinition>>);

const MODULES_BY_LONGEST_ROOT = Object.values(MODULE_REGISTRY)
  .flatMap((definition) => definition.sourceRoots.map((root) => ({ definition, root })))
  .sort((left, right) => right.root.length - left.root.length);

const RESOURCE_OWNERS = new Map<string, { readonly moduleId: ModuleId; readonly active: boolean }>();
for (const definition of Object.values(MODULE_REGISTRY)) {
  for (const [resource, active] of [
    ...definition.owns.map((name) => [name, true] as const),
    ...definition.historicalOwns.map((name) => [name, false] as const),
  ]) {
    if (RESOURCE_OWNERS.has(resource)) {
      throw new Error(`Authoritative resource has multiple owners: ${resource}`);
    }
    RESOURCE_OWNERS.set(resource, Object.freeze({ moduleId: definition.id, active }));
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

  if (importerModule.id === importedModule.id) {
    return;
  }

  const importsHistoricalEntrypoint = importedModule.historicalEntrypoints.some(
    (entrypoint) => canonicalImportPath(entrypoint) === canonicalImportPath(normalizedImported),
  );
  const importsHistoricalModule = importedModule.releaseOneState === "historical_isolated";
  if (importsHistoricalEntrypoint || importsHistoricalModule) {
    if (importedModule.retainedHistoricalImporters.includes(normalizedImporter)) {
      return;
    }
    throw new ModuleBoundaryError("HISTORICAL_ENTRYPOINT_IMPORT", {
      importer: normalizedImporter,
      imported: normalizedImported,
      importedModule: importedModule.id,
    });
  }

  if (
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

  const writerModule = MODULE_REGISTRY[writerModuleId as keyof typeof MODULE_REGISTRY];
  if (writerModule.releaseOneState !== "active") {
    throw new ModuleBoundaryError("RELEASE_ONE_MODULE_INACTIVE", { moduleId: writerModuleId });
  }

  const ownerModule = RESOURCE_OWNERS.get(resource);
  if (!ownerModule) {
    throw new ModuleBoundaryError("UNKNOWN_RESOURCE", { resource });
  }

  if (!ownerModule.active) {
    throw new ModuleBoundaryError("RELEASE_ONE_RESOURCE_INACTIVE", {
      resource,
      ownerModule: ownerModule.moduleId,
    });
  }

  if (ownerModule.moduleId !== writerModuleId) {
    throw new ModuleBoundaryError("CROSS_MODULE_WRITE", {
      writerModule: writerModuleId,
      resource,
      ownerModule: ownerModule.moduleId,
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
