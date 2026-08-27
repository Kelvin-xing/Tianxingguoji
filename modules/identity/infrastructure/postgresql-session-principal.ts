import "server-only";

import { hashSessionSecret } from "./session-crypto.ts";
import { withAuthTransaction } from "./postgresql-client.ts";
import {
  evaluateIdentitySession,
  type SessionDenialCode,
} from "../domain/contract.ts";
import type { IdentityPrincipal } from "../domain/actor.ts";

type PrincipalDenialCode = SessionDenialCode | "SESSION_NOT_FOUND";

interface PrincipalRow {
  allowed: boolean;
  user_id: string | null;
  session_id: string | null;
  captured_session_version: string | number | null;
  reauthenticated_at: Date | string | null;
  organization_id: string | null;
  membership_id: string | null;
  denial_code: PrincipalDenialCode | null;
}

export class IdentityPrincipalSessionError extends Error {
  readonly code: PrincipalDenialCode;

  constructor(code: PrincipalDenialCode) {
    super("The identity session is not active.");
    this.name = "IdentityPrincipalSessionError";
    this.code = code;
  }
}

/** Resolves only User/session facts. Access is intentionally a separate query. */
export async function resolveSessionPrincipal(
  secret: string,
  nowMs = Date.now(),
  sensitiveAction = false,
): Promise<IdentityPrincipal> {
  const row = await withAuthTransaction(async (client) => {
    const result = await client.query<PrincipalRow>(
      "SELECT * FROM identity_resolve_session_principal($1, $2, $3)",
      [hashSessionSecret(secret), new Date(nowMs), sensitiveAction],
    );
    return result.rows[0];
  });
  if (
    !row?.allowed ||
    !row.user_id ||
    !row.session_id ||
    !row.organization_id ||
    !row.membership_id ||
    row.captured_session_version === null
  ) {
    throw new IdentityPrincipalSessionError(row?.denial_code ?? "SESSION_NOT_FOUND");
  }
  const capturedSessionVersion = Number(row.captured_session_version);
  const reauthenticatedAtMs = row.reauthenticated_at === null
    ? null
    : toMillis(row.reauthenticated_at);
  if (!Number.isSafeInteger(capturedSessionVersion) || capturedSessionVersion < 1) {
    throw new IdentityPrincipalSessionError("SESSION_NOT_ACTIVE");
  }
  return Object.freeze({
    userId: row.user_id,
    sessionId: row.session_id,
    capturedSessionVersion,
    reauthenticatedAtMs,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
  });
}

export function evaluatePrincipalSession(input: Readonly<{
  readonly nowMs: number;
  readonly sensitiveAction: boolean;
  readonly userStatus: "invited" | "active" | "disabled";
  readonly currentSessionVersion: number;
  readonly sessionStatus: "active" | "revoked" | "expired";
  readonly capturedSessionVersion: number;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
  readonly reauthenticatedAtMs: number | null;
}>) {
  return evaluateIdentitySession(input);
}

function toMillis(value: Date | string): number {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(millis)) throw new IdentityPrincipalSessionError("SESSION_NOT_ACTIVE");
  return millis;
}
