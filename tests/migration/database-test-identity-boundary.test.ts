import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION_PATH = "db/migrations/202608180120_028_expand_database_test_identity.sql";

test("adds only the approved database-test credential table and session kind", async () => {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE\s+([a-z0-9_]+)/g)].map((match) => match[1]),
    ["identity_database_test_credentials"],
  );
  assert.match(sql, /session_kind IN \('cognito', 'local_synthetic', 'database_test'\)/);
  assert.match(sql, /identity_sessions_one_active_database_test_per_user_idx/);
  assert.match(sql, /WHERE session_kind = 'database_test' AND status = 'active'/);
  assert.match(sql, /verifier_version = 'scrypt-v1'/);
  assert.match(sql, /octet_length\(password_salt\) = 32/);
  assert.match(sql, /octet_length\(password_verifier\) = 64/);
  assert.doesNotMatch(sql, /scrypt_(?:n|r|p|maxmem)/i);
});

test("isolates test runtime roles without changing the production application role", async () => {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  for (const role of [
    "tianxing_test_application",
    "tianxing_test_identity",
    "tianxing_test_provisioner",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER\\s+ROLE\\s+${role}\\s+WITH\\s+NOLOGIN\\s+NOSUPERUSER\\s+` +
          `NOCREATEDB\\s+NOCREATEROLE\\s+INHERIT\\s+NOREPLICATION\\s+NOBYPASSRLS;`,
        "i",
      ),
    );
  }
  assert.match(sql, /CREATE ROLE tianxing_test_application NOLOGIN/);
  assert.match(sql, /GRANT tianxing_app TO tianxing_test_application/);
  assert.doesNotMatch(sql, /ALTER\s+ROLE\s+tianxing_app\b/i);
  assert.doesNotMatch(
    sql,
    /REVOKE\s+INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+(?:public\.)?identity_sessions\s+FROM\s+tianxing_app/i,
  );
  for (const name of [
    "identity_database_test_lookup_credential",
    "identity_database_test_complete_login",
    "identity_database_test_resolve_session",
    "identity_database_test_revoke_session",
    "identity_database_test_lookup_provision_credential",
    "identity_database_test_provision_credential",
  ]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION ${name}`));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(sql, /REVOKE ALL ON TABLE identity_database_test_credentials FROM tianxing_app/);
  assert.match(
    sql,
    /REVOKE ALL ON TABLE identity_database_test_credentials FROM tianxing_test_application/,
  );
  assert.match(sql, /SECURITY DEFINER/g);
});

test("uses caller time only for skew validation and database time for session state", async () => {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  const completeLogin = functionSource(sql, "identity_database_test_complete_login");
  const resolveSession = functionSource(sql, "identity_database_test_resolve_session");

  for (const source of [completeLogin, resolveSession]) {
    const authorityAssignment = "v_now := transaction_timestamp();";
    const authorityIndex = source.indexOf(authorityAssignment);
    assert.ok(authorityIndex > 0);
    const validation = source.slice(0, authorityIndex);
    const state = source.slice(authorityIndex + authorityAssignment.length);
    assert.match(validation, /p_now < transaction_timestamp\(\) - interval '5 minutes'/);
    assert.match(validation, /p_now > transaction_timestamp\(\) \+ interval '5 minutes'/);
    assert.doesNotMatch(state, /\bp_now\b/);
    assert.doesNotMatch(state, /transaction_timestamp\(\)/);
  }

  const completeState = stateAfterAuthorityAssignment(completeLogin);
  assert.match(completeState, /locked_until > v_now/);
  assert.match(completeState, /failure_window_started_at < v_now - interval '15 minutes'/);
  assert.match(completeState, /v_now \+ interval '8 hours'/);
  assert.match(completeState, /v_session_version, v_now;/);

  const resolveState = stateAfterAuthorityAssignment(resolveSession);
  assert.match(resolveState, /v_now >= v_session\.absolute_expires_at/);
  assert.match(resolveState, /v_now > v_session\.reauthenticated_at \+ interval '5 minutes'/);
  assert.match(resolveState, /last_seen_at = v_now/);
  assert.match(resolveState, /updated_at = v_now/);
  assert.match(resolveState, /v_session\.reauthenticated_at;/);
});

test("pins lockout, verifier version CAS, active identity checks, and manifest hash", async () => {
  const [sql, manifestText] = await Promise.all([
    readFile(MIGRATION_PATH, "utf8"),
    readFile("db/migrations/manifest.json", "utf8"),
  ]);
  assert.match(sql, /v_credential\.credential_version <> p_expected_credential_version/);
  assert.match(sql, /interval '15 minutes'/);
  assert.match(sql, /least\(v_credential\.failed_attempt_count \+ 1, 5\)/);
  assert.match(sql, /identity_user\.status = 'active'/);
  assert.match(sql, /membership\.status = 'active'/);
  assert.match(sql, /organization\.status = 'active'/);
  const manifest = JSON.parse(manifestText) as {
    migrations: Array<{ name: string; sha256: string }>;
  };
  const entry = manifest.migrations.find(({ name }) => name === MIGRATION_PATH.split("/").at(-1));
  assert.equal(entry?.sha256, createHash("sha256").update(sql).digest("hex"));
});

test("changes credential version only when verifier material is provisioned or rotated", async () => {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  const completeLogin = functionSource(sql, "identity_database_test_complete_login");
  const failedBranch = completeLogin.slice(
    completeLogin.indexOf("IF NOT p_password_matched THEN"),
    completeLogin.indexOf("SELECT identity_user.normalized_email"),
  );
  const successResetStart = completeLogin.indexOf(
    "UPDATE public.identity_database_test_credentials\n     SET failed_attempt_count = 0",
  );
  const successReset = completeLogin.slice(
    successResetStart,
    completeLogin.indexOf("UPDATE public.identity_sessions", successResetStart),
  );
  const provision = functionSource(sql, "identity_database_test_provision_credential");

  assert.doesNotMatch(failedBranch, /credential_version\s*=/);
  assert.doesNotMatch(successReset, /credential_version\s*=/);
  assert.match(
    provision,
    /credential_version = identity_database_test_credentials\.credential_version \+ 1/,
  );
});

test("models five same-version failed requests serializing to the lock threshold", () => {
  const observedVerifierVersions = [7, 7, 7, 7, 7];
  let state: FailureState = {
    credentialVersion: 7,
    failedAttemptCount: 0,
    failureWindowStartedAtMs: null,
    lockedUntilMs: null,
  };
  const nowMs = Date.parse("2026-08-18T00:00:00.000Z");
  const counts: number[] = [];

  for (const observedVersion of observedVerifierVersions) {
    state = applySerializedFailure(state, observedVersion, nowMs);
    counts.push(state.failedAttemptCount);
  }

  assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  assert.equal(state.credentialVersion, 7);
  assert.equal(state.lockedUntilMs, nowMs + 15 * 60 * 1_000);
});

test("serializes provision attempts on the identity before checking or upserting credentials", async () => {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  const provision = functionSource(sql, "identity_database_test_provision_credential");
  const identityLookup = provision.indexOf("FROM public.identity_users AS identity_user");
  const rowLock = provision.indexOf("FOR UPDATE", identityLookup);
  const existenceCheck = provision.indexOf("SELECT EXISTS", rowLock);
  const upsert = provision.indexOf("INSERT INTO public.identity_database_test_credentials", existenceCheck);

  assert.ok(identityLookup >= 0 && rowLock > identityLookup);
  assert.ok(existenceCheck > rowLock);
  assert.ok(upsert > existenceCheck);
  assert.doesNotMatch(provision, /FOR SHARE/);
  assert.match(provision, /v_credential_exists AND NOT p_rotate[\s\S]*RETURN 'rotation_required'/);
});

interface FailureState {
  readonly credentialVersion: number;
  readonly failedAttemptCount: number;
  readonly failureWindowStartedAtMs: number | null;
  readonly lockedUntilMs: number | null;
}

function applySerializedFailure(
  state: FailureState,
  expectedCredentialVersion: number,
  nowMs: number,
): FailureState {
  assert.equal(state.credentialVersion, expectedCredentialVersion);
  const outsideWindow = state.failureWindowStartedAtMs === null ||
    state.failureWindowStartedAtMs < nowMs - 15 * 60 * 1_000;
  const failedAttemptCount = outsideWindow ? 1 : Math.min(state.failedAttemptCount + 1, 5);
  return {
    credentialVersion: state.credentialVersion,
    failedAttemptCount,
    failureWindowStartedAtMs: failedAttemptCount === 1 ? nowMs : state.failureWindowStartedAtMs,
    lockedUntilMs: failedAttemptCount >= 5 ? nowMs + 15 * 60 * 1_000 : null,
  };
}

function functionSource(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE FUNCTION ${name}`);
  assert.ok(start >= 0);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start);
  return sql.slice(start, end);
}

function stateAfterAuthorityAssignment(source: string): string {
  const assignment = "v_now := transaction_timestamp();";
  const index = source.indexOf(assignment);
  assert.ok(index >= 0);
  return source.slice(index + assignment.length);
}
