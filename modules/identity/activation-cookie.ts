import { createHmac, timingSafeEqual } from "node:crypto";

import type { ClaimedInviteActivation } from "./session-repository.ts";

const ACTIVATION_COOKIE_VERSION = "v1";
const ACTIVATION_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export const PENDING_INVITE_ACTIVATION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Host-tx_pending_invite_activation"
    : "tx_pending_invite_activation";

export const pendingInviteActivationCookieOptions = Object.freeze({
  httpOnly: true,
  secure: process.env.NODE_ENV !== "development",
  sameSite: "lax" as const,
  path: "/",
  maxAge: ACTIVATION_COOKIE_MAX_AGE_SECONDS,
});

export function encodePendingInviteActivation(
  activation: ClaimedInviteActivation,
  signingKey: string,
): string {
  const payload = Buffer.from(JSON.stringify({
    inviteId: activation.inviteId,
    organizationId: activation.organizationId,
    targetUserId: activation.targetUserId,
    providerSubject: activation.providerSubject,
    expiresAtMs: activation.expiresAtMs,
  })).toString("base64url");
  return `${ACTIVATION_COOKIE_VERSION}.${payload}.${sign(payload, signingKey)}`;
}

export function decodePendingInviteActivation(
  value: string | undefined,
  signingKey: string,
  nowMs: number,
): ClaimedInviteActivation | undefined {
  if (!value) return undefined;
  const [version, payload, signature, extra] = value.split(".");
  if (version !== ACTIVATION_COOKIE_VERSION || !payload || !signature || extra) return undefined;
  if (!timingSafeEqualSafe(sign(payload, signingKey), signature)) return undefined;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isActivation(parsed) || parsed.expiresAtMs <= nowMs) return undefined;
    return Object.freeze(parsed);
  } catch {
    return undefined;
  }
}

export function getActivationCookieSigningKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment.IDENTITY_ACTIVATION_COOKIE_KEY?.trim();
  const bytes = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (bytes.length !== 32) {
    throw new Error("IDENTITY_ACTIVATION_COOKIE_KEY must be a 32-byte base64 value.");
  }
  return value!;
}

function sign(payload: string, signingKey: string): string {
  return createHmac("sha256", Buffer.from(signingKey, "base64")).update(payload).digest("base64url");
}

function timingSafeEqualSafe(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function isActivation(value: unknown): value is ClaimedInviteActivation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isUuid(record.inviteId) &&
    isUuid(record.organizationId) &&
    isUuid(record.targetUserId) &&
    typeof record.providerSubject === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(record.providerSubject) &&
    typeof record.expiresAtMs === "number" &&
    Number.isSafeInteger(record.expiresAtMs)
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
