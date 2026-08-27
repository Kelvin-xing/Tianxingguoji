import { getDocumentWorkspaceRuntime, requireDocumentActor } from "@/modules/documents/server";
import {
  createApiError,
  createRequestContext,
  errorResponse,
  handleApiRequest,
  successResponse,
} from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentAcknowledgementData,
  documentCollectionData,
  mapDocumentWorkspaceError,
  parseDocumentRegistration,
} from "../../../documents/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly caseId: string }> };

export function GET(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      assertNoDocumentQuery(request);
      const { caseId } = await context.params;
      const result = await getDocumentWorkspaceRuntime().service.listCase(
        await requireDocumentActor(),
        caseId,
      );
      if (!result) throw createApiError("NOT_FOUND");
      return documentCollectionData(result);
    } catch (error) {
      throw mapDocumentWorkspaceError(error);
    }
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    assertNoDocumentQuery(request);
    const { caseId } = await context.params;
    const result = await getDocumentWorkspaceRuntime().service.register({
      actor: await requireDocumentActor(),
      caseId,
      command: await parseDocumentRegistration(request, requestContext.requestId),
    });
    return successResponse(requestContext, documentAcknowledgementData(result), 201);
  } catch (error) {
    return errorResponse(requestContext, mapDocumentWorkspaceError(error));
  }
}
