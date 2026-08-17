import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type InvitableRole = "founder" | "admin" | "advisor" | "data_reviewer" | "contractor";

const INVITABLE_ROLES = new Set<InvitableRole>([
  "founder",
  "admin",
  "advisor",
  "data_reviewer",
  "contractor",
] as const);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const command = await parseInviteCommand(request);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const runtime = getIdentityRuntime();
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
      throw createApiError("SERVICE_UNAVAILABLE");
    }
  });
}

async function parseInviteCommand(request: Request): Promise<{
  readonly normalizedEmail: string;
  readonly role: InvitableRole;
  readonly idempotencyKey: string;
}> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  const normalizedEmail = body.normalized_email;
  const role = body.role;
  if (
    typeof normalizedEmail !== "string" ||
    normalizedEmail.length === 0 ||
    normalizedEmail.length > 320 ||
    normalizedEmail !== normalizedEmail.trim().toLowerCase() ||
    typeof role !== "string" ||
    !INVITABLE_ROLES.has(role as InvitableRole)
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    normalizedEmail,
    role: role as InvitableRole,
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
