import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import {
  getUserDirectoryRuntime,
  isUserDirectoryServiceError,
  isUserDirectoryRuntimeUnavailable,
} from "@/modules/identity/server";
import { ApiContractError, createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const users = await getUserDirectoryRuntime().service.listUsers(actor);
      return {
        invitation_model: actor.trialPrincipal ? "trial" : "legacy",
        can_invite_users: actor.roles.includes("founder"),
        total: users.length,
        users: users.map((user) => ({
          user_id: user.userId,
          trial_level: user.trialLevel,
          email: user.normalizedEmail,
          user_status: user.userStatus,
          membership_status: user.membershipStatus,
          display_name: user.displayName,
          employment_type: user.employmentType,
          profile_record_version: user.profileRecordVersion,
          access_version: user.accessVersion,
          pending_invite_id: user.pendingInviteId,
          pending_invite_expires_at: user.pendingInviteExpiresAt,
          roles: user.roles.map((role) => ({
            role: role.role,
            status: role.status,
          })),
          updated_at: user.updatedAt,
        })),
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof ApiContractError) throw error;
      if (isUserDirectoryServiceError(error, "FORBIDDEN")) {
        throw createApiError("FORBIDDEN");
      }
      if (isUserDirectoryRuntimeUnavailable(error)) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw createApiError("SERVICE_UNAVAILABLE");
    }
  });
}
