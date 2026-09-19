import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getTrialMemberManagementService } from "@/modules/access/server";
import { handleApiRequest } from "@/modules/shared/public";
import { mapTrialMemberError } from "../../trial-member-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const members = await getTrialMemberManagementService().list(actor);
      return { current_user_id: actor.userId, bootstrap_required: !actor.trialPrincipal,
        members: members.map((member) => ({
          user_id: member.userId, display_name: member.displayName, email: member.email,
          level: member.level, categories: [...member.categories], status: member.status, record_version: member.recordVersion,
        })) };
    } catch (error) { throw mapTrialMemberError(error); }
  });
}
