import "server-only";

const LOCAL_MODE = "local-synthetic" as const;
const HK_REGION = "ap-east-1" as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SQS_QUEUE = /^[A-Za-z0-9_-]{1,80}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalSyntheticConfig {
  readonly mode: typeof LOCAL_MODE;
  readonly database: Readonly<{
    connectionString: string;
    identityConnectionString: string;
  }>;
  readonly localstack: Readonly<{
    endpoint: string;
    region: typeof HK_REGION;
    bucket: string;
    queue: string;
    deadLetterQueue: string;
  }>;
  readonly clamav: Readonly<{
    host: string;
    port: number;
  }>;
  readonly dependencyTimeoutMs: number;
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
  return environment.APP_RUNTIME_MODE?.trim() === LOCAL_MODE;
}

export function loadLocalSyntheticConfig(
  environment: Environment = process.env,
): LocalSyntheticConfig {
  if (!isLocalSyntheticMode(environment)) {
    throw new LocalSyntheticConfigurationError("APP_RUNTIME_MODE");
  }
  if (environment.NODE_ENV?.trim() === "production") {
    throw new LocalSyntheticConfigurationError("NODE_ENV");
  }

  const databaseUrl = localUrl(
    environment,
    "LOCAL_SYNTHETIC_DATABASE_URL",
    new Set(["postgresql:"]),
  );
  if (
    databaseUrl.username !== "tianxing_health" ||
    databaseUrl.password.length === 0 ||
    databaseUrl.pathname !== "/tianxing" ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_DATABASE_URL");
  }

  const identityDatabaseUrl = localUrl(
    environment,
    "LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL",
    new Set(["postgresql:"]),
  );
  if (
    identityDatabaseUrl.username !== "tianxing_local_identity" ||
    identityDatabaseUrl.password.length === 0 ||
    identityDatabaseUrl.pathname !== "/tianxing" ||
    identityDatabaseUrl.search.length > 0 ||
    identityDatabaseUrl.hash.length > 0
  ) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL");
  }

  const localstackUrl = localUrl(
    environment,
    "LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT",
    new Set(["http:"]),
  );
  if (
    localstackUrl.username.length > 0 ||
    localstackUrl.password.length > 0 ||
    (localstackUrl.pathname !== "/" && localstackUrl.pathname !== "") ||
    localstackUrl.search.length > 0 ||
    localstackUrl.hash.length > 0
  ) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_LOCALSTACK_ENDPOINT");
  }

  const region = required(environment, "LOCAL_SYNTHETIC_AWS_REGION");
  if (region !== HK_REGION) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_AWS_REGION");
  }

  const bucket = required(environment, "LOCAL_SYNTHETIC_S3_BUCKET");
  if (!S3_BUCKET.test(bucket) || /^\d+(?:\.\d+){3}$/.test(bucket)) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_S3_BUCKET");
  }

  const queue = queueName(environment, "LOCAL_SYNTHETIC_SQS_QUEUE");
  const deadLetterQueue = queueName(environment, "LOCAL_SYNTHETIC_SQS_DLQ");
  if (queue === deadLetterQueue) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_SQS_DLQ");
  }

  const clamavHost = required(environment, "LOCAL_SYNTHETIC_CLAMAV_HOST").toLowerCase();
  if (!LOOPBACK_HOSTS.has(clamavHost)) {
    throw new LocalSyntheticConfigurationError("LOCAL_SYNTHETIC_CLAMAV_HOST");
  }

  const clamavPort = integer(environment, "LOCAL_SYNTHETIC_CLAMAV_PORT", 1, 65_535);
  const dependencyTimeoutMs = integer(
    environment,
    "LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS",
    250,
    10_000,
  );

  return Object.freeze({
    mode: LOCAL_MODE,
    database: Object.freeze({
      connectionString: databaseUrl.toString(),
      identityConnectionString: identityDatabaseUrl.toString(),
    }),
    localstack: Object.freeze({
      endpoint: localstackUrl.origin,
      region,
      bucket,
      queue,
      deadLetterQueue,
    }),
    clamav: Object.freeze({ host: clamavHost, port: clamavPort }),
    dependencyTimeoutMs,
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

function queueName(environment: Environment, variable: string): string {
  const value = required(environment, variable);
  if (!SQS_QUEUE.test(value)) {
    throw new LocalSyntheticConfigurationError(variable);
  }
  return value;
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
