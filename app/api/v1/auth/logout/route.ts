import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { buildCognitoLogoutUrl } from "@/modules/identity/server";
import { getCognitoAuthConfig } from "@/modules/identity/server";
import { loadAuthMode } from "@/modules/identity/server";
import { SESSION_COOKIE_NAME, clearAuthCookie } from "@/modules/identity/server";
import { getIdentityRuntime } from "@/modules/identity/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return signOut(request);
}

export async function GET(request: Request): Promise<Response> {
  return signOut(request);
}

async function signOut(request: Request): Promise<Response> {
  const secret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (secret) {
    try {
      await getIdentityRuntime().service.revokeSession({
        cookieSecret: secret,
        reason: "sign_out",
      });
    } catch {
      // Clear the browser credential even when the HK runtime is unavailable.
    }
  }
  let destination = new URL("/login", request.url).toString();
  try {
    if (loadAuthMode() === "cognito") {
      destination = buildCognitoLogoutUrl(getCognitoAuthConfig());
    }
  } catch {
    // The local application session is still revoked when provider logout is unavailable.
  }
  const response = NextResponse.redirect(destination, 303);
  clearAuthCookie(response, SESSION_COOKIE_NAME);
  return response;
}
