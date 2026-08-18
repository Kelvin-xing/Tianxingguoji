import { NextResponse } from "next/server";

import { buildCognitoAuthorizeUrl } from "@/modules/identity/server";
import { AuthConfigurationError, getCognitoAuthConfig } from "@/modules/identity/server";
import { loadAuthMode } from "@/modules/identity/server";
import {
  COGNITO_STATE_COOKIE_NAME,
  COGNITO_VERIFIER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  cognitoFlowCookieOptions,
  sessionCookieOptions,
} from "@/modules/identity/server";
import { LocalSyntheticConfigurationError } from "@/lib/runtime/local-synthetic-config";
import { createPkcePair } from "@/modules/identity/server";
import { getIdentityRuntime } from "@/modules/identity/server";
import {
  DatabaseTestAuthenticationError,
  DatabaseTestIdentityRoleError,
  DatabaseTestRepositoryUnavailable,
  RuntimeEnvironmentConfigurationError,
} from "@/modules/identity/server";
import {
  DatabaseTestLoginRequestError,
  readDatabaseTestLoginRequest,
} from "./route-contract.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    if (loadAuthMode() !== "cognito") {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return beginCognitoLogin(request);
  } catch (error) {
    const code = isConfigurationError(error) ? "configuration" : "service_unavailable";
    return NextResponse.redirect(new URL(`/login?error=${code}`, request.url));
  }
}

export async function POST(request: Request): Promise<Response> {
  let mode;
  try {
    mode = loadAuthMode();
  } catch (error) {
    return loginError(request, isConfigurationError(error) ? "configuration" : "service_unavailable");
  }
  if (mode === "cognito") {
    try {
      return beginCognitoLogin(request);
    } catch (error) {
      return loginError(request, isConfigurationError(error) ? "configuration" : "service_unavailable");
    }
  }
  if (mode === "database-test") return databaseTestLogin(request);

  try {
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
  } catch (error) {
    if (isConfigurationError(error)) {
      return loginError(request, "configuration");
    }
    return loginError(request, "service_unavailable");
  }
}

async function databaseTestLogin(request: Request): Promise<Response> {
  let credentials;
  try {
    credentials = await readDatabaseTestLoginRequest(request);
  } catch (error) {
    if (error instanceof DatabaseTestLoginRequestError) {
      return loginError(request, "authentication_failed");
    }
    return loginError(request, "service_unavailable");
  }

  try {
    const login = getIdentityRuntime().databaseTestLogin;
    if (!login) return loginError(request, "configuration");
    const session = await login.createSession(credentials);
    const response = NextResponse.redirect(new URL("/today", request.url), 303);
    response.cookies.set(SESSION_COOKIE_NAME, session.cookieSecret, sessionCookieOptions);
    return response;
  } catch (error) {
    if (error instanceof DatabaseTestAuthenticationError) {
      return loginError(request, "authentication_failed");
    }
    if (
      isConfigurationError(error) ||
      error instanceof DatabaseTestIdentityRoleError
    ) {
      return loginError(request, "configuration");
    }
    if (error instanceof DatabaseTestRepositoryUnavailable) {
      return loginError(request, "service_unavailable");
    }
    return loginError(request, "service_unavailable");
  }
}

function isConfigurationError(error: unknown): boolean {
  return error instanceof RuntimeEnvironmentConfigurationError ||
    error instanceof LocalSyntheticConfigurationError ||
    error instanceof AuthConfigurationError;
}

function loginError(
  request: Request,
  code: "authentication_failed" | "configuration" | "service_unavailable",
): Response {
  return NextResponse.redirect(new URL(`/login?error=${code}`, request.url), 303);
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
