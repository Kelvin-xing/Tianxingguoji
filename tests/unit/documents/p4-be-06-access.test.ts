import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canUseCaseDocument } from "../../../modules/documents/domain/p4-be-06-access.ts";

const actor = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", roles: ["founder","advisor"] as const, workspaceCapabilities: ["documents.read","documents.upload","documents.download"] as const };
test("request-time Access union allows Primary Advisor document operations", () => assert.equal(canUseCaseDocument({ actor,isPrimaryAdvisor: true,isApplicationAssignee: false,isContractor: false,operation: "upload" }),true));
test("Application Assignee is bounded to required Case documents", () => assert.equal(canUseCaseDocument({ actor,isPrimaryAdvisor: false,isApplicationAssignee: true,isContractor: false,operation: "download" }),true));
test("Contractor/Admin/legacy role cannot enter Case document boundary", () => {
  assert.equal(canUseCaseDocument({ actor,isPrimaryAdvisor: false,isApplicationAssignee: false,isContractor: true,operation: "read" }),false);
  assert.equal(canUseCaseDocument({ actor: { ...actor,workspaceCapabilities: [] },isPrimaryAdvisor: true,isApplicationAssignee: false,isContractor: false,operation: "read" }),false);
});

test("Documents exposes its clean Task evidence adapter through the server entrypoint", async () => {
  const server = await readFile(new URL("../../../modules/documents/server.ts", import.meta.url), "utf8");
  assert.match(server, /export \* from "\.\/infrastructure\/postgresql-clean-task-evidence\.ts";/);
});
