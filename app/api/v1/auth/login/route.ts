import { NextResponse } from "next/server";

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

export async function GET(request: Request): Promise<Response> {
  try {
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
  } catch {
    return NextResponse.redirect(new URL("/login?error=configuration", request.url));
  }
}
