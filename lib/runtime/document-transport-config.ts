import "server-only";

import {
  loadRuntimeEnvironment,
  RuntimeEnvironmentConfigurationError,
  type RuntimeEnvironment,
} from "./runtime-environment.ts";

const HK_REGION = "ap-east-1" as const;
const FAKE_MODE = "deterministic-fake" as const;
const S3_MODE = "production-s3" as const;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type DocumentTransportConfig =
  | Readonly<{
      mode: typeof FAKE_MODE;
      region: typeof HK_REGION;
      bucket: string;
      origin: string;
      signingSecret: string;
      organizationId: string;
      workerContextId: string;
    }>
  | Readonly<{
      mode: typeof S3_MODE;
      region: typeof HK_REGION;
      bucket: string;
    }>;

export class DocumentTransportConfigurationError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Document transport configuration rejected ${variable}.`);
    this.name = "DocumentTransportConfigurationError";
    this.variable = variable;
  }
}

export function loadDocumentTransportConfig(
  environment: RuntimeEnvironment = process.env,
): DocumentTransportConfig {
  let runtime: ReturnType<typeof loadRuntimeEnvironment>;
  try {
    runtime = loadRuntimeEnvironment(environment);
  } catch (error) {
    if (error instanceof RuntimeEnvironmentConfigurationError) {
      throw new DocumentTransportConfigurationError(error.variable);
    }
    throw error;
  }

  const mode = required(environment, "DOCUMENT_TRANSPORT_MODE");
  if (runtime.appRuntimeMode === "production-aws") {
    if (mode !== S3_MODE) invalid("DOCUMENT_TRANSPORT_MODE");
    rejectPresent(environment, "DOCUMENT_FAKE_ORIGIN");
    rejectPresent(environment, "DOCUMENT_FAKE_SIGNING_SECRET");
    rejectPresent(environment, "DOCUMENT_FAKE_ORGANIZATION_ID");
    rejectPresent(environment, "DOCUMENT_FAKE_WORKER_CONTEXT_ID");
    return Object.freeze({
      mode: S3_MODE,
      region: region(environment, "DOCUMENT_S3_REGION"),
      bucket: bucket(environment, "DOCUMENT_S3_BUCKET"),
    });
  }

  if (mode !== FAKE_MODE) invalid("DOCUMENT_TRANSPORT_MODE");
  rejectPresent(environment, "DOCUMENT_S3_BUCKET");
  rejectPresent(environment, "DOCUMENT_S3_REGION");
  const origin = fakeOrigin(environment, runtime.appRuntimeMode);
  const signingSecret = required(environment, "DOCUMENT_FAKE_SIGNING_SECRET");
  if (signingSecret.length < 32 || signingSecret.length > 256) {
    invalid("DOCUMENT_FAKE_SIGNING_SECRET");
  }
  const organizationId = uuid(environment, "DOCUMENT_FAKE_ORGANIZATION_ID");
  const workerContextId = uuid(environment, "DOCUMENT_FAKE_WORKER_CONTEXT_ID");
  if (organizationId === workerContextId) invalid("DOCUMENT_FAKE_WORKER_CONTEXT_ID");
  return Object.freeze({
    mode: FAKE_MODE,
    region: region(environment, "DOCUMENT_FAKE_REGION"),
    bucket: bucket(environment, "DOCUMENT_FAKE_BUCKET"),
    origin,
    signingSecret,
    organizationId,
    workerContextId,
  });
}

function fakeOrigin(environment: RuntimeEnvironment, runtimeMode: string): string {
  const variable = "DOCUMENT_FAKE_ORIGIN";
  let value: URL;
  try {
    value = new URL(required(environment, variable));
  } catch {
    invalid(variable);
  }
  const local = runtimeMode === "local-synthetic";
  if ((local && (value.protocol !== "http:" || !LOOPBACK.has(value.hostname.toLowerCase()))) ||
      (!local && value.protocol !== "https:") || value.username !== "" || value.password !== "" ||
      (value.pathname !== "/" && value.pathname !== "") || value.search !== "" || value.hash !== "") {
    invalid(variable);
  }
  return value.origin;
}

function region(environment: RuntimeEnvironment, variable: string): typeof HK_REGION {
  if (required(environment, variable) !== HK_REGION) invalid(variable);
  return HK_REGION;
}

function bucket(environment: RuntimeEnvironment, variable: string): string {
  const value = required(environment, variable);
  if (!BUCKET.test(value) || /^\d+(?:\.\d+){3}$/.test(value)) invalid(variable);
  return value;
}

function uuid(environment: RuntimeEnvironment, variable: string): string {
  const value = required(environment, variable);
  if (!UUID.test(value)) invalid(variable);
  return value;
}

function required(environment: RuntimeEnvironment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) invalid(variable);
  return value;
}

function rejectPresent(environment: RuntimeEnvironment, variable: string): void {
  if (environment[variable]?.trim()) invalid(variable);
}

function invalid(variable: string): never {
  throw new DocumentTransportConfigurationError(variable);
}
