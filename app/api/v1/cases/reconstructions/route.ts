import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import {
  successResponse,
} from "@/modules/shared/public";
import { createRequestContext } from "@/modules/shared/public";
import {
  CaseReconstructionRuntimeUnavailable,
  getCaseReconstructionRuntime,
} from "@/modules/cases/server";
import {
  isCaseReconstructionEnabled,
  methodNotAllowedResponse,
  parseCreateDraftRequest,
  reconstructionErrorResponse,
  reconstructionResultData,
  ReconstructionFeatureDisabledError,
} from "@/modules/cases/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = createRequestContext(request);
  if (!isCaseReconstructionEnabled()) {
    return reconstructionErrorResponse(context, new ReconstructionFeatureDisabledError());
  }

  try {
    const command = await parseCreateDraftRequest(request, context.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw new Error("unauthenticated");

    const actor = await getIdentityRuntime().service.requireSession({
      cookieSecret,
      sensitiveAction: true,
    });
    const result = await getCaseReconstructionRuntime().service.createDraft({ actor, command });
    return successResponse(context, reconstructionResultData(result));
  } catch (error) {
    if (error instanceof IdentityServiceError || (error instanceof Error && error.message === "unauthenticated")) {
      return new Response(
        JSON.stringify({
          api_version: "v1",
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication is required.",
            request_id: context.requestId,
            retryable: false,
            details: {},
          },
        }),
        { status: 401, headers: { "content-type": "application/json", "x-request-id": context.requestId } },
      );
    }
    if (error instanceof IdentityRuntimeUnavailable || error instanceof CaseReconstructionRuntimeUnavailable) {
      return new Response(
        JSON.stringify({
          api_version: "v1",
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The service is temporarily unavailable.",
            request_id: context.requestId,
            retryable: true,
            details: {},
          },
        }),
        { status: 503, headers: { "content-type": "application/json", "x-request-id": context.requestId } },
      );
    }
    return reconstructionErrorResponse(context, error);
  }
}

export async function GET(request: Request): Promise<Response> {
  const context = createRequestContext(request);
  if (!isCaseReconstructionEnabled()) {
    return reconstructionErrorResponse(context, new ReconstructionFeatureDisabledError());
  }
  return methodNotAllowedResponse(context, "POST");
}
