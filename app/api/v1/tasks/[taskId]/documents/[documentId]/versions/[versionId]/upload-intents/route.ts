import { requireDocumentActor } from "@/modules/documents/server";
import { getDocumentTransferRuntime } from "@/modules/documents/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentUploadIntentData,
  mapDocumentTransferError,
  parseDocumentUploadIntent,
} from "../../../../../../../documents/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  readonly params: Promise<{
    readonly taskId: string;
    readonly documentId: string;
    readonly versionId: string;
  }>;
};

export function POST(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      assertNoDocumentQuery(request);
      const { taskId, documentId, versionId } = await context.params;
      const actor=await requireDocumentActor();
      const caseId=await getDocumentTransferRuntime().resolveTaskCase(actor,taskId,documentId);
      const command = await parseDocumentUploadIntent(request);
      return documentUploadIntentData(
        await getDocumentTransferRuntime().service.issueUploadIntent({
          actor,
      taskId,
          caseId,
          documentId,
          versionId,
          expectedRecordVersion: command.expectedRecordVersion,
          requestId: requestContext.requestId,
        }),
      );
    } catch (error) {
      throw mapDocumentTransferError(error);
    }
  });
}
