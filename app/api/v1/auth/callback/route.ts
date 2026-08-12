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
  let activation;
  try {
    activation = decodePendingInviteActivation(
      cookieStore.get(PENDING_INVITE_ACTIVATION_COOKIE_NAME)?.value,
      getActivationCookieSigningKey(),
      Date.now(),
    );
  } catch {
    return callbackFailure(request, "configuration");
  }

  if (!code || !codeVerifier || !equalsSecret(expectedState, state) || !activation) {
    return callbackFailure(request, "invalid_callback");
  }

  try {
    const runtime = getIdentityRuntime();
    const identity = await runtime.managedLoginVerifier.completeAuthorizationCode({
      code,
      codeVerifier,
    });
    const session = await runtime.service.completeManagedLogin({ activation, identity });
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
    return callbackFailure(request, "authentication_failed");
  }
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
