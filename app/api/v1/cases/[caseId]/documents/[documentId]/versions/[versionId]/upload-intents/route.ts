import { requireIdentityActor } from "@/modules/identity/web";
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
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
  }>;
};

export function POST(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      assertNoDocumentQuery(request);
      const { caseId, documentId, versionId } = await context.params;
      const command = await parseDocumentUploadIntent(request);
      return documentUploadIntentData(
        await getDocumentTransferRuntime().service.issueUploadIntent({
          actor: await requireIdentityActor(),
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
