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
      "modules/shared/api-contract.ts",
      "modules/shared/db.ts",
      "modules/shared/decision-guards.ts",
      "modules/shared/idempotency.ts",
      "modules/shared/module-registry.ts",
      "modules/shared/request-context.ts",
    ],
    owns: ["IdempotencyRecord"],
  }),
  identity: defineModule({
    id: "identity",
    sourceRoots: ["modules/identity"],
    publicEntrypoints: [
      "modules/identity/activation-cookie.ts",
      "modules/identity/actor.ts",
      "modules/identity/contract.ts",
      "modules/identity/revoke-workflow.ts",
      "modules/identity/runtime.ts",
      "modules/identity/service.ts",
    ],
    owns: ["User", "Session", "Invite"],
  }),
  access: defineModule({
    id: "access",
    sourceRoots: ["modules/access"],
    publicEntrypoints: [
      "modules/access/contract.ts",
      "modules/access/runtime.ts",
      "modules/access/service.ts",
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
      "modules/crm/contract.ts",
      "modules/crm/guardian-relationship-service.ts",
      "modules/crm/runtime.ts",
      "modules/crm/service.ts",
      "modules/crm/student-persistence.ts",
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
      "modules/cases/assessment-service.ts",
      "modules/cases/contract.ts",
      "modules/cases/outcome-runtime.ts",
      "modules/cases/outcome-service.ts",
      "modules/cases/runtime.ts",
      "modules/cases/schema-resolver.ts",
      "modules/cases/school-target-runtime.ts",
      "modules/cases/school-target-service.ts",
      "modules/cases/service.ts",
      "modules/cases/transition-policy.ts",
      "modules/cases/transition-runtime.ts",
      "modules/cases/transition-service.ts",
      "modules/cases/reconstruction/contract.ts",
      "modules/cases/reconstruction/route-contract.ts",
      "modules/cases/reconstruction/runtime.ts",
      "modules/cases/reconstruction/service.ts",
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
      "ReconstructionEvent",
      "ReconstructionGap",
    ],
  }),
  tasks: defineModule({
    id: "tasks",
    sourceRoots: ["modules/tasks"],
    publicEntrypoints: [
      "modules/tasks/contract.ts",
      "modules/tasks/contractor-route.ts",
      "modules/tasks/contractor-workspace-runtime.ts",
      "modules/tasks/runtime.ts",
      "modules/tasks/service.ts",
    ],
    owns: ["Task", "TaskAssignment"],
  }),
  schools: defineModule({
    id: "schools",
    sourceRoots: ["modules/schools"],
    publicEntrypoints: [
      "modules/schools/contract.ts",
      "modules/schools/governance-service.ts",
      "modules/schools/resolved-view-runtime.ts",
      "modules/schools/resolved-view.ts",
      "modules/schools/runtime.ts",
      "modules/schools/school-governance-runtime.ts",
      "modules/schools/service.ts",
    ],
    owns: [
      "School",
      "ProvisionalSchool",
      "SchoolChangeRequest",
      "OverlayRevision",
      "PublishedSnapshot",
      "Manifest",
    ],
  }),
  documents: defineModule({
    id: "documents",
    sourceRoots: ["modules/documents"],
    publicEntrypoints: [
      "modules/documents/contract.ts",
      "modules/documents/runtime.ts",
      "modules/documents/scan-runtime.ts",
      "modules/documents/scan-service.ts",
      "modules/documents/upload-service.ts",
      "modules/documents/version-runtime.ts",
      "modules/documents/version-service.ts",
    ],
    owns: ["Document", "DocumentVersion", "ScanResult"],
  }),
  notifications: defineModule({
    id: "notifications",
    sourceRoots: ["modules/notifications"],
    publicEntrypoints: [
      "modules/notifications/contract.ts",
      "modules/notifications/runtime.ts",
      "modules/notifications/service.ts",
    ],
    owns: ["Notification", "DeliveryReceipt"],
  }),
  audit_operations: defineModule({
    id: "audit_operations",
    sourceRoots: ["modules/audit", "modules/operations"],
    publicEntrypoints: [
      "modules/audit/contract.ts",
      "modules/audit/production-repository.ts",
      "modules/operations/case-dashboard-route.ts",
      "modules/operations/case-dashboard-runtime.ts",
      "modules/operations/telemetry-contract.ts",
      "modules/operations/telemetry-policy.ts",
      "modules/operations/telemetry-service.ts",
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
      "modules/external-portal/contract.ts",
      "modules/external-portal/policy.ts",
      "modules/external-portal/runtime.ts",
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
      "modules/platform-billing/contract.ts",
      "modules/platform-billing/policy.ts",
      "modules/platform-billing/runtime.ts",
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
    publicEntrypoints: ["modules/future/feature-contracts.ts"],
    owns: [],
  }),
  adapters: defineModule({
    id: "adapters",
    sourceRoots: ["app/api/v1", "workers"],
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
    filePath === "app/api/v1" ||
    filePath.startsWith("app/api/v1/")
  );
}
