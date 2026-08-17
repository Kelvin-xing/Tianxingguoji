import { NextResponse } from "next/server";

import { buildCognitoAuthorizeUrl } from "@/lib/auth/cognito";
import { getCognitoAuthConfig } from "@/lib/auth/config";
import { loadAuthMode } from "@/lib/auth/mode";
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  cognitoFlowCookieOptions,
  sessionCookieOptions,
} from "@/lib/auth/cookies";
import { createPkcePair } from "@/lib/auth/pkce";
import { getIdentityRuntime } from "@/modules/identity/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (loadAuthMode() !== "cognito") {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return beginCognitoLogin(request);
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration", request.url));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const mode = loadAuthMode();
    if (mode === "cognito") return beginCognitoLogin(request);

    const formData = await request.formData();
    const role = formData.get("role");
    const localLogin = getIdentityRuntime().localLogin;
    if (!localLogin) {
      return NextResponse.redirect(new URL("/login?error=configuration", request.url), 303);
    }
    let session;
    try {
      session = await localLogin.createSession(role);
    } catch (error) {
      if (error instanceof TypeError) {
        return NextResponse.redirect(new URL("/login?error=invalid_local_role", request.url), 303);
      }
      throw error;
    }
    const response = NextResponse.redirect(new URL("/today", request.url), 303);
    response.cookies.set(SESSION_COOKIE_NAME, session.cookieSecret, sessionCookieOptions);
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration", request.url), 303);
  }
}

function beginCognitoLogin(request: Request): Response {
    const config = getCognitoAuthConfig();
    const pkce = createPkcePair();
    const response = NextResponse.redirect(
      buildCognitoAuthorizeUrl(config, pkce.state, pkce.codeChallenge),
    );
    response.cookies.set(COGNITO_STATE_COOKIE_NAME, pkce.state, cognitoFlowCookieOptions);
    response.cookies.set(
      COGNITO_VERIFIER_COOKIE_NAME,
      pkce.codeVerifier,
      cognitoFlowCookieOptions,
    );
    return response;
}
