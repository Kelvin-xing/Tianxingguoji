import {
  API_VERSION,
  type JsonValue,
} from "../../../shared/public.ts";
import type { RequestContext } from "../../../shared/public.ts";
import {
  RECONSTRUCTION_ERROR_METADATA,
  ReconstructionError,
  type ReconstructionCreateCommand,
  type ReconstructionErrorCode,
  type ReconstructionResult,
} from "../../domain/reconstruction/contract.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PILOT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const RECONSTRUCTION_ACTIONS = Object.freeze([
  "record-event",
  "record-gap",
  "submit",
  "request-changes",
  "create-next-draft",
  "approve",
  "activate",
  "append-correction",
] as const);

export function isCaseReconstructionEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.CASE_RECONSTRUCTION_ENABLED === "true";
}

/** Compatibility predicate used by the route contract harness. */
export function isReconstructionEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function buildReconstructionCommand(
  body: unknown,
  headers: { readonly requestId: string; readonly idempotencyKey: string },
  action: string,
): Record<string, unknown> {
  const normalizedAction = action.replaceAll("_", "-");
  if (!RECONSTRUCTION_ACTIONS.includes(normalizedAction as (typeof RECONSTRUCTION_ACTIONS)[number])) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !/^\d{1,20}$/.test(String((body as Record<string, unknown>).expected_record_version))
  ) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  const source = body as Record<string, unknown>;
  const result: Record<string, unknown> = {
    expectedRecordVersion: Number(source.expected_record_version),
    requestId: headers.requestId,
    idempotencyKey: headers.idempotencyKey,
  };
  if (normalizedAction === "record-event") {
    const event = source.event;
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
    }
    const item = event as Record<string, unknown>;
    result.event = {
      eventType: item.event_type,
      occurredAt: item.occurred_at,
      sequenceNo: item.sequence_no,
      evidenceType: item.evidence_type,
      evidenceRef: item.evidence_ref,
    };
  }
  return result;
}

export async function parseCreateDraftRequest(
  request: Request,
  requestId: string,
): Promise<ReconstructionCreateCommand> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }

  return request.json().then((body: unknown) => {
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).pilot_reference !== "string" ||
      !PILOT_REFERENCE.test((body as Record<string, unknown>).pilot_reference as string)
    ) {
      throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
    }
    return {
      pilotReference: (body as Record<string, string>).pilot_reference,
      requestId,
      idempotencyKey,
    };
  });
}

export function parseExpectedRecordVersion(request: Request): number {
  const raw = request.headers.get("x-expected-record-version");
  if (!raw || !/^\d{1,20}$/.test(raw)) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  return value;
}

export function reconstructionResultData(result: ReconstructionResult): JsonValue {
  return {
    reconstruction_id: result.reconstruction.id,
    version_id: result.version.id,
    state: result.reconstruction.state,
    record_version: result.reconstruction.recordVersion,
    outcome: result.metadata.outcome,
  };
}

export function methodNotAllowedResponse(context: RequestContext, allow: string): Response {
  return jsonResponse(
    context,
    {
      api_version: API_VERSION,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "The request method is not allowed.",
        request_id: context.requestId,
        retryable: false,
        details: {},
      },
    },
    405,
    allow,
  );
}

export function reconstructionErrorResponse(context: RequestContext, error: unknown): Response {
  if (error instanceof ReconstructionFeatureDisabledError) {
    return jsonResponse(
      context,
      {
        api_version: API_VERSION,
        error: {
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
          request_id: context.requestId,
          retryable: false,
          details: {},
        },
      },
      404,
    );
  }
  const mapped = mapReconstructionError(error);
  const metadata = RECONSTRUCTION_ERROR_METADATA[mapped.code];
  const details =
    mapped instanceof ReconstructionError && mapped.currentRecordVersion !== null
      ? { current_version: mapped.currentRecordVersion }
      : {};
  return jsonResponse(
    context,
    {
      api_version: API_VERSION,
      error: {
        code: mapped.code,
        message: `Case reconstruction request rejected: ${mapped.code}.`,
        request_id: context.requestId,
        retryable: metadata.retryable,
        details,
      },
    },
    metadata.httpStatus,
  );
}

export class ReconstructionFeatureDisabledError extends Error {
  constructor() {
    super("Case reconstruction feature is disabled.");
    this.name = "ReconstructionFeatureDisabledError";
  }
}

function mapReconstructionError(error: unknown): ReconstructionError {
  if (error instanceof ReconstructionError) return error;
  return new ReconstructionError("RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN");
}

function jsonResponse(
  context: RequestContext,
  body: JsonValue,
  status: number,
  allow?: string,
): Response {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-request-id": context.requestId,
  };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

export function safeReconstructionErrorCode(value: unknown): value is ReconstructionErrorCode {
  return typeof value === "string" && value.startsWith("RECONSTRUCTION_");
}
