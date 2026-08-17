import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  decodePendingInviteActivation,
  getActivationCookieSigningKey,
  PENDING_INVITE_ACTIVATION_COOKIE_NAME,
} from "@/modules/identity/activation-cookie";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import {
  CognitoVerificationError,
  exchangeAuthorizationCode,
  verifyCognitoIdentity,
} from "@/lib/auth/cognito";
import { AuthConfigurationError, getCognitoAuthConfig } from "@/lib/auth/config";
import { loadAuthMode } from "@/lib/auth/mode";
import {
  createSessionForIdentity,
  SessionCreationError,
} from "@/lib/auth/session-service";
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearAuthCookie,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { equalsSecret } from "@/lib/auth/pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const cookieStore = await cookies();
  const state = requestUrl.searchParams.get("state") ?? undefined;
  const code = requestUrl.searchParams.get("code");
  const expectedState = cookieStore.get(COGNITO_STATE_COOKIE_NAME)?.value;
  const codeVerifier = cookieStore.get(COGNITO_VERIFIER_COOKIE_NAME)?.value;
  const pendingActivationCookie = cookieStore.get(PENDING_INVITE_ACTIVATION_COOKIE_NAME)?.value;
  let activation = null;
  if (pendingActivationCookie) {
    try {
      activation = decodePendingInviteActivation(
        pendingActivationCookie,
        getActivationCookieSigningKey(),
        Date.now(),
      );
    } catch {
      return callbackFailure(request, "configuration");
    }
  }

  if (!code || !codeVerifier || !equalsSecret(expectedState, state)) {
    return callbackFailure(request, "invalid_callback");
  }

  try {
    if (loadAuthMode() !== "cognito") {
      return callbackFailure(request, "invalid_callback");
    }
    const session = activation
      ? await completeInviteActivation(code, codeVerifier, activation)
      : await completeReturningLogin(code, codeVerifier);
    const response = NextResponse.redirect(new URL("/today", request.url));
    response.cookies.set(SESSION_COOKIE_NAME, session.cookieSecret, sessionCookieOptions);
    clearFlowCookies(response);
    return response;
  } catch (error) {
    if (error instanceof IdentityRuntimeUnavailable) {
      return callbackFailure(request, "service_unavailable");
    }
    if (error instanceof IdentityServiceError) {
      return callbackFailure(request, "authentication_failed");
    }
    if (error instanceof SessionCreationError) {
      if (error.code === "IDENTITY_NOT_INVITED") return callbackFailure(request, "not_invited");
      if (error.code === "USER_DISABLED") return callbackFailure(request, "access_disabled");
      if (error.code === "SESSION_LIMIT_REACHED") return callbackFailure(request, "session_limit");
      return callbackFailure(request, "authentication_failed");
    }
    if (error instanceof AuthConfigurationError) {
      return callbackFailure(request, "configuration");
    }
    if (error instanceof CognitoVerificationError) {
      return callbackFailure(request, "authentication_failed");
    }
    return callbackFailure(request, "authentication_failed");
  }
}

async function completeReturningLogin(
  code: string,
  codeVerifier: string,
): Promise<{ readonly cookieSecret: string }> {
  const config = getCognitoAuthConfig();
  const tokens = await exchangeAuthorizationCode(config, code, codeVerifier);
  const identity = await verifyCognitoIdentity(config, tokens);
  if (!identity.emailVerified) {
    throw new CognitoVerificationError("email_not_verified");
  }
  const session = await createSessionForIdentity(identity, tokens);
  return { cookieSecret: session.secret };
}

async function completeInviteActivation(
  code: string,
  codeVerifier: string,
  activation: NonNullable<ReturnType<typeof decodePendingInviteActivation>>,
): Promise<{ readonly cookieSecret: string }> {
  const runtime = getIdentityRuntime();
  if (!runtime.managedLoginVerifier) throw new IdentityRuntimeUnavailable();
  const identity = await runtime.managedLoginVerifier.completeAuthorizationCode({ code, codeVerifier });
  return runtime.service.completeManagedLogin({ activation, identity });
}

function callbackFailure(request: Request, code: string): Response {
  const response = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(code)}`, request.url),
  );
  clearFlowCookies(response);
  return response;
}

function clearFlowCookies(response: NextResponse): void {
  clearAuthCookie(response, COGNITO_STATE_COOKIE_NAME);
  clearAuthCookie(response, COGNITO_VERIFIER_COOKIE_NAME);
  response.cookies.delete(PENDING_INVITE_ACTIVATION_COOKIE_NAME);
}
