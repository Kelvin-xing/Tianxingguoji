import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getTrialMemberManagementService } from "@/modules/access/server";
import { handleApiRequest } from "@/modules/shared/public";
import { mapTrialMemberError, parseTrialMemberCommand } from "../../../trial-member-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { readonly params: Promise<{ readonly userId: string }> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const actor = await requireApiRequestAccessContext();
      const { userId } = await context.params;
      const command = await parseTrialMemberCommand(request);
      const receipt = await getTrialMemberManagementService().update({ actor, targetUserId: userId,
        command: { ...command, requestId: requestContext.requestId } });
      return { user_id: receipt.userId, receipt_id: receipt.receiptId, replayed: receipt.replayed };
    } catch (error) { throw mapTrialMemberError(error); }
  });
}
