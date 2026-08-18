import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
  type RuntimeEnvironment,
} from "./runtime-environment.ts";

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FORBIDDEN_DATABASES = new Set(["postgres", "template0", "template1", "tianxing"]);
const FORBIDDEN_LOGIN_ROLES = new Set([
  "postgres",
  "tianxing_app",
  "tianxing_test_application",
  "tianxing_test_identity",
  "tianxing_migration",
  "tianxing_test_migration",
  "tianxing_test_provisioner",
]);
const PRIVILEGED_LOGIN_PURPOSE = /(?:^|_)(?:migration|provision|provisioner)(?:_|$)/;

export const TEST_IDENTITY_GROUP_ROLE = "tianxing_test_identity" as const;
export const TEST_APPLICATION_GROUP_ROLE = "tianxing_test_application" as const;
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

interface ParsedTestDatabaseEndpoint {
  readonly endpoint: TestDatabaseEndpoint;
  readonly passwordDigest: Buffer;
}

export interface TestDatabaseConfiguration {
  readonly identity: TestDatabaseEndpoint;
  readonly application: TestDatabaseEndpoint;
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

  const identity = endpoint(environment, "TEST_IDENTITY_DATABASE_URL", expectedName);
  let application: ParsedTestDatabaseEndpoint | undefined;
  try {
    application = endpoint(environment, "TEST_APPLICATION_DATABASE_URL", expectedName);
    if (identity.endpoint.host !== application.endpoint.host) {
      throw new RuntimeEnvironmentConfigurationError("TEST_APPLICATION_DATABASE_URL");
    }
    if (identity.endpoint.loginUser === application.endpoint.loginUser) {
      throw new RuntimeEnvironmentConfigurationError("TEST_APPLICATION_DATABASE_URL");
    }
    if (timingSafeEqual(identity.passwordDigest, application.passwordDigest)) {
      throw new RuntimeEnvironmentConfigurationError("TEST_APPLICATION_DATABASE_URL");
    }

    return Object.freeze({
      identity: identity.endpoint,
      application: application.endpoint,
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
  } finally {
    identity.passwordDigest.fill(0);
    application?.passwordDigest.fill(0);
  }
}

function endpoint(
  environment: RuntimeEnvironment,
  variable: string,
  expectedName: string,
): ParsedTestDatabaseEndpoint {
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
    loginUser.length === 0 ||
    FORBIDDEN_LOGIN_ROLES.has(loginUser) ||
    PRIVILEGED_LOGIN_PURPOSE.test(loginUser)
  ) {
    throw new RuntimeEnvironmentConfigurationError(variable);
  }
  return Object.freeze({
    endpoint: Object.freeze({
      connectionString: url.toString(),
      loginUser,
      databaseName,
      host,
    }),
    passwordDigest: createHash("sha256").update(password, "utf8").digest(),
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
