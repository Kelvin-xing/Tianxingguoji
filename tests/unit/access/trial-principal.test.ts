import assert from "node:assert/strict";
import test from "node:test";
import { loadTrialPrincipal, type TrialPrincipalTransaction } from "../../../modules/access/infrastructure/postgresql-trial-principal.ts";
const row = { user_id: "employee", organization_id: "tianxingjiaoyu", level: "l2", categories: ["international_school"], active: true, record_version: "2" };
function database(rows: unknown[]): TrialPrincipalTransaction {
  return { async query<Row extends Record<string, unknown>>() { return { rows: rows as Row[] }; } };
}
const input = { userId: "employee", organizationId: "tianxingjiaoyu" };

test("absence differs from disabled trial membership, preventing legacy fallback", async () => {
  assert.equal(await loadTrialPrincipal(database([]), input), null);
  const disabled = await loadTrialPrincipal(database([{ ...row, active: false }]), input);
  assert.equal(disabled?.active, false);
  assert.equal(disabled?.level, "l2");
});

test("authoritative principal rejects unknown, malformed, duplicate or mismatched database rows", async () => {
  for (const rows of [
    [{ ...row, level: "admin" }], [{ ...row, categories: ["unknown"] }],
    [{ ...row, record_version: 0 }], [{ ...row, active: "true" }],
    [{ ...row, user_id: "other" }], [row, row],
  ]) await assert.rejects(loadTrialPrincipal(database(rows), input), /Invalid authoritative/);
});

test("mutations request locks and every read obtains fresh categories/version", async () => {
  const calls: string[] = [];
  const db: TrialPrincipalTransaction = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      calls.push(sql);
      return { rows: [{ ...row, categories: calls.length === 1 ? row.categories : [], record_version: calls.length + 1 }] as unknown as Row[] };
    },
  };
  assert.deepEqual((await loadTrialPrincipal(db, input))?.categories, ["international_school"]);
  const revoked = await loadTrialPrincipal(db, { ...input, lock: true });
  assert.deepEqual(revoked?.categories, []);
  assert.equal(revoked?.recordVersion, 3);
  assert.ok(!calls[0]!.includes("FOR SHARE"));
  assert.ok(calls[1]!.includes("FOR SHARE OF t,m,u,o"));
});
