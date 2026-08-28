import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getMemberManagementRuntime } from "@/modules/access/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  mapMemberManagementError,
  memberReceiptData,
  parseMemberAccessUpdate,
} from "../../../member-management-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly userId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { userId } = await context.params;
      const command = await parseMemberAccessUpdate(request, userId);
      const actor = await requireApiRequestAccessContext();
      return memberReceiptData(await getMemberManagementRuntime().service.updateMemberAccess({
        actor,
        targetUserId: userId,
        command: { ...command, requestId: requestContext.requestId },
      }));
    } catch (error) {
      throw mapMemberManagementError(error);
    }
  });
}
