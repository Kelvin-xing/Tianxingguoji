import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { InternalEmailServiceError } from "@/modules/identity/server";
import { resolveRequestAccessContext, RequestAccessContextError } from "@/modules/access/server";
import { InternalEmailInviteRequestError, readInternalEmailInviteRequest } from "./route-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    let command;
    try {
      command = await readInternalEmailInviteRequest(request);
    } catch (error) {
      if (error instanceof InternalEmailInviteRequestError) throw createApiError(error.code);
      throw createApiError("INVALID_REQUEST");
    }
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const runtime = getIdentityRuntime();
      if (runtime.authMode === "internal-email" && runtime.internalEmail) {
        let access;
        try {
          access = await resolveRequestAccessContext({ cookieSecret, sensitiveAction: true });
        } catch (error) {
          if (error instanceof RequestAccessContextError && error.code === "REQUEST_ACCESS_UNAUTHENTICATED") throw createApiError("UNAUTHENTICATED");
          if (error instanceof RequestAccessContextError && error.code === "REQUEST_ACCESS_FORBIDDEN") throw createApiError("FORBIDDEN");
          throw createApiError("SERVICE_UNAVAILABLE");
        }
        const invite = await runtime.internalEmail.createFounderInvite({
          actor: { userId: access.userId, organizationId: access.organizationId, roles: access.roles },
          normalizedEmail: command.normalizedEmail,
          role: command.role,
          employmentType: command.employmentType,
          displayName: command.displayName,
          idempotencyKey: command.idempotencyKey,
        });
        return {
          invite_id: invite.inviteId,
          target_user_id: invite.targetUserId,
          expires_at_ms: invite.expiresAtMs,
          delivery_receipt: {
            channel_policy_id: invite.deliveryReceipt.channelPolicyId,
            receipt_reference: invite.deliveryReceipt.receiptReference,
            delivered_at_ms: invite.deliveryReceipt.deliveredAtMs,
          },
        };
      }
      const actor = await runtime.service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const invite = await runtime.service.createFounderInvite({
        actor,
        target: {
          userId: randomUUID(),
          normalizedEmail: command.normalizedEmail,
          role: command.role,
        },
        idempotencyKey: command.idempotencyKey,
      });
      return {
        invite_id: invite.inviteId,
        target_user_id: invite.targetUserId,
        expires_at_ms: invite.expiresAtMs,
        delivery_receipt: {
          channel_policy_id: invite.deliveryReceipt.channelPolicyId,
          receipt_reference: invite.deliveryReceipt.receiptReference,
          delivered_at_ms: invite.deliveryReceipt.deliveredAtMs,
        },
      };
    } catch (error) {
      if (error instanceof IdentityRuntimeUnavailable) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      if (error instanceof IdentityServiceError) {
        if (error.code === "FOUNDER_REQUIRED") throw createApiError("FORBIDDEN");
        if (error.code === "SESSION_NOT_FOUND") throw createApiError("UNAUTHENTICATED");
        if (error.code === "INVITE_ALREADY_EXISTS") throw createApiError("CONFLICT");
        if (
          error.code === "COGNITO_PROVISION_FAILED" ||
          error.code === "INVITE_DELIVERY_FAILED"
        ) {
          throw createApiError("SERVICE_UNAVAILABLE");
        }
        throw createApiError("VALIDATION_FAILED");
      }
      if (error instanceof InternalEmailServiceError) {
        if (error.code === "FOUNDER_REQUIRED") throw createApiError("FORBIDDEN");
        if (error.code === "INVITE_ALREADY_EXISTS") throw createApiError("CONFLICT");
        if (error.code === "INVITE_DELIVERY_FAILED") throw createApiError("SERVICE_UNAVAILABLE");
        throw createApiError("VALIDATION_FAILED");
      }
      throw createApiError("SERVICE_UNAVAILABLE");
    }
  });
}
