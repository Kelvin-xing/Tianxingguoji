import { requireIdentityActor } from "@/modules/identity/web";
import { getDocumentWorkspaceRuntime } from "@/modules/documents/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentDetailData,
  mapDocumentWorkspaceError,
} from "../../../../documents/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  readonly params: Promise<{ readonly caseId: string; readonly documentId: string }>;
};

export function GET(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      assertNoDocumentQuery(request);
      const { caseId, documentId } = await context.params;
      const result = await getDocumentWorkspaceRuntime().service.detail(
        await requireIdentityActor(),
        caseId,
        documentId,
      );
      if (!result) throw createApiError("NOT_FOUND");
      return documentDetailData(result);
    } catch (error) {
      throw mapDocumentWorkspaceError(error);
    }
  });
}
