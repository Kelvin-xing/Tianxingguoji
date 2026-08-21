import "server-only";

export const APP_ENVIRONMENTS = ["development", "test", "production"] as const;
export const APP_RUNTIME_MODES = ["local-synthetic", "test-database", "production-aws"] as const;
export const AUTH_MODES = ["local-synthetic", "database-test", "cognito"] as const;
export const TEST_WEB_FORBIDDEN_DATABASE_VARIABLES = Object.freeze([
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "ONE_ROLE_BASELINE_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TEST_IDENTITY_DATABASE_URL",
  "TEST_APPLICATION_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
  "TEST_PROVISION_DATABASE_URL",
  "NEON_AUTH_BASE_URL",
  "NEON_PROJECT_ID",
  "PGDATABASE",
  "PGHOST",
  "PGHOST_UNPOOLED",
  "PGPASSWORD",
  "PGUSER",
  "POSTGRES_DATABASE",
  "POSTGRES_HOST",
  "POSTGRES_PASSWORD",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_USER",
  "POSTGRES_URL_NO_SSL",
  "VITE_NEON_AUTH_URL",
] as const);

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
export type AppRuntimeMode = (typeof APP_RUNTIME_MODES)[number];
export type AuthMode = (typeof AUTH_MODES)[number];
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface RuntimeEnvironmentConfiguration {
  readonly appEnvironment: AppEnvironment;
  readonly nodeEnvironment: "development" | "production";
  readonly appRuntimeMode: AppRuntimeMode;
  readonly authMode: AuthMode;
  readonly vercel: false | Readonly<{
    environment: "preview" | "production";
  }>;
}

export class RuntimeEnvironmentConfigurationError extends Error {
  readonly code = "RUNTIME_CONFIGURATION_INVALID" as const;
  readonly variable: string;

  constructor(variable: string) {
    super(`Runtime environment configuration rejected ${variable}.`);
    this.name = "RuntimeEnvironmentConfigurationError";
    this.variable = variable;
  }
}

export function loadRuntimeEnvironment(
  environment: RuntimeEnvironment = process.env,
): RuntimeEnvironmentConfiguration {
  const appEnvironment = exact(environment, "APP_ENV", APP_ENVIRONMENTS);
  const nodeEnvironment = exact(
    environment,
    "NODE_ENV",
    ["development", "production"] as const,
  );
  const appRuntimeMode = exact(environment, "APP_RUNTIME_MODE", APP_RUNTIME_MODES);
  const authMode = exact(environment, "AUTH_MODE", AUTH_MODES);

  if (appEnvironment === "development") {
    requireValue(nodeEnvironment, "development", "NODE_ENV");
    requireValue(appRuntimeMode, "local-synthetic", "APP_RUNTIME_MODE");
    requireValue(authMode, "local-synthetic", "AUTH_MODE");
    rejectPresent(environment, "VERCEL");
    rejectPresent(environment, "VERCEL_ENV");
    rejectLegacyLocalDatabaseUrls(environment);
    return freezeConfiguration({
      appEnvironment,
      nodeEnvironment,
      appRuntimeMode,
      authMode,
      vercel: false,
    });
  }

  if (appEnvironment === "test") {
    requireValue(nodeEnvironment, "production", "NODE_ENV");
    requireValue(appRuntimeMode, "test-database", "APP_RUNTIME_MODE");
    requireValue(authMode, "database-test", "AUTH_MODE");
    requireValue(environment.VERCEL?.trim(), "1", "VERCEL");
    const vercelEnvironment = exact(
      environment,
      "VERCEL_ENV",
      ["preview", "production"] as const,
    );
    rejectTestWebSecrets(environment);
    return freezeConfiguration({
      appEnvironment,
      nodeEnvironment,
      appRuntimeMode,
      authMode,
      vercel: Object.freeze({ environment: vercelEnvironment }),
    });
  }

  requireValue(nodeEnvironment, "production", "NODE_ENV");
  requireValue(appRuntimeMode, "production-aws", "APP_RUNTIME_MODE");
  requireValue(authMode, "cognito", "AUTH_MODE");
  rejectPresent(environment, "VERCEL");
  rejectPresent(environment, "VERCEL_ENV");
  rejectProductionTestDatabaseUrls(environment);
  return freezeConfiguration({
    appEnvironment,
    nodeEnvironment,
    appRuntimeMode,
    authMode,
    vercel: false,
  });
}

function rejectProductionTestDatabaseUrls(environment: RuntimeEnvironment): void {
  for (const variable of [
    "TEST_DATABASE_URL",
    "TEST_IDENTITY_DATABASE_URL",
    "TEST_APPLICATION_DATABASE_URL",
    "TEST_PROVISION_DATABASE_URL",
    "TEST_MIGRATION_DATABASE_URL",
  ]) {
    rejectPresent(environment, variable);
  }
}

function rejectTestWebSecrets(environment: RuntimeEnvironment): void {
  for (const variable of TEST_WEB_FORBIDDEN_DATABASE_VARIABLES) {
    rejectPresent(environment, variable);
  }
  const localVariable = Object.keys(environment)
    .sort()
    .find((variable) => variable.startsWith("LOCAL_SYNTHETIC_") && present(environment[variable]));
  if (localVariable) throw new RuntimeEnvironmentConfigurationError(localVariable);
}

function rejectLegacyLocalDatabaseUrls(environment: RuntimeEnvironment): void {
  for (const variable of [
    "LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL",
    "LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL",
  ]) {
    rejectPresent(environment, variable);
  }
}

function exact<const Values extends readonly string[]>(
  environment: RuntimeEnvironment,
  variable: string,
  values: Values,
): Values[number] {
  const value = environment[variable]?.trim();
  if (!value || !(values as readonly string[]).includes(value)) {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return value as Values[number];
}

function requireValue(actual: string | undefined, expected: string, variable: string): void {
  if (actual !== expected) throw new RuntimeEnvironmentConfigurationError(variable);
}

function rejectPresent(environment: RuntimeEnvironment, variable: string): void {
  if (present(environment[variable])) throw new RuntimeEnvironmentConfigurationError(variable);
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function freezeConfiguration(
  configuration: RuntimeEnvironmentConfiguration,
): RuntimeEnvironmentConfiguration {
  return Object.freeze(configuration);
}
