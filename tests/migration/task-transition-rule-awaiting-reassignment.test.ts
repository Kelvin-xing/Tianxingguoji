import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HISTORICAL_MIGRATION =
  "db/migrations/202608022230_005_expand_tasks.sql";
const CURRENT_TASK_MIGRATION =
  "db/migrations/202608260050_041_expand_school_target_task_events.sql";
const CORRECTIVE_MIGRATION =
  "db/migrations/202608260130_050_allow_awaiting_reassignment_task_rules.sql";
const ACTOR_KIND_KEY_MIGRATION =
  "db/migrations/202608260140_051_allow_task_transition_actor_kind_key.sql";
const SOURCE_MANIFEST = "db/migrations/manifest.json";
const BASELINE_MANIFEST = "db/baselines/one-role/manifest.json";
const SEED_SCRIPT = "scripts/db/seed-neon-test-release1.ts";

const CORRECTIVE_MIGRATION_NAME = CORRECTIVE_MIGRATION.slice(
  "db/migrations/".length,
);

test("050 adds awaiting_reassignment without changing historical migration 005", async () => {
  const [historical, current, corrective] = await Promise.all([
    readFile(HISTORICAL_MIGRATION, "utf8"),
    readFile(CURRENT_TASK_MIGRATION, "utf8"),
    readFile(CORRECTIVE_MIGRATION, "utf8"),
  ]);

  assert.doesNotMatch(historical, /awaiting_reassignment/);
  assert.match(current, /ALTER TABLE tasks_tasks/);
  assert.match(current, /tasks_task_transition_receipts/);
  assert.match(
    corrective,
    /DROP CONSTRAINT IF EXISTS tasks_transition_rules_state_check/,
  );
  assert.match(
    corrective,
    /ADD CONSTRAINT tasks_transition_rules_state_check CHECK/,
  );
  assert.match(
    corrective,
    /from_state IN \([\s\S]*'awaiting_reassignment'[\s\S]*\)/,
  );
  assert.match(
    corrective,
    /to_state IN \([\s\S]*'awaiting_reassignment'[\s\S]*\)/,
  );
  assert.match(corrective, /'reassigned'/);
  assert.doesNotMatch(corrective, /DROP TABLE|DISABLE ROW LEVEL SECURITY/i);
});

test("050 is present in the source and generated one-role manifests", async () => {
  const [sourceRaw, baselineRaw, sourceSql] = await Promise.all([
    readFile(SOURCE_MANIFEST, "utf8"),
    readFile(BASELINE_MANIFEST, "utf8"),
    readFile(CORRECTIVE_MIGRATION, "utf8"),
  ]);
  const source = JSON.parse(sourceRaw) as {
    migrations: readonly { name: string; sha256: string }[];
  };
  const baseline = JSON.parse(baselineRaw) as {
    source_migrations: readonly {
      name: string;
      generated_file: string;
      source_sha256: string;
      generated_sha256: string;
      transform: string;
    }[];
  };
  const sourceEntry = source.migrations.find(
    ({ name }) => name === CORRECTIVE_MIGRATION_NAME,
  );
  const baselineEntry = baseline.source_migrations.find(
    ({ name }) => name === CORRECTIVE_MIGRATION_NAME,
  );

  assert.ok(sourceEntry);
  assert.ok(baselineEntry);
  assert.equal(baselineEntry.transform, "copy-v1");
  assert.equal(baselineEntry.source_sha256, sourceEntry.sha256);
  assert.equal(baselineEntry.generated_sha256, sourceEntry.sha256);
  assert.equal(
    await readFile(
      `db/baselines/one-role/generated/${baselineEntry.generated_file}`,
      "utf8",
    ),
    sourceSql,
  );
});

test("Release 1 seed inserts transition rules through the shared policy definition", async () => {
  const seed = await readFile(SEED_SCRIPT, "utf8");
  assert.match(seed, /RELEASE_1_TASK_TRANSITION_RULES/);
  assert.match(seed, /INSERT INTO tasks_transition_rules/);
  assert.match(
    seed,
    /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6::text\[\],\$7,\$8\)/,
  );
  assert.match(seed, /rule\.from/);
  assert.match(seed, /rule\.to/);
});

test("051 allows distinct actor kinds for one state transition", async () => {
  const migration = await readFile(ACTOR_KIND_KEY_MIGRATION, "utf8");
  assert.match(migration, /DROP CONSTRAINT IF EXISTS tasks_transition_rules_pkey/);
  assert.match(
    migration,
    /ADD CONSTRAINT tasks_transition_rules_pkey PRIMARY KEY \([\s\S]*actor_kind[\s\S]*\)/,
  );
  assert.doesNotMatch(migration, /DROP TABLE|DISABLE ROW LEVEL SECURITY/i);
});
