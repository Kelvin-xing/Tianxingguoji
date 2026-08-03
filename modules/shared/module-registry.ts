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
      "modules/shared/contract.ts",
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
    publicEntrypoints: ["modules/identity/contract.ts"],
    owns: ["User", "Session", "Invite"],
  }),
  access: defineModule({
    id: "access",
    sourceRoots: ["modules/access"],
    publicEntrypoints: ["modules/access/contract.ts"],
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
    publicEntrypoints: ["modules/crm/contract.ts"],
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
    publicEntrypoints: ["modules/cases/contract.ts"],
    owns: [
      "ServiceCase",
      "Assessment",
      "SchemaManifest",
      "Answer",
      "SchoolTarget",
      "CaseOutcome",
      "ServiceGoalOutcome",
    ],
  }),
  tasks: defineModule({
    id: "tasks",
    sourceRoots: ["modules/tasks"],
    publicEntrypoints: ["modules/tasks/contract.ts"],
    owns: ["Task", "TaskAssignment"],
  }),
  schools: defineModule({
    id: "schools",
    sourceRoots: ["modules/schools"],
    publicEntrypoints: ["modules/schools/contract.ts"],
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
    publicEntrypoints: ["modules/documents/contract.ts"],
    owns: ["Document", "DocumentVersion", "ScanResult"],
  }),
  notifications: defineModule({
    id: "notifications",
    sourceRoots: ["modules/notifications"],
    publicEntrypoints: ["modules/notifications/contract.ts"],
    owns: ["Notification", "DeliveryReceipt"],
  }),
  audit_operations: defineModule({
    id: "audit_operations",
    sourceRoots: ["modules/audit", "modules/operations"],
    publicEntrypoints: ["modules/audit/contract.ts", "modules/operations/contract.ts"],
    owns: ["AuditEvent", "Outbox", "Alert", "Incident", "RestoreEvidence"],
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
