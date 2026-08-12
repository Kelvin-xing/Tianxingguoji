import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  CaseContractError,
  composeK12Manifest,
  evaluateAssessmentFieldAnswer,
  parseK12Module,
} from "../../modules/cases/contract.ts";
import { resolveAssessmentSchema } from "../../modules/cases/schema-resolver.ts";

const CATALOGUE_FILES = [
  "student-profile.v1.json",
  "education-profile.v1.json",
  "school-preferences.v1.json",
  "family-context.v1.json",
] as const;

test("composes the approved four-module K12 catalogue with explicit fields and module-owned blockers", async () => {
  const modules = await Promise.all(
    CATALOGUE_FILES.map(async (fileName) =>
      parseK12Module(JSON.parse(await readFile(resolve("schema/k12", fileName), "utf8")) as unknown),
    ),
  );
  const manifest = composeK12Manifest(modules);
  const schema = resolveAssessmentSchema({
    manifestId: "99999999-9999-4999-8999-999999999999",
    manifest,
  });

  assert.equal(manifest.compositionVersion, "k12-catalogue-v1");
  assert.equal(manifest.productionEnabled, true);
  assert.deepEqual(
    manifest.modules.map(({ layer, moduleId, version }) => ({ layer, moduleId, version })),
    [
      { layer: "admission_route", moduleId: "k12-family-context", version: "1.0.0" },
      { layer: "base", moduleId: "k12-student-profile", version: "1.0.0" },
      { layer: "education_stage", moduleId: "k12-education-profile", version: "1.0.0" },
      { layer: "school_system", moduleId: "k12-school-preferences", version: "1.0.0" },
    ],
  );
  assert.equal(manifest.fields.length, 15);
  assert.equal(manifest.contentSha256, "41ccf1d4782bd245eb94b8760d17fa4c927696bdf9aaecce9dd89a125ad9caac");

  assert.deepEqual(
    schema.fields.map((field) => ({
      fieldId: field.fieldId,
      valueType: field.valueType,
      enumValues: field.enumValues ?? [],
      visibility: field.visibility,
      blockingStages: field.blockingStages,
    })),
    [
      { fieldId: "student_profile.date_of_birth", valueType: "date", enumValues: [], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "student_profile.residency_status", valueType: "enum", enumValues: ["hk_permanent_resident", "hk_non_permanent_resident", "dependent_visa", "other"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "student_profile.primary_languages", valueType: "enum_set", enumValues: ["cantonese", "mandarin", "english", "other"], visibility: "advisor", blockingStages: ["background_collection"] },
      { fieldId: "education_profile.current_stage", valueType: "enum", enumValues: ["kindergarten", "primary", "secondary"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "education_profile.current_year_level", valueType: "text", enumValues: [], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "education_profile.current_curriculum", valueType: "enum", enumValues: ["hk_local", "ib", "cambridge", "other"], visibility: "advisor", blockingStages: ["background_collection"] },
      { fieldId: "school_preferences.target_stage", valueType: "enum", enumValues: ["kindergarten", "primary", "secondary"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "school_preferences.preferred_systems", valueType: "enum_set", enumValues: ["hk_local", "hk_international"], visibility: "advisor", blockingStages: ["school_selection_confirmed"] },
      { fieldId: "school_preferences.preferred_districts", valueType: "enum_set", enumValues: ["hong_kong_island", "kowloon", "new_territories", "any"], visibility: "advisor", blockingStages: ["school_selection_confirmed"] },
      { fieldId: "school_preferences.preferred_admission_route", valueType: "enum", enumValues: ["entry", "transfer"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "school_preferences.fee_band", valueType: "enum", enumValues: ["government_aided", "private", "international", "undecided"], visibility: "advisor", blockingStages: ["school_selection_confirmed"] },
      { fieldId: "family_context.primary_contact_language", valueType: "enum", enumValues: ["cantonese", "mandarin", "english", "other"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "family_context.education_priority", valueType: "enum", enumValues: ["academic", "balanced", "language_immersion", "supportive_environment", "other"], visibility: "advisor", blockingStages: ["background_collection", "school_selection_confirmed"] },
      { fieldId: "family_context.transport_arrangement", valueType: "enum", enumValues: ["family_transport", "school_bus", "public_transport", "undecided"], visibility: "advisor", blockingStages: ["school_selection_confirmed"] },
      { fieldId: "family_context.fee_preference", valueType: "enum", enumValues: ["government_aided", "private", "international", "undecided"], visibility: "advisor", blockingStages: ["school_selection_confirmed"] },
    ],
  );
  assert.ok(schema.fields.every((field) => field.label && field.moduleId && field.moduleVersion));

  const residency = schema.fields.find((field) => field.fieldId === "student_profile.residency_status");
  assert.deepEqual(residency, {
    fieldId: "student_profile.residency_status",
    label: "Residency status",
    layer: "base",
    moduleId: "k12-student-profile",
    moduleVersion: "1.0.0",
    valueType: "enum",
    enumValues: ["hk_permanent_resident", "hk_non_permanent_resident", "dependent_visa", "other"],
    visibility: "advisor",
    blockingStages: ["background_collection", "school_selection_confirmed"],
  });
  const districts = schema.fields.find((field) => field.fieldId === "school_preferences.preferred_districts");
  assert.deepEqual(districts?.blockingStages, ["school_selection_confirmed"]);
  assert.deepEqual(districts?.enumValues, ["hong_kong_island", "kowloon", "new_territories", "any"]);
});

test("enforces production field types and enums while preserving explicit semantic states", () => {
  const residency = approvedField({
    fieldId: "student_profile.residency_status",
    valueType: "enum",
    enumValues: ["hk_permanent_resident", "hk_non_permanent_resident"],
  });
  const languages = approvedField({
    fieldId: "student_profile.primary_languages",
    valueType: "enum_set",
    enumValues: ["cantonese", "english"],
  });
  const birthDate = approvedField({ fieldId: "student_profile.date_of_birth", valueType: "date" });

  assert.deepEqual(
    evaluateAssessmentFieldAnswer({
      field: residency,
      semanticState: "provided",
      valueType: "enum",
      value: { type: "enum", value: "hk_permanent_resident" },
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateAssessmentFieldAnswer({
      field: residency,
      semanticState: "provided",
      valueType: "enum",
      value: { type: "enum", value: "invented" },
    }),
    { allowed: false, code: "ANSWER_ENUM_VALUE_NOT_ALLOWED" },
  );
  assert.deepEqual(
    evaluateAssessmentFieldAnswer({
      field: languages,
      semanticState: "provided",
      valueType: "enum_set",
      value: { type: "enum_set", value: ["english", "english"] },
    }),
    { allowed: false, code: "ANSWER_ENUM_SET_INVALID" },
  );
  assert.deepEqual(
    evaluateAssessmentFieldAnswer({
      field: birthDate,
      semanticState: "provided",
      valueType: "date",
      value: { type: "date", value: "2026-02-30" },
    }),
    { allowed: false, code: "ANSWER_DATE_INVALID" },
  );
  assert.deepEqual(
    evaluateAssessmentFieldAnswer({
      field: residency,
      semanticState: "declined_to_provide",
      valueType: null,
      value: null,
    }),
    { allowed: true },
  );
});

test("rejects mixed synthetic and approved catalogue modules and all non-K12 module inputs", () => {
  const synthetic = syntheticModule("base", "fixture.base.intent");
  const approved = approvedModule("education_stage", "k12-education-profile", "education_profile.current_stage");
  assert.throws(
    () => composeK12Manifest([
      synthetic,
      approved,
      approvedModule("school_system", "k12-school-preferences", "school_preferences.target_stage"),
      approvedModule("admission_route", "k12-family-context", "family_context.education_priority"),
    ]),
    hasCode("K12_CATALOGUE_MODE_MISMATCH"),
  );
  const malformedApproved = {
    ...approvedModule("base", "k12-student-profile", "student_profile.date_of_birth"),
    productionEnabled: false,
  };
  assert.throws(
    () => composeK12Manifest([
      malformedApproved,
      approved,
      approvedModule("school_system", "k12-school-preferences", "school_preferences.target_stage"),
      approvedModule("admission_route", "k12-family-context", "family_context.education_priority"),
    ]),
    hasCode("INVALID_K12_MODULE"),
  );
  assert.throws(
    () => parseK12Module({ ...approved, applicationType: "university" }),
    hasCode("INVALID_K12_MODULE"),
  );
});

function approvedModule(
  layer: "base" | "education_stage" | "school_system" | "admission_route",
  moduleId: string,
  fieldId: string,
) {
  return parseK12Module({
    applicationType: "k12",
    layer,
    moduleId,
    version: "1.0.0",
    catalogueStatus: "approved",
    productionEnabled: true,
    fields: [approvedField({ fieldId, valueType: "enum", enumValues: ["one"] })],
    blockers: {
      background_collection: [fieldId],
      school_selection_confirmed: [fieldId],
    },
  });
}

function syntheticModule(
  layer: "base" | "education_stage" | "school_system" | "admission_route",
  fieldId: string,
) {
  return parseK12Module({
    applicationType: "k12",
    layer,
    moduleId: "synthetic",
    version: "1.0.0",
    catalogueStatus: "synthetic_candidate",
    productionEnabled: false,
    fields: [{ fieldId, valueType: "text", visibility: "case", blockingStages: [] }],
  });
}

function approvedField(input: {
  readonly fieldId: string;
  readonly valueType: "date" | "enum" | "enum_set";
  readonly enumValues?: readonly string[];
}) {
  return {
    fieldId: input.fieldId,
    label: input.fieldId,
    valueType: input.valueType,
    ...(input.enumValues ? { enumValues: input.enumValues } : {}),
    visibility: "advisor",
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof CaseContractError && error.code === code;
}
