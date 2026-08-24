import assert from "node:assert/strict";
import test from "node:test";

import studentProfileCatalogue from "../../../schema/k12/student-profile.v1.json" with { type: "json" };
import educationProfileCatalogue from "../../../schema/k12/education-profile.v1.json" with { type: "json" };
import schoolPreferencesCatalogue from "../../../schema/k12/school-preferences.v1.json" with { type: "json" };
import familyContextCatalogue from "../../../schema/k12/family-context.v1.json" with { type: "json" };

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  CaseAssessmentIdempotencyAttempt,
  completeCaseAssessmentBackground,
  getCaseAssessment,
  updateCaseAssessmentAnswer,
} from "../../../modules/cases/client.ts";
import { composeK12Manifest, parseK12Module } from "../../../modules/cases/domain/contract.ts";
import { resolveAssessmentSchema } from "../../../modules/cases/domain/schema-resolver.ts";

const ids = Object.freeze({
  serviceCase: "40000000-0000-4000-8000-000000000001",
  assessment: "50000000-0000-4000-8000-000000000001",
  manifest: "30000000-0000-4000-8000-000000000001",
});
const approvedSchema = resolveAssessmentSchema({
  manifestId: ids.manifest,
  manifest: composeK12Manifest([
    parseK12Module(studentProfileCatalogue),
    parseK12Module(educationProfileCatalogue),
    parseK12Module(schoolPreferencesCatalogue),
    parseK12Module(familyContextCatalogue),
  ]),
});

test("Assessment GET strictly accepts full read-only and three-field collaborator projections", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestCount = 0;
  globalThis.fetch = async (request, init) => {
    requestCount += 1;
    assert.equal(request, `/api/v1/cases/${ids.serviceCase}/assessment`);
    assert.equal(init?.method, "GET");
    return apiResponse(requestCount === 1 ? fullReadOnlyFixture() : educationProfileFixture());
  };

  const full = await getCaseAssessment(ids.serviceCase);
  assert.equal(full.access.mode, "full");
  assert.equal(full.access.can_edit, false);
  assert.deepEqual(full.access.editable_field_ids, []);
  const collaborator = await getCaseAssessment(ids.serviceCase);
  assert.equal(collaborator.access.mode, "education_profile");
  assert.equal(collaborator.schema.fields.length, 3);
  assert.deepEqual(collaborator.access.editable_field_ids, collaborator.schema.fields.map(({ field_id }) => field_id));
});

test("Assessment GET rejects unknown access fields, inconsistent edit access and noncanonical field order", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const fixture = educationProfileFixture();
  const fullEditable = fullEditableFixture();
  const fullReadOnly = fullReadOnlyFixture();
  const firstFullField = fullReadOnly.schema.fields[0]!;
  const secondFullField = fullReadOnly.schema.fields[1]!;
  const malformed = [
    { ...fixture, access: { ...fixture.access, invented: true } },
    { ...fixture, access: { ...fixture.access, can_edit: false } },
    { ...fixture, access: { ...fixture.access, editable_field_ids: fixture.access.editable_field_ids.slice(0, 2) } },
    { ...fixture, access: { ...fixture.access, editable_field_ids: [...fixture.access.editable_field_ids].reverse() } },
    { ...fixture, schema: { ...fixture.schema, fields: fixture.schema.fields.slice(0, 2) } },
    { ...fixture, schema: { ...fixture.schema, fields: [...fixture.schema.fields].reverse() } },
    { ...fullEditable, schema: { ...fullEditable.schema, fields: fullEditable.schema.fields.slice(0, 14) } },
    { ...fullEditable, access: { ...fullEditable.access, editable_field_ids: fullEditable.access.editable_field_ids.slice(0, 14) } },
    {
      ...fullReadOnly,
      schema: { ...fullReadOnly.schema, fields: [
        { ...firstFullField, field_id: "invented.field" },
        ...fullReadOnly.schema.fields.slice(1),
      ] },
    },
    {
      ...fullReadOnly,
      schema: { ...fullReadOnly.schema, fields: [
        { ...firstFullField, value_type: "text" },
        ...fullReadOnly.schema.fields.slice(1),
      ] },
    },
    {
      ...fullReadOnly,
      schema: { ...fullReadOnly.schema, fields: [
        { ...firstFullField, blocking_stages: [...firstFullField.blocking_stages].reverse() },
        ...fullReadOnly.schema.fields.slice(1),
      ] },
    },
    {
      ...fullReadOnly,
      answers: [unknownAnswer(secondFullField.field_id), unknownAnswer(firstFullField.field_id)],
    },
  ];
  for (const value of malformed) {
    globalThis.fetch = async () => apiResponse(value);
    await assert.rejects(getCaseAssessment(ids.serviceCase), malformedResponse);
  }
});

test("Assessment writes send frozen bodies and accept only exact two-key acknowledgements", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests: unknown[] = [];
  globalThis.fetch = async (request, init) => {
    requests.push({ request, method: init?.method, body: JSON.parse(String(init?.body)) });
    assert.equal(new Headers(init?.headers).get("idempotency-key"), `assessment-attempt-${requests.length}`);
    return apiResponse({ id: ids.assessment, record_version: requests.length + 1 });
  };

  const answerReceipt = await updateCaseAssessmentAnswer(ids.serviceCase, {
    field_id: "education_profile.current_stage",
    semantic_state: "provided",
    value: { type: "enum", value: "secondary" },
    value_type: "enum",
    expected_record_version: 1,
  }, "assessment-attempt-1");
  const completionReceipt = await completeCaseAssessmentBackground(
    ids.serviceCase,
    2,
    "assessment-attempt-2",
  );
  assert.deepEqual(answerReceipt, { id: ids.assessment, record_version: 2 });
  assert.deepEqual(completionReceipt, { id: ids.assessment, record_version: 3 });
  assert.deepEqual(requests, [
    {
      request: `/api/v1/cases/${ids.serviceCase}/assessment`,
      method: "PATCH",
      body: {
        field_id: "education_profile.current_stage",
        semantic_state: "provided",
        value: { type: "enum", value: "secondary" },
        value_type: "enum",
        expected_record_version: 1,
      },
    },
    {
      request: `/api/v1/cases/${ids.serviceCase}/assessment/background-completion`,
      method: "POST",
      body: { expected_record_version: 2 },
    },
  ]);

  globalThis.fetch = async () => apiResponse({
    id: ids.assessment,
    record_version: 4,
    semantic_state: "provided",
  });
  await assert.rejects(completeCaseAssessmentBackground(
    ids.serviceCase,
    3,
    "assessment-strict-receipt",
  ), malformedResponse);
});

test("Assessment idempotency attempt reuses uncertain keys and rotates on command changes", () => {
  let sequence = 0;
  const attempt = new CaseAssessmentIdempotencyAttempt(() => `assessment-attempt-${++sequence}`);
  const first = attempt.keyFor("field-a:provided:value-a:1");
  assert.equal(attempt.keyFor("field-a:provided:value-a:1"), first);
  assert.notEqual(attempt.keyFor("field-a:provided:value-b:1"), first);
  attempt.complete();
  assert.notEqual(attempt.keyFor("field-a:provided:value-b:1"), first);
});

function fullReadOnlyFixture() {
  const fields = fullFields();
  return assessmentFixture(fields, {
    mode: "full",
    can_edit: false,
    editable_field_ids: [],
    can_complete_background: false,
  }, [unknownAnswer(fields[0]!.field_id), unknownAnswer(fields[3]!.field_id)]);
}

function fullEditableFixture() {
  const fields = fullFields();
  return assessmentFixture(fields, {
    mode: "full",
    can_edit: true,
    editable_field_ids: fields.map(({ field_id }) => field_id),
    can_complete_background: true,
  });
}

function fullFields() {
  return approvedSchema.fields.map((field) => ({
    field_id: field.fieldId,
    label: field.label,
    layer: field.layer,
    module_id: field.moduleId,
    module_version: field.moduleVersion,
    value_type: field.valueType,
    ...(field.enumValues ? { enum_values: field.enumValues } : {}),
    visibility: field.visibility,
    blocking_stages: field.blockingStages,
  }));
}

function educationProfileFixture() {
  const fields = fullFields().filter(({ module_id }) => module_id === "k12-education-profile");
  return assessmentFixture(fields, {
    mode: "education_profile",
    can_edit: true,
    editable_field_ids: fields.map(({ field_id }) => field_id),
    can_complete_background: false,
  });
}

function assessmentFixture(
  fields: ReadonlyArray<ReturnType<typeof fullFields>[number]>,
  access: Readonly<{
    mode: "full" | "education_profile";
    can_edit: boolean;
    editable_field_ids: readonly string[];
    can_complete_background: boolean;
  }>,
  answers: readonly ReturnType<typeof unknownAnswer>[] = [],
) {
  return {
    assessment_id: ids.assessment,
    manifest_id: ids.manifest,
    record_version: 1,
    status: "draft",
    access,
    schema: {
      manifest_id: ids.manifest,
      composition_version: approvedSchema.compositionVersion,
      fields,
    },
    answers,
  } as const;
}

function unknownAnswer(fieldId: string) {
  return {
    field_id: fieldId,
    semantic_state: "unknown",
    value: null,
    value_type: null,
    record_version: 1,
  } as const;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "assessment-client-test", data }, {
    headers: { "x-request-id": "assessment-client-test" },
  });
}

function malformedResponse(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE";
}
