import { requireIdentityActor } from "@/modules/identity/web";
import { getDocumentWorkspaceRuntime } from "@/modules/documents/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  assertNoDocumentQuery,
  documentCollectionData,
  mapDocumentWorkspaceError,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      assertNoDocumentQuery(request);
      return documentCollectionData(
        await getDocumentWorkspaceRuntime().service.list(await requireIdentityActor()),
      );
    } catch (error) {
      throw mapDocumentWorkspaceError(error);
    }
  });
}
