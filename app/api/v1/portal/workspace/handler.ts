import {
  PortalPolicyError,
  mapPortalErrorToPublicResponse,
  type PortalCaseReadV1,
} from "../../../../../modules/external-portal/public.ts";
import { PortalRuntimeUnavailable } from "../../../../../modules/external-portal/server.ts";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

export interface PortalWorkspaceRouteDependencies {
  getSessionSecret(request?: Request): Promise<string | null>;
  readWorkspace(input: { readonly sessionSecret: string }): Promise<
    PortalCaseReadV1 & Record<string, unknown>
  >;
}

export function createPortalWorkspaceGetHandler(deps: PortalWorkspaceRouteDependencies) {
  return async function GET(_request: Request): Promise<Response> {
    try {
      const sessionSecret = await deps.getSessionSecret(_request);
      if (!sessionSecret) return json({ error: { code: "PORTAL_ACCESS_INVALID" } }, 401);
      const value = await deps.readWorkspace({ sessionSecret });
      return json({
        capability_set_version: value.capabilitySetVersion,
        case_number: value.caseNumber,
        customer_facing_stage: value.customerFacingStage,
        last_customer_visible_update_at: value.lastCustomerVisibleUpdateAt,
        school_targets: value.schoolTargets.map((item) => ({
          name: item.name,
          status: item.status,
        })),
        action_items: value.actionItems.map((item) => ({
          title: item.title,
          deadline: item.deadline,
          completed: item.completed,
        })),
        messages: value.messages.map((item) => ({
          body: item.body,
          published_at: item.publishedAt,
        })),
      }, 200);
    } catch (error) {
      if (error instanceof PortalRuntimeUnavailable) {
        return json({ error: { code: error.code } }, 503);
      }
      if (error instanceof PortalPolicyError) {
        const mapped = mapPortalErrorToPublicResponse(error.code);
        return json({ error: { code: mapped.code } }, mapped.httpStatus);
      }
      return json({ error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } }, 503);
    }
  };
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function readPortalCookie(header: string | null, name: string): string | undefined {
  return header?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
