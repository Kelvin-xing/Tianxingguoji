import { getDocumentTransferRuntime } from "@/modules/documents/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentVersionAcknowledgementData,
  mapDocumentTransferError,
  parseDocumentVersionAbandonment,
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
      const command = await parseDocumentVersionAbandonment(request, requestContext.requestId);
      return documentVersionAcknowledgementData(
        await getDocumentTransferRuntime().service.abandonPendingUpload({
          actor: await requireIdentityActor(),
          caseId,
          documentId,
          versionId,
          command,
        }),
      );
    } catch (error) {
      throw mapDocumentTransferError(error);
    }
  });
}
