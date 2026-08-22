import { getGuardianRelationshipRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import {
  mapGuardianRelationshipError,
  parseSearchRequest,
  toGuardianHintData,
} from "../handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly studentId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { studentId } = await context.params;
      const parsed = await parseSearchRequest(request, studentId);
      const actor = await requireIdentityActor();
      const results = await getGuardianRelationshipRuntime().service.searchGuardians({
        actor,
        studentId: parsed.studentId,
        query: parsed.query,
      });
      return results.map(toGuardianHintData);
    } catch (error) {
      throw mapGuardianRelationshipError(error);
    }
  });
}
