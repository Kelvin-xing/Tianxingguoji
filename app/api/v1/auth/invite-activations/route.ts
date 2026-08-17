import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  encodePendingInviteActivation,
  getActivationCookieSigningKey,
  PENDING_INVITE_ACTIVATION_COOKIE_NAME,
  pendingInviteActivationCookieOptions,
} from "@/modules/identity/activation-cookie";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { buildCognitoAuthorizeUrl } from "@/lib/auth/cognito";
import { getCognitoAuthConfig } from "@/lib/auth/config";
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  cognitoFlowCookieOptions,
} from "@/lib/auth/cookies";
import { createPkcePair } from "@/lib/auth/pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let activationCredential: string | undefined;
  try {
    const formData = await request.formData();
    const submitted = formData.get("activation_credential");
    activationCredential = typeof submitted === "string" ? submitted : undefined;
  } catch {
    return activationFailure(request, "invalid_invite");
  }
  if (!activationCredential) return activationFailure(request, "invalid_invite");

  try {
    const runtime = getIdentityRuntime();
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
