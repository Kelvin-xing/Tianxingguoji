import { readFile } from "node:fs/promises";

import {
  composeK12Manifest,
  parseK12Module,
  type K12Module,
} from "../../modules/cases/public.ts";
import { sha256SchoolValue } from "../../modules/schools/public.ts";

export const NEON_TEST_SEED_VERSION = "env01-neon-release1-v1";
export const NEON_TEST_MANIFEST_ID = "51000000-0000-4000-8000-000000000901";
export const NEON_TEST_MANIFEST_COMPOSITION_VERSION = "env01-neon-release1-v1";
export const NEON_TEST_SCHOOL_SNAPSHOT_ID = "51000000-0000-4000-8000-000000000902";
export const NEON_TEST_SCHOOL_SOURCE_RELEASE_ID = "env01-synthetic-schools-v1";
export const NEON_TEST_TASK_POLICY_ID = "51000000-0000-4000-8000-000000000903";

const MODULE_FILES = Object.freeze([
  "schema/k12/student-profile.v1.json",
  "schema/k12/education-profile.v1.json",
  "schema/k12/school-preferences.v1.json",
  "schema/k12/family-context.v1.json",
]);

export const NEON_TEST_ORGANIZATION = Object.freeze({
  id: "51000000-0000-4000-8000-000000000001",
  displayName: "Tianxing Vercel Test Synthetic",
  status: "active" as const,
});

export const NEON_TEST_PRINCIPALS = Object.freeze([
  principal("founder", "101", "201", "301"),
  principal("admin", "102", "202", "302"),
  principal("advisor", "103", "203", "303"),
  principal("data_reviewer", "104", "204", "304"),
  principal("contractor", "105", "205", "305"),
]);

export const NEON_TEST_STUDENTS = Object.freeze([
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000601",
    displayName: "ENV01 Synthetic Student One",
    dateOfBirth: "2014-03-12",
    contactEmail: "student-one@env01.test.invalid",
    contactPhone: null,
    guardianId: "51000000-0000-4000-8000-000000000701",
    guardianName: "ENV01 Synthetic Guardian One",
    guardianEmail: "guardian-one@env01.test.invalid",
    guardianPhone: null,
    relationshipId: "51000000-0000-4000-8000-000000000801",
    relationshipType: "parent",
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000602",
    displayName: "ENV01 Synthetic Student Two",
    dateOfBirth: "2012-09-21",
    contactEmail: null,
    contactPhone: null,
    guardianId: "51000000-0000-4000-8000-000000000702",
    guardianName: "ENV01 Synthetic Guardian Two",
    guardianEmail: "guardian-two@env01.test.invalid",
    guardianPhone: null,
    relationshipId: "51000000-0000-4000-8000-000000000802",
    relationshipType: "parent",
  }),
]);

export const NEON_TEST_SCHOOLS = Object.freeze([
  school(
    "51000000-0000-4000-8000-000000000401",
    "51000000-0000-4000-8000-000000000501",
    "env01-synthetic-school-001",
    "ENV01 Synthetic School One",
    "Central",
  ),
  school(
    "51000000-0000-4000-8000-000000000402",
    "51000000-0000-4000-8000-000000000502",
    "env01-synthetic-school-002",
    "ENV01 Synthetic School Two",
    "Eastern",
  ),
  school(
    "51000000-0000-4000-8000-000000000403",
    "51000000-0000-4000-8000-000000000503",
    "env01-synthetic-school-003",
    "ENV01 Synthetic School Three",
    "Kowloon",
  ),
]);

export type NeonTestManifestFixture = Readonly<{
  modules: readonly K12Module[];
  contentSha256: string;
  fields: readonly Readonly<{
    moduleLayer: string;
    moduleId: string;
    moduleVersion: string;
    fieldId: string;
    valueType: string;
    visibility: string;
    blockingStages: readonly string[];
  }>[];
  modulesByLayer: ReadonlyMap<string, K12Module>;
}>;

export async function loadNeonTestManifestFixture(): Promise<NeonTestManifestFixture> {
  const modules = await Promise.all(
    MODULE_FILES.map(async (path) => {
      const k12Module = parseK12Module(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (k12Module.catalogueStatus !== "approved" || k12Module.productionEnabled !== true) {
        throw new Error(`Approved K12 module required: ${path}`);
      }
      return k12Module;
    }),
  );
  const composition = composeK12Manifest(modules);
  if (composition.fields.length !== 15) {
    throw new Error("ENV01 synthetic manifest must contain exactly 15 fields.");
  }
  const fields = modules.flatMap((module) =>
    module.fields.map((field) =>
      Object.freeze({
        moduleLayer: module.layer,
        moduleId: module.moduleId,
        moduleVersion: module.version,
        fieldId: field.fieldId,
        valueType: field.valueType,
        visibility: field.visibility,
        blockingStages: Object.freeze(field.blockingStages.map(toStoredBlockerStage)),
      }),
    ),
  );
  return Object.freeze({
    modules: Object.freeze(modules),
    contentSha256: composition.contentSha256,
    fields: Object.freeze(fields),
    modulesByLayer: new Map(modules.map((module) => [module.layer, module])),
  });
}

export function neonTestSchoolSnapshotManifestSha256(): string {
  return sha256SchoolValue({
    sourceReleaseId: NEON_TEST_SCHOOL_SOURCE_RELEASE_ID,
    schools: NEON_TEST_SCHOOLS.map(({ id, sourceSchoolKey, recordSha256 }) => ({
      id,
      sourceSchoolKey,
      recordSha256,
    })),
  });
}

function principal(
  role: "founder" | "admin" | "advisor" | "data_reviewer" | "contractor",
  userSuffix: string,
  membershipSuffix: string,
  bindingSuffix: string,
) {
  return Object.freeze({
    role,
    userId: `51000000-0000-4000-8000-000000000${userSuffix}`,
    membershipId: `51000000-0000-4000-8000-000000000${membershipSuffix}`,
    roleBindingId: `51000000-0000-4000-8000-000000000${bindingSuffix}`,
    email: `${role.replaceAll("_", "-")}@env01.test.invalid`,
  });
}

function school(
  id: string,
  recordId: string,
  sourceSchoolKey: string,
  displayName: string,
  district: string,
) {
  const fields = Object.freeze({
    school_key: sourceSchoolKey,
    school_name_en: displayName,
    district,
    official_website: `https://${sourceSchoolKey}.invalid`,
  });
  const provenance = Object.freeze(
    Object.fromEntries(
      Object.keys(fields).map((fieldName) => [
        fieldName,
        Object.freeze({
          source_kind: "synthetic_seed",
          source_release_id: NEON_TEST_SCHOOL_SOURCE_RELEASE_ID,
        }),
      ]),
    ),
  );
  return Object.freeze({
    id,
    recordId,
    sourceSchoolKey,
    fields,
    provenance,
    recordSha256: sha256SchoolValue({ sourceSchoolKey, fields, provenance }),
  });
}

function toStoredBlockerStage(stage: string): string {
  if (stage === "background_collection") return "background_complete";
  if (stage === "school_selection_confirmed") return "selection_ready";
  throw new Error(`Unsupported K12 blocker stage: ${stage}`);
}
