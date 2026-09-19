import { requireDocumentActor } from "@/modules/documents/server";
import { getDocumentTransferRuntime } from "@/modules/documents/server";
import {
  createRequestContext,
  errorResponse,
  successResponse,
} from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentVersionAcknowledgementData,
  mapDocumentTransferError,
  parseDocumentVersionCreate,
} from "../../../../../documents/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  readonly params: Promise<{ readonly taskId: string; readonly documentId: string }>;
};

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    assertNoDocumentQuery(request);
    const { taskId, documentId } = await context.params;
      const actor=await requireDocumentActor();
      const caseId=await getDocumentTransferRuntime().resolveTaskCase(actor,taskId,documentId);
    const result = await getDocumentTransferRuntime().service.createVersion({
      actor,
      taskId,
      caseId,
      documentId,
      command: await parseDocumentVersionCreate(request, requestContext.requestId),
    });
    return successResponse(requestContext, documentVersionAcknowledgementData(result), 201);
  } catch (error) {
    return errorResponse(requestContext, mapDocumentTransferError(error));
  }
}
