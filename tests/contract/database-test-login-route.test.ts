import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DATABASE_TEST_LOGIN_BODY_MAX_BYTES,
  DatabaseTestLoginRequestError,
  readDatabaseTestLoginRequest,
} from "../../app/api/v1/auth/login/route-contract.ts";
import {
  IdentityServiceError,
  isIdentityServiceError,
} from "../../modules/identity/application/service.ts";

test("accepts exactly one URL-encoded email and password field", async () => {
  const result = await readDatabaseTestLoginRequest(request(
    "email=synthetic%40example.invalid&password=correct+horse",
  ));
  assert.deepEqual(result, {
    email: "synthetic@example.invalid",
    password: "correct horse",
  });
});

test("rejects role injection, unknown fields, duplicates, and wrong content types uniformly", async () => {
  const candidates = [
    request("email=a%40b.invalid&password=x&role=founder"),
    request("email=a%40b.invalid&password=x&organization_id=51000000-0000-4000-8000-000000000001"),
    request("email=a%40b.invalid&password=x&next=%2Fadmin"),
    request("email=a%40b.invalid&email=c%40d.invalid&password=x"),
    request("email=a%40b.invalid&password=x", "application/json"),
    request("email=a%40b.invalid&password=%ZZ"),
  ];
  for (const candidate of candidates) {
    await assert.rejects(readDatabaseTestLoginRequest(candidate), DatabaseTestLoginRequestError);
  }
});

test("streams and rejects the request as soon as the 4 KiB bound is exceeded", async () => {
  const body = `email=a%40b.invalid&password=${"x".repeat(DATABASE_TEST_LOGIN_BODY_MAX_BYTES)}`;
  await assert.rejects(readDatabaseTestLoginRequest(request(body)), DatabaseTestLoginRequestError);
});

test("route keeps explicit authentication, configuration, and availability mappings", async () => {
  const source = await readFile("app/api/v1/auth/login/route.ts", "utf8");
  assert.match(source, /DatabaseTestAuthenticationError[\s\S]*"authentication_failed"/);
  assert.match(source, /DatabaseTestIdentityRoleError[\s\S]*"configuration"/);
  assert.match(source, /DatabaseTestRepositoryUnavailable[\s\S]*"service_unavailable"/);
  assert.match(
    source,
    /const session = await login\.createSession\(credentials\)[\s\S]*response\.cookies\.set\(SESSION_COOKIE_NAME, session\.cookieSecret, sessionCookieOptions\)/,
  );
  assert.doesNotMatch(source, /catch\s*\{[\s\S]{0,160}loginError\(request, "configuration"\)/);
});

test("recognizes a session error copied across a Next Route Handler bundle", () => {
  assert.equal(
    isIdentityServiceError(new IdentityServiceError("SESSION_NOT_FOUND"), "SESSION_NOT_FOUND"),
    true,
  );
  const crossBundleError = Object.assign(new Error("redacted"), {
    name: "IdentityServiceError",
    code: "SESSION_NOT_FOUND",
  });
  assert.equal(isIdentityServiceError(crossBundleError, "SESSION_NOT_FOUND"), true);
  assert.equal(isIdentityServiceError(crossBundleError, "INVITE_NOT_FOUND"), false);
  assert.equal(isIdentityServiceError(Object.assign(new Error("redacted"), {
    name: "IdentityServiceError",
    code: "UNRECOGNIZED",
  })), false);
});

function request(
  body: string,
  contentType = "application/x-www-form-urlencoded; charset=UTF-8",
): Request {
  return new Request("https://test.example.invalid/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}
