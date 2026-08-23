import assert from "node:assert/strict";
import test from "node:test";

import {
  mapProfileMaintenanceError,
  parseGuardianProfileUpdate,
  parseStudentProfileUpdate,
  toProfileAcknowledgement,
} from "../../app/api/v1/profile-maintenance-handler.ts";
import { ProfileMaintenanceError } from "../../modules/crm/application/profile-maintenance-service.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const STUDENT_ID = "51000000-0000-4000-8000-000000000601";
const GUARDIAN_ID = "51000000-0000-4000-8000-000000000701";

test("parses the exact frozen Student and Guardian PATCH requests", async () => {
  assert.deepEqual(await parseStudentProfileUpdate(json(studentBody()), STUDENT_ID, "request-1"), {
    studentId: STUDENT_ID, displayName: " Student ", dateOfBirth: "2012-06-01",
    contactEmail: "STUDENT@EXAMPLE.INVALID", contactPhone: null, expectedRecordVersion: 1,
    requestId: "request-1", idempotencyKey: "profile-attempt-1",
  });
  assert.deepEqual(await parseGuardianProfileUpdate(json(guardianBody()), GUARDIAN_ID, "request-2"), {
    guardianId: GUARDIAN_ID, displayName: " Guardian ", email: "GUARDIAN@EXAMPLE.INVALID",
    phone: null, expectedRecordVersion: 2, requestId: "request-2",
    idempotencyKey: "profile-attempt-1",
  });
});

test("rejects missing, unknown, nested identity and control fields as INVALID_REQUEST", async () => {
  for (const body of [
    { ...studentBody(), organization_id: "hidden" },
    { ...studentBody(), role: "founder" },
    { ...studentBody(), display_name: { value: "nested" } },
    { display_name: "missing" },
  ]) {
    const expected = typeof body.display_name === "object" ? "VALIDATION_FAILED" : "INVALID_REQUEST";
    await reject(parseStudentProfileUpdate(json(body), STUDENT_ID, "request"), expected);
  }
  await reject(parseGuardianProfileUpdate(json(guardianBody(), false), GUARDIAN_ID, "request"),
    "INVALID_REQUEST");
});

test("serializes only the exact non-PII acknowledgement and maps stable errors", () => {
  const acknowledgement = toProfileAcknowledgement({ id: STUDENT_ID, recordVersion: 3,
    updatedAt: "2026-08-23T08:00:00.000Z" });
  assert.deepEqual(acknowledgement, { id: STUDENT_ID, record_version: 3,
    updated_at: "2026-08-23T08:00:00.000Z" });
  assert.deepEqual(Object.keys(acknowledgement).sort(), ["id", "record_version", "updated_at"]);
  const mapped = mapProfileMaintenanceError(
    new ProfileMaintenanceError("PROFILE_MAINTENANCE_STALE_VERSION"),
  );
  assert.equal(mapped instanceof ApiContractError && mapped.code, "STALE_VERSION");
  const pending = mapProfileMaintenanceError(Object.assign(new Error("safe"), {
    name: "ProfileMaintenanceError",
    code: "PROFILE_MAINTENANCE_INACTIVE",
  }));
  assert.equal(pending instanceof ApiContractError && pending.code, "CONFLICT");
});

function studentBody() {
  return { display_name: " Student ", date_of_birth: "2012-06-01",
    contact_email: "STUDENT@EXAMPLE.INVALID", contact_phone: null, expected_record_version: 1 };
}

function guardianBody() {
  return { display_name: " Guardian ", email: "GUARDIAN@EXAMPLE.INVALID", phone: null,
    expected_record_version: 2 };
}

function json(body: unknown, idempotent = true): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotent) headers["idempotency-key"] = "profile-attempt-1";
  return new Request("http://local/api/v1/profile", { method: "PATCH", headers,
    body: JSON.stringify(body) });
}

async function reject(promise: Promise<unknown>, code: ApiContractError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiContractError && error.code === code);
}
