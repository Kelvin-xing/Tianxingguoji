import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthPoolConfiguration } from "../../../modules/identity/infrastructure/postgresql-client.ts";

test("database-test auth pool uses the approved local URL without DATABASE_URL", () => {
  const config = resolveAuthPoolConfiguration({
    APP_ENV: "development", NODE_ENV: "development", APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test", LOCAL_SYNTHETIC_DATABASE_URL: "postgresql://tianxing_app:secret@127.0.0.1:5432/tianxing",
    LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS: "1000",
  });
  assert.equal(config.kind, "node-pg");
  assert.equal(config.options?.max, 1);
  assert.equal(config.options?.connectionString, "postgresql://tianxing_app:secret@127.0.0.1:5432/tianxing");
});

test("production cognito auth pool still validates DATABASE_URL", () => {
  const base = { APP_ENV: "production", NODE_ENV: "production", APP_RUNTIME_MODE: "production-aws", AUTH_MODE: "cognito" };
  assert.throws(() => resolveAuthPoolConfiguration(base), /DATABASE_URL/);
  assert.equal(resolveAuthPoolConfiguration({ ...base, DATABASE_URL: "postgresql://tianxing_app:secret@db.example.com/prod" }).kind, "neon");
});
