import "server-only";

import { isIP } from "node:net";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
  type RuntimeEnvironment,
} from "./runtime-environment.ts";

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FORBIDDEN_DATABASES = new Set(["postgres", "template0", "template1", "tianxing"]);
export const TEST_DATABASE_LOGIN_ROLE = "tianxing_app" as const;
export const TEST_DATABASE_TIMEOUT_LIMITS = Object.freeze({
  connection: Object.freeze({ minimumMs: 250, maximumMs: 5_000 }),
  statement: Object.freeze({ minimumMs: 1_000, maximumMs: 10_000 }),
});

export interface TestDatabaseEndpoint {
  readonly connectionString: string;
  readonly loginUser: string;
  readonly databaseName: string;
  readonly host: string;
}

export interface TestDatabaseConfiguration {
  readonly database: TestDatabaseEndpoint;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly poolMax: 1;
  readonly ssl: Readonly<{ rejectUnauthorized: true }>;
}

export function loadTestDatabaseConfiguration(
  environment: RuntimeEnvironment = process.env,
): TestDatabaseConfiguration {
  const runtime = loadRuntimeEnvironment(environment);
  if (runtime.appRuntimeMode !== "test-database") {
    throw new RuntimeEnvironmentConfigurationError("APP_RUNTIME_MODE");
  }

  const expectedName = required(environment, "TEST_DATABASE_EXPECTED_NAME");
  if (!DATABASE_NAME.test(expectedName) || FORBIDDEN_DATABASES.has(expectedName)) {
    throw new RuntimeEnvironmentConfigurationError("TEST_DATABASE_EXPECTED_NAME");
  }

  const database = endpoint(environment, "TEST_DATABASE_URL", expectedName);
  return Object.freeze({
    database,
    connectionTimeoutMs: integer(
      environment,
      "TEST_DATABASE_CONNECTION_TIMEOUT_MS",
      TEST_DATABASE_TIMEOUT_LIMITS.connection.minimumMs,
      TEST_DATABASE_TIMEOUT_LIMITS.connection.maximumMs,
    ),
    statementTimeoutMs: integer(
      environment,
      "TEST_DATABASE_STATEMENT_TIMEOUT_MS",
      TEST_DATABASE_TIMEOUT_LIMITS.statement.minimumMs,
      TEST_DATABASE_TIMEOUT_LIMITS.statement.maximumMs,
    ),
    poolMax: exactOne(environment, "TEST_DATABASE_POOL_MAX"),
    ssl: Object.freeze({ rejectUnauthorized: true }),
  });
}

function endpoint(
  environment: RuntimeEnvironment,
  variable: string,
  expectedName: string,
): TestDatabaseEndpoint {
  let url: URL;
  try {
    url = new URL(required(environment, variable));
  } catch {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  const host = url.hostname.toLowerCase();
  const databaseName = decodePathname(url, variable);
  const loginUser = decodeComponent(url.username, variable);
  const password = decodeComponent(url.password, variable);
  if (
    url.protocol !== "postgresql:" ||
    password.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.split("/").length !== 2 ||
    databaseName !== expectedName ||
    host.length === 0 ||
    isLoopbackOrIp(host) ||
    loginUser !== TEST_DATABASE_LOGIN_ROLE
  ) {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return Object.freeze({
    connectionString: url.toString(),
    loginUser,
    databaseName,
    host,
  });
}

function isLoopbackOrIp(host: string): boolean {
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return host === "localhost" || host.endsWith(".localhost") || host === "ip6-localhost" ||
    isIP(address) !== 0;
}

function decodePathname(url: URL, variable: string): string {
  return decodeComponent(url.pathname.slice(1), variable);
}

function decodeComponent(value: string, variable: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
}

function integer(
  environment: RuntimeEnvironment,
  variable: string,
  minimum: number,
  maximum: number,
): number {
  const value = required(environment, variable);
  if (!/^\d+$/.test(value)) throw new RuntimeEnvironmentConfigurationError(variable);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return parsed;
}

function exactOne(environment: RuntimeEnvironment, variable: string): 1 {
  if (required(environment, variable) !== "1") {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return 1;
}

function required(environment: RuntimeEnvironment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return value;
}
