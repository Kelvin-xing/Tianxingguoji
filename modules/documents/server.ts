import "server-only";


export * from "./application/scan-service.ts";
export * from "./domain/p4-be-06-access.ts";
export * from "./application/object-receipt-service.ts";
export * from "./application/transfer-service.ts";
export * from "./application/version-service.ts";
export * from "./application/workspace-service.ts";
export * from "./infrastructure/object-store.ts";
export * from "./infrastructure/object-transport-port.ts";
export * from "./infrastructure/deterministic-fake-transport.ts";
export * from "./infrastructure/deterministic-fake-scanner.ts";
export * from "./infrastructure/policy-runtime.ts";
export * from "./infrastructure/production-repository.ts";
export * from "./infrastructure/postgresql-workspace-repository.ts";
export * from "./infrastructure/postgresql-transfer-repository.ts";
export * from "./infrastructure/postgresql-scan-repository.ts";
export * from "./infrastructure/scan-runtime.ts";
export * from "./infrastructure/version-runtime.ts";
export * from "./infrastructure/transfer-runtime.ts";
export * from "./infrastructure/workspace-runtime.ts";
export * from "./infrastructure/postgresql-clean-task-evidence.ts";

/** Binds the current session to the request-time capability union for every document operation. */
export async function requireDocumentActor() {
  const [{ requireIdentityActor }, { resolveCurrentRequestAccessContext }] = await Promise.all([
    import("../identity/web.ts"),
    import("../access/server.ts"),
  ]);
  const [identity, access] = await Promise.all([
    requireIdentityActor(),
    resolveCurrentRequestAccessContext(),
  ]);
  return Object.freeze({
    ...identity,
    organizationId: access.organizationId,
    userId: access.userId,
    role: access.roles.includes("founder") ? "founder" : access.roles.includes("advisor") ? "advisor" : identity.role,
    roles: access.roles,
    workspaceCapabilities: access.workspaceCapabilities,
  });
}
