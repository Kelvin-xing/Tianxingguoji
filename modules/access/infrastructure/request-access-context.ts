import "server-only";

import { cookies } from "next/headers.js";

import type { IdentityPrincipal } from "../../identity/public.ts";
import {
  IdentityRuntimeUnavailable,
  getIdentityRuntime,
  isIdentityServiceError,
  withAuthTransaction,
  SESSION_COOKIE_NAME,
} from "../../identity/server.ts";
import type { AccessContext } from "../domain/authorization.ts";
import { AccessAuthorizationService } from "../application/authorization-service.ts";
import { PostgresqlAccessAuthorizationRepository } from "./postgresql-authorization-repository.ts";

export type RequestAccessContextErrorCode =
  | "REQUEST_ACCESS_UNAUTHENTICATED"
  | "REQUEST_ACCESS_FORBIDDEN"
  | "REQUEST_ACCESS_UNAVAILABLE";

export class RequestAccessContextError extends Error {
  readonly code: RequestAccessContextErrorCode;

  constructor(code: RequestAccessContextErrorCode) {
    super(`Request-time Access resolution failed: ${code}.`);
    this.name = "RequestAccessContextError";
    this.code = code;
  }
}

export function isRequestAccessContextError(
  error: unknown,
  code?: RequestAccessContextErrorCode,
): error is RequestAccessContextError {
  return error instanceof RequestAccessContextError &&
    (code === undefined || error.code === code);
}

/**
 * Canonical server-only request boundary: validate the current User/Session,
 * then resolve the current Membership and every active RoleBinding. Callers
 * authorize from the returned capability union, never from the legacy role.
 */
export async function resolveRequestAccessContext(input: Readonly<{
  cookieSecret: string;
  sensitiveAction?: boolean;
}>): Promise<AccessContext> {
  let principal: IdentityPrincipal;
  try {
    const actor = await getIdentityRuntime().service.requireSession({
      cookieSecret: input.cookieSecret,
      sensitiveAction: input.sensitiveAction ?? false,
    });
    principal = Object.freeze({
      userId: actor.userId,
      sessionId: actor.sessionId,
      capturedSessionVersion: actor.capturedSessionVersion,
      reauthenticatedAtMs: actor.reauthenticatedAtMs,
      organizationId: actor.organizationId,
      membershipId: actor.membershipId,
    });
  } catch (error) {
    if (isIdentityServiceError(error, "SESSION_NOT_FOUND")) {
      throw new RequestAccessContextError("REQUEST_ACCESS_UNAUTHENTICATED");
    }
    if (error instanceof IdentityRuntimeUnavailable) {
      throw new RequestAccessContextError("REQUEST_ACCESS_UNAVAILABLE");
    }
    throw new RequestAccessContextError("REQUEST_ACCESS_UNAVAILABLE");
  }

  let context: AccessContext | null;
  if (!principal.organizationId || !principal.membershipId) {
    throw new RequestAccessContextError("REQUEST_ACCESS_FORBIDDEN");
  }
  try {
    context = await withAuthTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.organization_id', $1, true)",
        [principal.organizationId],
      );
      return new AccessAuthorizationService({
        repository: new PostgresqlAccessAuthorizationRepository(client),
      }).resolveWorkspaceContext(principal);
    });
  } catch (error) {
    process.stderr.write(
      `event=request_access_postgres_failure postgres_code=${safePostgresCode(error)}\n`,
    );
    throw new RequestAccessContextError("REQUEST_ACCESS_UNAVAILABLE");
  }
  if (!context || context.roles.length === 0) {
    throw new RequestAccessContextError("REQUEST_ACCESS_FORBIDDEN");
  }
  return context;
}

function safePostgresCode(error: unknown): string {
  const code = error instanceof Error
    ? (error as Error & { readonly code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "OTHER";
}

/** App Router entrypoint; missing cookies fail closed as unauthenticated. */
export async function resolveCurrentRequestAccessContext(): Promise<AccessContext> {
  const secret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!secret) throw new RequestAccessContextError("REQUEST_ACCESS_UNAUTHENTICATED");
  return resolveRequestAccessContext({ cookieSecret: secret });
}
