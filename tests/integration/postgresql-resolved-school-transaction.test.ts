import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresqlResolvedSchoolTransaction,
  resolvedSchoolDisplayName,
  type SchoolResolutionTransaction,
} from "../../modules/schools/infrastructure/postgresql-resolved-view-transaction.ts";

const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const SCHOOL_ID = "20000000-0000-4000-8000-000000000002";
const SNAPSHOT_ID = "20000000-0000-4000-8000-000000000003";
const REVISION_ID = "20000000-0000-4000-8000-000000000004";

test("reads the active snapshot into one deterministic resolved view", async () => {
  const transaction = new ScriptedTransaction([
    rows([baseRow()]),
    empty(),
  ]);
  const collaborator = new PostgresqlResolvedSchoolTransaction();

  const result = await collaborator.listCurrentResolvedSchools({ transaction, organizationId: ORGANIZATION_ID });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.view.schoolId, SCHOOL_ID);
  assert.equal(result[0]?.view.baseSnapshotId, SNAPSHOT_ID);
  assert.equal(resolvedSchoolDisplayName(result[0]!.view.fields, "fallback"), "合成学校");
  assert.match(result[0]!.view.resolutionSha256, /^[0-9a-f]{64}$/);
});

test("locks the selected school and reuses an identical immutable revision", async () => {
  const readTransaction = new ScriptedTransaction([
    rows([{ id: SCHOOL_ID }]),
    rows([baseRow()]),
    empty(),
  ]);
  const collaborator = new PostgresqlResolvedSchoolTransaction();
  const resolved = await collaborator.readCurrentResolvedSchool({
    transaction: readTransaction,
    organizationId: ORGANIZATION_ID,
    schoolId: SCHOOL_ID,
  });
  assert.match(readTransaction.statements[0] ?? "", /FOR UPDATE/);

  const appendTransaction = new ScriptedTransaction([
    empty(),
    rows([{ id: REVISION_ID }]),
  ]);
  const persisted = await collaborator.appendResolvedRevision({
    transaction: appendTransaction,
    organizationId: ORGANIZATION_ID,
    proposedResolvedRevisionId: "20000000-0000-4000-8000-000000000005",
    resolved,
    createdAtMs: Date.parse("2026-08-18T00:00:00.000Z"),
  });

  assert.equal(persisted.pin.resolvedRevisionId, REVISION_ID);
  assert.match(appendTransaction.statements[0] ?? "", /INSERT INTO schools_resolved_revisions/);
  assert.match(appendTransaction.statements[0] ?? "", /ON CONFLICT .* DO NOTHING/s);
});

class ScriptedTransaction implements SchoolResolutionTransaction {
  readonly statements: string[] = [];
  private readonly results: Array<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }>;

  constructor(results: Array<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }>) {
    this.results = [...results];
  }

  async query<Row extends Record<string, unknown>>(text: string) {
    this.statements.push(text);
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected school transaction query.");
    return result as { readonly rows: readonly Row[]; readonly rowCount: number };
  }
}

function baseRow() {
  return {
    school_id: SCHOOL_ID,
    snapshot_id: SNAPSHOT_ID,
    source_school_key: "synthetic-school-001",
    fields_json: {
      school_key: "synthetic-school-001",
      school_name_zh: "合成学校",
      school_name_en: "Synthetic School",
      district: "Central",
    },
  };
}

function rows(values: readonly Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function empty() {
  return { rows: [], rowCount: 0 };
}
