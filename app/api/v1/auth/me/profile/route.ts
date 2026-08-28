import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getMemberManagementRuntime } from "@/modules/access/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  mapMemberManagementError,
  memberReceiptData,
  ownProfileData,
  parseOwnDisplayNameUpdate,
} from "../../member-management-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      return ownProfileData(await getMemberManagementRuntime().service.getOwnProfile(actor));
    } catch (error) {
      throw mapMemberManagementError(error);
    }
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return handleApiRequest(request, async (context) => {
    try {
      const command = await parseOwnDisplayNameUpdate(request);
      const actor = await requireApiRequestAccessContext();
      return memberReceiptData(await getMemberManagementRuntime().service.updateOwnDisplayName({
        actor,
        command: { ...command, requestId: context.requestId },
      }));
    } catch (error) {
      throw mapMemberManagementError(error);
    }
  });
}
