import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export type EmptyMigrationSnapshot = {
  target: "empty";
  applied: [];
  expectedSchemaSha256: null;
  actualSchemaSha256: null;
};

type AppliedMigration = {
  name: string;
  sha256: string;
};

export type PriorMigrationSnapshot = {
  target: "prior";
  applied: AppliedMigration[];
  expectedSchemaSha256: string;
  actualSchemaSha256: string;
};

export type PlanMigrationInput = {
  migrationDirectory: string;
  snapshot: EmptyMigrationSnapshot | PriorMigrationSnapshot;
};

type PlannedMigration = {
  name: string;
  sha256: string;
  state: "applied" | "pending";
};

export type MigrationPlan = {
  planVersion: 1;
  status: "pass" | "warn" | "fail";
  target: "empty" | "prior";
  migrations: PlannedMigration[];
  findings: MigrationFinding[];
};

type MigrationFinding =
  | {
      code: "INVALID_MIGRATION_NAME";
      severity: "error";
      migrationName: string;
    }
  | {
      code: "APPLIED_MIGRATION_ORDER_MISMATCH";
      severity: "error";
      expectedMigrationNames: string[];
      actualMigrationNames: string[];
    }
  | {
      code: "PENDING_MIGRATIONS";
      severity: "warning";
      migrationNames: string[];
    }
  | {
      code: "MIGRATION_CHECKSUM_MISMATCH";
      severity: "error";
      migrationName: string;
      expectedSha256: string;
      actualSha256: string;
    }
  | {
      code: "SCHEMA_DRIFT";
      severity: "error";
      expectedSchemaSha256: string;
      actualSchemaSha256: string;
    };

const MIGRATION_NAME_PATTERN =
  /^\d{12}_\d{3}_(expand|backfill|switch|contract|harden|expose|grant|enable|fix)_[a-z][a-z0-9_]*\.sql$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class MigrationPlanInputError extends Error {}

export async function planMigration(input: PlanMigrationInput): Promise<MigrationPlan> {
  const entries = await readdir(input.migrationDirectory, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const appliedNames = new Set(input.snapshot.applied.map(({ name }) => name));
  const migrations = await Promise.all(
    migrationNames.map(async (name): Promise<PlannedMigration> => {
      const contents = await readFile(join(input.migrationDirectory, name));
      return {
        name,
        sha256: createHash("sha256").update(contents).digest("hex"),
        state: appliedNames.has(name) ? "applied" : "pending",
      };
    }),
  );
  const invalidNameFindings: MigrationFinding[] = migrationNames
    .filter((name) => !MIGRATION_NAME_PATTERN.test(name))
    .map((migrationName) => ({
      code: "INVALID_MIGRATION_NAME",
      severity: "error",
      migrationName,
    }));
  const pendingMigrationNames = migrations
    .filter(({ state }) => state === "pending")
    .map(({ name }) => name);
  const hasPendingPriorMigrations =
    input.snapshot.target === "prior" && pendingMigrationNames.length > 0;
  const actualAppliedNames = input.snapshot.applied.map(({ name }) => name);
  const expectedAppliedNames = migrationNames.slice(0, actualAppliedNames.length);
  const appliedOrderMatches =
    actualAppliedNames.length === expectedAppliedNames.length &&
    actualAppliedNames.every((name, index) => name === expectedAppliedNames[index]);
  const orderFindings: MigrationFinding[] = appliedOrderMatches
    ? []
    : [
        {
          code: "APPLIED_MIGRATION_ORDER_MISMATCH",
          severity: "error",
          expectedMigrationNames: expectedAppliedNames,
          actualMigrationNames: actualAppliedNames,
        },
      ];
  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const checksumFindings: MigrationFinding[] = input.snapshot.applied.flatMap((applied) => {
    const migration = migrationsByName.get(applied.name);
    if (!migration || migration.sha256 === applied.sha256) {
      return [];
    }

    return [
      {
        code: "MIGRATION_CHECKSUM_MISMATCH" as const,
        severity: "error" as const,
        migrationName: applied.name,
        expectedSha256: applied.sha256,
        actualSha256: migration.sha256,
      },
    ];
  });
  const pendingFindings: MigrationFinding[] = hasPendingPriorMigrations
    ? [
        {
          code: "PENDING_MIGRATIONS",
          severity: "warning",
          migrationNames: pendingMigrationNames,
        },
      ]
    : [];
  const driftFindings: MigrationFinding[] =
    input.snapshot.target === "prior" &&
    input.snapshot.expectedSchemaSha256 !== input.snapshot.actualSchemaSha256
      ? [
          {
            code: "SCHEMA_DRIFT",
            severity: "error",
            expectedSchemaSha256: input.snapshot.expectedSchemaSha256,
            actualSchemaSha256: input.snapshot.actualSchemaSha256,
          },
        ]
      : [];
  const findings = [
    ...invalidNameFindings,
    ...orderFindings,
    ...checksumFindings,
    ...driftFindings,
    ...pendingFindings,
  ];
  const hasErrors =
    invalidNameFindings.length > 0 ||
    orderFindings.length > 0 ||
    checksumFindings.length > 0 ||
    driftFindings.length > 0;

  return {
    planVersion: 1,
    status: hasErrors ? "fail" : hasPendingPriorMigrations ? "warn" : "pass",
    target: input.snapshot.target,
    migrations,
    findings,
  };
}

async function runCli(arguments_: string[]): Promise<number> {
  const migrationDirectory = readArgument(arguments_, "--migrations");
  const snapshotPath = readArgument(arguments_, "--snapshot");
  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    throw new MigrationPlanInputError("Snapshot could not be read as JSON.");
  }
  const snapshot = parseSnapshot(snapshotValue);
  const plan = await planMigration({ migrationDirectory, snapshot });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return plan.status === "fail" ? 2 : 0;
}

function readArgument(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new MigrationPlanInputError(`Missing required argument: ${name}`);
  }
  return value;
}

function parseSnapshot(value: unknown): EmptyMigrationSnapshot | PriorMigrationSnapshot {
  if (!isRecord(value) || !Array.isArray(value.applied)) {
    throw new MigrationPlanInputError("Snapshot must contain an applied migration array.");
  }

  if (
    value.target === "empty" &&
    value.applied.length === 0 &&
    value.expectedSchemaSha256 === null &&
    value.actualSchemaSha256 === null
  ) {
    return {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    };
  }

  if (
    value.target === "prior" &&
    typeof value.expectedSchemaSha256 === "string" &&
    typeof value.actualSchemaSha256 === "string"
  ) {
    if (
      !SHA256_PATTERN.test(value.expectedSchemaSha256) ||
      !SHA256_PATTERN.test(value.actualSchemaSha256)
    ) {
      throw new MigrationPlanInputError(
        "Snapshot schema fingerprints must be lowercase SHA-256 values.",
      );
    }

    const appliedMigrationsAreValid = value.applied.every(
      (migration) =>
        isRecord(migration) &&
        typeof migration.name === "string" &&
        typeof migration.sha256 === "string" &&
        SHA256_PATTERN.test(migration.sha256),
    );
    if (!appliedMigrationsAreValid) {
      throw new MigrationPlanInputError(
        "Applied migrations must contain names and lowercase SHA-256 values.",
      );
    }

    return {
      target: "prior",
      applied: value.applied.map((migration) => ({
        name: migration.name as string,
        sha256: migration.sha256 as string,
      })),
      expectedSchemaSha256: value.expectedSchemaSha256,
      actualSchemaSha256: value.actualSchemaSha256,
    };
  }

  throw new MigrationPlanInputError(
    "Snapshot does not match the empty or prior schema contract.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof MigrationPlanInputError
          ? error.message
          : "Migration planning failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
