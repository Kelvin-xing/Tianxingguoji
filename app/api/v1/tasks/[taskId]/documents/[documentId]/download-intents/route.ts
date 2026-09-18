import { requireDocumentActor } from "@/modules/documents/server";
import { getDocumentTransferRuntime } from "@/modules/documents/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentDownloadIntentData,
  mapDocumentTransferError,
  parseEmptyDocumentCommand,
} from "../../../../../documents/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  readonly params: Promise<{ readonly taskId: string; readonly documentId: string }>;
};

export function POST(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      assertNoDocumentQuery(request);
      const { taskId, documentId } = await context.params;
      const actor=await requireDocumentActor();
      const caseId=await getDocumentTransferRuntime().resolveTaskCase(actor,taskId,documentId);
      await parseEmptyDocumentCommand(request);
      return documentDownloadIntentData(
        await getDocumentTransferRuntime().service.issueDownloadIntent({
          actor,
      taskId,
          caseId,
          documentId,
          requestId: requestContext.requestId,
        }),
      );
    } catch (error) {
      throw mapDocumentTransferError(error);
    }
  });
}
