import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  MODULE_REGISTRY,
  ModuleBoundaryError,
  type ModuleId,
  assertModuleImportAllowed,
  assertModuleWriteAllowed,
  getModuleForPath,
} from "../../modules/shared/architecture/module-registry.ts";

test("registers one owner for every authoritative resource", () => {
  const owners = new Map<string, string>();

  for (const definition of Object.values(MODULE_REGISTRY)) {
    for (const resource of definition.owns) {
      assert.equal(owners.has(resource), false, `${resource} has more than one owner`);
      owners.set(resource, definition.id);
    }
  }

  assert.equal(owners.get("User"), "identity");
  assert.equal(owners.get("Student"), "crm");
  assert.equal(owners.get("ServiceCase"), "cases");
  assert.equal(owners.get("Task"), "tasks");
  assert.equal(owners.get("DocumentVersion"), "documents");
  assert.equal(owners.get("AuditEvent"), "audit_operations");
  assert.equal(owners.get("PortalAccessGrant"), "external_portal_access");
  assert.equal(owners.get("PlatformBillingActor"), "platform_billing");
  assert.equal(owners.get("CustomerContract"), "platform_billing");
});

test("resolves files to the module owning their longest source root", () => {
  assert.equal(getModuleForPath("modules/cases/application/service.ts")?.id, "cases");
  assert.equal(getModuleForPath("@/modules/audit/query.ts")?.id, "audit_operations");
  assert.equal(getModuleForPath("app/api/v1/cases/route.ts")?.id, "adapters");
  assert.equal(getModuleForPath("workers/deliver-in-app.ts")?.id, "adapters");
  assert.equal(getModuleForPath("components/layout/Sidebar.tsx")?.id, "adapters");
  assert.equal(getModuleForPath("modules/external-portal/infrastructure/runtime.ts")?.id, "external_portal_access");
  assert.equal(getModuleForPath("modules/platform-billing/infrastructure/runtime.ts")?.id, "platform_billing");
});

test("allows internal imports and cross-module public contracts", () => {
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("modules/cases/application/service.ts", "modules/cases/repository.ts"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("modules/cases/application/service.ts", "@/modules/crm/public"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "modules/cases/application/service.ts",
      "modules/shared/public.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed("app/api/v1/cases/route.ts", "modules/cases/public.ts"),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "app/api/v1/health/route.ts",
      "modules/shared/public.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "app/api/v1/health/route.ts",
      "modules/shared/public.ts",
    ),
  );
});

test("rejects imports of another module's internals", () => {
  assertBoundaryError(
    () => assertModuleImportAllowed("modules/cases/application/service.ts", "modules/crm/repository.ts"),
    "CROSS_MODULE_INTERNAL_IMPORT",
    {
      importer: "modules/cases/application/service.ts",
      importerModule: "cases",
      imported: "modules/crm/repository.ts",
      importedModule: "crm",
    },
  );
  assertBoundaryError(
    () =>
      assertModuleImportAllowed(
        "modules/cases/application/service.ts",
        "modules/cases/../crm/repository.ts",
      ),
    "CROSS_MODULE_INTERNAL_IMPORT",
    {
      importer: "modules/cases/application/service.ts",
      importerModule: "cases",
      imported: "modules/crm/repository.ts",
      importedModule: "crm",
    },
  );
});

test("keeps reconstruction repository private across module seams", () => {
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "modules/access/application/service.ts",
      "modules/cases/public.ts",
    ),
  );
  assert.doesNotThrow(() =>
    assertModuleImportAllowed(
      "modules/access/application/service.ts",
      "modules/cases/server.ts",
    ),
  );
  assertBoundaryError(
    () =>
      assertModuleImportAllowed(
        "modules/access/application/service.ts",
        "modules/cases/infrastructure/reconstruction/postgresql-repository.ts",
      ),
    "CROSS_MODULE_INTERNAL_IMPORT",
    {
      importer: "modules/access/application/service.ts",
      importerModule: "access",
      imported: "modules/cases/infrastructure/reconstruction/postgresql-repository.ts",
      importedModule: "cases",
    },
  );
});

test("rejects unregistered paths under the governed module roots", () => {
  assertBoundaryError(
    () => assertModuleImportAllowed("modules/cases/application/service.ts", "modules/unregistered/internal.ts"),
    "UNREGISTERED_MODULE_PATH",
    { path: "modules/unregistered/internal.ts" },
  );
});

test("registers every governed source file and every declared public entrypoint", () => {
  const unregistered = governedSourceFiles()
    .map(toRepositoryPath)
    .filter((filePath) => getModuleForPath(filePath) === undefined);
  const missingEntrypoints = Object.values(MODULE_REGISTRY)
    .flatMap((definition) => definition.publicEntrypoints)
    .filter((entrypoint) => !existsSync(resolve(REPOSITORY_ROOT, entrypoint)));

  assert.deepEqual(unregistered, [], `Unregistered governed files:\n${unregistered.join("\n")}`);
  assert.deepEqual(
    missingEntrypoints,
    [],
    `Missing public entrypoints:\n${missingEntrypoints.join("\n")}`,
  );
});

test("keeps all real cross-module imports on declared public entrypoints", () => {
  const violations: string[] = [];

  for (const sourceFile of governedSourceFiles()) {
    const importer = toRepositoryPath(sourceFile);
    const source = readFileSync(sourceFile, "utf8");
    for (const specifier of staticModuleSpecifiers(sourceFile, source)) {
      const importedFile = resolveRepositoryImport(sourceFile, specifier);
      if (!importedFile) continue;

      const imported = toRepositoryPath(importedFile);
      try {
        assertModuleImportAllowed(importer, imported);
      } catch (error) {
        if (!(error instanceof ModuleBoundaryError)) throw error;
        violations.push(`${importer} -> ${imported} (${error.code})`);
      }
    }
  }

  assert.deepEqual(violations, [], `Module import violations:\n${violations.join("\n")}`);
});

test("keeps domain and application dependencies pointing inward", () => {
  const violations: string[] = [];

  for (const sourceFile of walkSourceFiles(resolve(REPOSITORY_ROOT, "modules"))) {
    const importer = toRepositoryPath(sourceFile);
    const importerLayer = moduleLayer(importer);
    if (!importerLayer || importerLayer.layer === "infrastructure") continue;

    const source = readFileSync(sourceFile, "utf8");
    for (const specifier of staticModuleSpecifiers(sourceFile, source)) {
      const importedFile = resolveRepositoryImport(sourceFile, specifier);
      if (!importedFile) continue;
      const imported = toRepositoryPath(importedFile);
      const importedLayer = moduleLayer(imported);
      if (!importedLayer || importedLayer.moduleName !== importerLayer.moduleName) continue;

      if (
        importerLayer.layer === "domain" && importedLayer.layer !== "domain" ||
        importerLayer.layer === "application" && importedLayer.layer === "infrastructure"
      ) {
        violations.push(`${importer} -> ${imported}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Layer dependency violations:\n${violations.join("\n")}`);
});

test("exposes each business module through explicit entrypoints", () => {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const moduleName of BUSINESS_MODULES) {
    for (const entrypointName of ["public.ts", "server.ts"] as const) {
      const entrypoint = resolve(REPOSITORY_ROOT, "modules", moduleName, entrypointName);
      if (!existsSync(entrypoint)) {
        missing.push(toRepositoryPath(entrypoint));
        continue;
      }
      const source = readFileSync(entrypoint, "utf8");
      if (entrypointName === "public.ts" && source.includes('import "server-only";')) {
        invalid.push(`${toRepositoryPath(entrypoint)} must remain runtime-neutral`);
      }
      if (entrypointName === "server.ts" && !source.includes('import "server-only";')) {
        invalid.push(`${toRepositoryPath(entrypoint)} must be server-only`);
      }
    }
  }

  assert.deepEqual(missing, [], `Missing module entrypoints:\n${missing.join("\n")}`);
  assert.deepEqual(invalid, [], `Invalid module entrypoints:\n${invalid.join("\n")}`);
});

test("keeps legacy lib limited to technical framework utilities", () => {
  const actual = walkSourceFiles(resolve(REPOSITORY_ROOT, "lib"))
    .map(toRepositoryPath)
    .sort();

  assert.deepEqual(actual, LEGACY_LIB_ALLOWLIST);
  assert.deepEqual(walkSourceFiles(resolve(REPOSITORY_ROOT, "adapters")), []);
});

test("keeps Future features free of runtime routes and persistence adapters", () => {
  const prohibited = [
    "app/ai/page.tsx",
    "app/admin/knowledge/page.tsx",
    "app/api/knowledge/route.ts",
    "modules/future/infrastructure/knowledge-db.ts",
  ];
  assert.deepEqual(prohibited.filter((path) => existsSync(resolve(REPOSITORY_ROOT, path))), []);
});

test("keeps SQL writes inside the module that owns each table", () => {
  const violations: string[] = [];

  for (const sourceFile of governedSourceFiles().filter((file) => file.includes(`${sep}modules${sep}`))) {
    const filePath = toRepositoryPath(sourceFile);
    const module = getModuleForPath(filePath);
    if (!module) continue;

    const source = readFileSync(sourceFile, "utf8");
    for (const table of sqlWriteTargets(source)) {
      const owner = tableOwner(table);
      if (owner !== undefined && owner !== "shared" && owner !== module.id) {
        violations.push(`${filePath} writes ${table} owned by ${owner}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Cross-module SQL writes:\n${violations.join("\n")}`);
});

test("marks repositories, database adapters, and runtime wiring as server-only", () => {
  const requiredServerOnlyFiles = [
    ...walkSourceFiles(resolve(REPOSITORY_ROOT, "modules")).filter((filePath) => {
      const name = filePath.split(sep).at(-1) ?? "";
      return name === "runtime.ts" ||
        name.endsWith("-runtime.ts") ||
        name.endsWith("-repository.ts") ||
        name === "postgresql.ts" ||
        name === "db.ts" ||
        name === "student-persistence.ts" ||
        name === "activation-cookie.ts" ||
        name === "cognito-adapter.ts";
    }),
    ...walkSourceFiles(resolve(REPOSITORY_ROOT, "lib/runtime")),
  ];
  const missingMarker = requiredServerOnlyFiles
    .filter((filePath) => !readFileSync(filePath, "utf8").includes('import "server-only";'))
    .map(toRepositoryPath)
    .sort();

  assert.deepEqual(
    missingMarker,
    [],
    `Server-only modules missing marker:\n${missingMarker.join("\n")}`,
  );
});

test("allows only the owning module to write an authoritative resource", () => {
  assert.doesNotThrow(() => assertModuleWriteAllowed("crm", "Student"));
  assert.doesNotThrow(() => assertModuleWriteAllowed("cases", "ServiceCase"));
  assert.doesNotThrow(() => assertModuleWriteAllowed("external_portal_access", "PortalSession"));
  assert.doesNotThrow(() => assertModuleWriteAllowed("platform_billing", "MonthlyTenantMetric"));

  assertBoundaryError(
    () => assertModuleWriteAllowed("cases", "Student"),
    "CROSS_MODULE_WRITE",
    { writerModule: "cases", resource: "Student", ownerModule: "crm" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("unknown", "Student"),
    "UNKNOWN_MODULE",
    { moduleId: "unknown" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("crm", "UnregisteredRecord"),
    "UNKNOWN_RESOURCE",
    { resource: "UnregisteredRecord" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("platform_billing", "Subscription"),
    "CROSS_MODULE_WRITE",
    { writerModule: "platform_billing", resource: "Subscription", ownerModule: "access" },
  );
  assertBoundaryError(
    () => assertModuleWriteAllowed("external_portal_access", "ServiceCase"),
    "CROSS_MODULE_WRITE",
    { writerModule: "external_portal_access", resource: "ServiceCase", ownerModule: "cases" },
  );
});

function assertBoundaryError(
  action: () => void,
  code: ModuleBoundaryError["code"],
  details: Record<string, string>,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ModuleBoundaryError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GOVERNED_ROOTS = ["modules", "app", "components", "workers"] as const;
const BUSINESS_MODULES = [
  "access",
  "audit",
  "cases",
  "crm",
  "documents",
  "external-portal",
  "future",
  "identity",
  "notifications",
  "operations",
  "platform-billing",
  "schools",
  "shared",
  "tasks",
] as const;
const LEGACY_LIB_ALLOWLIST = [
  "lib/api/client.ts",
  "lib/i18n-provider.tsx",
  "lib/runtime/local-synthetic-config.ts",
  "lib/runtime/local-synthetic-readiness.ts",
];
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const TEMPLATE_LITERAL = /`((?:\\[\s\S]|[^`])*)`/g;
const SQL_WRITE = /\b(?:insert\s+into|update|delete\s+from)\s+([a-z][a-z0-9_]*)/gi;

function governedSourceFiles(): string[] {
  return GOVERNED_ROOTS
    .flatMap((root) => walkSourceFiles(resolve(REPOSITORY_ROOT, root)))
    .sort();
}

function walkSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(entryPath);
    return entry.isFile() && SOURCE_EXTENSION.test(entry.name) ? [entryPath] : [];
  });
}

function staticModuleSpecifiers(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveRepositoryImport(importer: string, specifier: string): string | undefined {
  let unresolved: string;
  if (specifier.startsWith("@/")) {
    unresolved = resolve(REPOSITORY_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    unresolved = resolve(dirname(importer), specifier);
  } else {
    return undefined;
  }

  if (extname(unresolved) !== "") return existsSync(unresolved) ? unresolved : undefined;
  for (const candidate of [
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    resolve(unresolved, "index.ts"),
    resolve(unresolved, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function toRepositoryPath(filePath: string): string {
  return relative(REPOSITORY_ROOT, filePath).split(sep).join("/");
}

function moduleLayer(filePath: string): {
  moduleName: string;
  layer: "domain" | "application" | "infrastructure";
} | undefined {
  const match = filePath.match(/^modules\/([^/]+)\/(domain|application|infrastructure)\//);
  if (!match) return undefined;
  return {
    moduleName: match[1],
    layer: match[2] as "domain" | "application" | "infrastructure",
  };
}

function sqlWriteTargets(source: string): string[] {
  const tables: string[] = [];
  TEMPLATE_LITERAL.lastIndex = 0;
  for (const literal of source.matchAll(TEMPLATE_LITERAL)) {
    SQL_WRITE.lastIndex = 0;
    tables.push(...[...literal[1].matchAll(SQL_WRITE)].map((match) => match[1].toLowerCase()));
  }
  return tables;
}

function tableOwner(table: string): ModuleId | "shared" | undefined {
  if (table.startsWith("shared_")) return "shared";
  if (table.startsWith("identity_")) return "identity";
  if (table.startsWith("access_")) return "access";
  if (table.startsWith("crm_")) return "crm";
  if (table.startsWith("cases_")) return "cases";
  if (table.startsWith("tasks_")) return "tasks";
  if (table.startsWith("schools_")) return "schools";
  if (table.startsWith("documents_")) return "documents";
  if (table.startsWith("notifications_")) return "notifications";
  if (table.startsWith("audit_") || table.startsWith("operations_")) return "audit_operations";
  if (table.startsWith("portal_")) return "external_portal_access";
  if (table.startsWith("platform_")) return "platform_billing";
  return undefined;
}
