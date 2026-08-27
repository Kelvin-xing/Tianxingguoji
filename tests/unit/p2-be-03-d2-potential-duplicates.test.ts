import assert from "node:assert/strict";
import test from "node:test";
import { buildPotentialDuplicateWarnings, verifyPotentialDuplicateWarningToken } from "../../modules/crm/infrastructure/potential-duplicate-token-codec.ts";

test("D2 warning matches only name/email/phone and signs an opaque token", () => {
  const result = buildPotentialDuplicateWarnings({ kind: "student", name: " Alice ", email: "ALICE@example.invalid", phone: null, organizationId: "org", actorUserId: "actor", candidateVersion: "v1", nowMs: 1000, candidates: [{ id: "1", displayName: "Alice", email: "alice@example.invalid", phone: "999" }] });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.matchingFields.includes("display_name"), true);
  assert.equal(verifyPotentialDuplicateWarningToken(result.warningToken!, { org: "org", actor: "actor", kind: "student", fieldsHash: result.fieldsHash, candidateVersion: "v1" }, 1000), true);
});

test("D2 warning token expires and cannot cross actor/org", () => {
  const result = buildPotentialDuplicateWarnings({ kind: "guardian", name: "Alice", email: null, phone: "123", organizationId: "org", actorUserId: "actor", candidateVersion: "v1", nowMs: 1000, candidates: [{ id: "1", displayName: "Alice", email: null, phone: "123" }] });
  assert.equal(verifyPotentialDuplicateWarningToken(result.warningToken!, { org: "org", actor: "actor", kind: "guardian", fieldsHash: "x", candidateVersion: "v1" }, 601001), false);
  for (const expected of [
    { org: "other", actor: "actor", kind: "guardian" as const, fieldsHash: result.fieldsHash, candidateVersion: "v1" },
    { org: "org", actor: "other", kind: "guardian" as const, fieldsHash: result.fieldsHash, candidateVersion: "v1" },
    { org: "org", actor: "actor", kind: "student" as const, fieldsHash: result.fieldsHash, candidateVersion: "v1" },
    { org: "org", actor: "actor", kind: "guardian" as const, fieldsHash: "other", candidateVersion: "v1" },
    { org: "org", actor: "actor", kind: "guardian" as const, fieldsHash: result.fieldsHash, candidateVersion: "other" },
  ]) assert.equal(verifyPotentialDuplicateWarningToken(result.warningToken!, expected, 1000), false);
});
