import { NextResponse } from "next/server";

import {
  encodePendingInviteActivation,
  getActivationCookieSigningKey,
  PENDING_INVITE_ACTIVATION_COOKIE_NAME,
  pendingInviteActivationCookieOptions,
} from "@/modules/identity/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { InternalEmailServiceError, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/modules/identity/server";
import { buildCognitoAuthorizeUrl } from "@/modules/identity/server";
import { getCognitoAuthConfig } from "@/modules/identity/server";
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  cognitoFlowCookieOptions,
} from "@/modules/identity/server";
import { createPkcePair } from "@/modules/identity/server";
import { InviteActivationRequestError, readInviteActivationRequest } from "./route-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let activationCredential: string | undefined;
  let password: string | undefined;
  let passwordConfirmation: string | undefined;
  let displayName: string | undefined;
  try {
    const command = await readInviteActivationRequest(request);
    activationCredential = command.activationCredential;
    password = command.password;
    passwordConfirmation = command.passwordConfirmation;
    displayName = command.displayName;
  } catch (error) {
    if (!(error instanceof InviteActivationRequestError)) return activationFailure(request, "service_unavailable");
    return activationFailure(request, "invalid_invite");
  }
  if (!activationCredential) return activationFailure(request, "invalid_invite");

  try {
    const runtime = getIdentityRuntime();
    if (runtime.authMode === "internal-email" && runtime.internalEmail) {
      if (!password || password !== passwordConfirmation || !displayName?.trim()) return activationFailure(request, "invalid_invite");
      const session = await runtime.internalEmail.activateInvite({ activationCredential, password, displayName });
      const response = NextResponse.redirect(new URL("/today", request.url), 303);
      response.cookies.set(SESSION_COOKIE_NAME, session.cookieSecret, sessionCookieOptions);
      return response;
    }
    if (runtime.authMode !== "cognito") {
      return activationFailure(request, "configuration");
    }
    const activation = await runtime.service.claimInviteActivation({ activationCredential });
    const config = getCognitoAuthConfig();
    const pkce = createPkcePair();
    const response = NextResponse.redirect(
      buildCognitoAuthorizeUrl(config, pkce.state, pkce.codeChallenge),
      303,
    );
    response.cookies.set(COGNITO_STATE_COOKIE_NAME, pkce.state, cognitoFlowCookieOptions);
    response.cookies.set(
      COGNITO_VERIFIER_COOKIE_NAME,
      pkce.codeVerifier,
      cognitoFlowCookieOptions,
    );
    response.cookies.set(
      PENDING_INVITE_ACTIVATION_COOKIE_NAME,
      encodePendingInviteActivation(activation, getActivationCookieSigningKey()),
      pendingInviteActivationCookieOptions,
    );
    return response;
  } catch (error) {
    if (error instanceof IdentityRuntimeUnavailable) {
      return activationFailure(request, "service_unavailable");
    }
    if (error instanceof IdentityServiceError) {
      return activationFailure(request, "invalid_invite");
    }
    if (error instanceof InternalEmailServiceError) {
      return activationFailure(request, error.code === "INVITE_DELIVERY_FAILED" ? "service_unavailable" : "invalid_invite");
    }
    return activationFailure(request, "configuration");
  }
}

function activationFailure(request: Request, code: string): Response {
  const response = NextResponse.redirect(
    new URL(`/login/activate?error=${encodeURIComponent(code)}`, request.url),
    303,
  );
  response.cookies.delete(PENDING_INVITE_ACTIVATION_COOKIE_NAME);
  return response;
}
