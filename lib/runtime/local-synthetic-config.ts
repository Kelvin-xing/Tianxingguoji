import "server-only";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
} from "./runtime-environment.ts";

const LOCAL_MODE = "local-synthetic" as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalSyntheticConfig {
  readonly mode: typeof LOCAL_MODE;
  readonly database: Readonly<{
    connectionString: string;
  }>;
  readonly dependencyTimeoutMs: number;
  readonly organizationId?: string;
}

export class LocalSyntheticConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Local synthetic configuration rejected ${variable}.`);
    this.name = "LocalSyntheticConfigurationError";
    this.variable = variable;
  }
}

export function isLocalSyntheticMode(environment: Environment = process.env): boolean {
  try {
    return loadRuntimeEnvironment(environment).appRuntimeMode === LOCAL_MODE;
  } catch (error) {
    if (error instanceof RuntimeEnvironmentConfigurationError) return false;
    throw error;
  }
}

export function loadLocalSyntheticConfig(
  environment: Environment = process.env,
): LocalSyntheticConfig {
  try {
    const runtime = loadRuntimeEnvironment(environment);
    if (runtime.appRuntimeMode !== LOCAL_MODE) {
      throw new LocalSyntheticConfigurationError("APP_RUNTIME_MODE");
    }
  } catch (error) {
    if (error instanceof RuntimeEnvironmentConfigurationError) {
      throw new LocalSyntheticConfigurationError(error.variable);
    }
    throw error;
  }

  const databaseUrl = localUrl(
    environment,
    "LOCAL_SYNTHETIC_DATABASE_URL",
    new Set(["postgresql:"]),
  );
  if (
    databaseUrl.username !== "tianxing_app" ||
    databaseUrl.password.length === 0 ||
    databaseUrl.pathname !== "/tianxing" ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_DATABASE_URL");
  }

  const dependencyTimeoutMs = integer(
    environment,
    "LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS",
    250,
    10_000,
  );
  const organizationId = environment.LOCAL_SYNTHETIC_ORGANIZATION_ID?.trim();
  if (organizationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_ORGANIZATION_ID");
  }

  return Object.freeze({
    mode: LOCAL_MODE,
    database: Object.freeze({
      connectionString: databaseUrl.toString(),
    }),
    dependencyTimeoutMs,
    ...(organizationId ? { organizationId } : {}),
  });
}

function localUrl(
  environment: Environment,
  variable: string,
  allowedProtocols: ReadonlySet<string>,
): URL {
  const raw = required(environment, variable);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalSyntheticConfigurationError(variable);
  }

  if (!allowedProtocols.has(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new LocalSyntheticConfigurationError(variable);
  }
  return url;
}

function integer(
  environment: Environment,
  variable: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(environment, variable);
  if (!/^\d+$/.test(raw)) {
    throw new LocalSyntheticConfigurationError(variable);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LocalSyntheticConfigurationError(variable);
  }
  return value;
}

function required(environment: Environment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new LocalSyntheticConfigurationError(variable);
  }
  return value;
}
