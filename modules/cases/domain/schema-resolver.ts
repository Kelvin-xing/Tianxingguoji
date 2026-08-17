import {
  K12_MODULE_LAYERS,
  type K12CompositionVersion,
  type K12FieldValueType,
  type K12ManifestComposition,
  type K12ModuleLayer,
} from "./contract.ts";

export interface AssessmentSchemaField {
  readonly fieldId: string;
  readonly label?: string;
  readonly layer: K12ModuleLayer;
  readonly moduleId?: string;
  readonly moduleVersion?: string;
  readonly valueType: K12FieldValueType;
  readonly enumValues?: readonly string[];
  readonly visibility: string;
  readonly blockingStages: readonly string[];
}

export interface AssessmentSchemaView {
  readonly manifestId: string;
  readonly compositionVersion: K12CompositionVersion;
  readonly fields: readonly AssessmentSchemaField[];
}

export class AssessmentSchemaError extends Error {
  readonly code: "ASSESSMENT_SCHEMA_INVALID" | "ASSESSMENT_FIELD_NOT_FOUND";

  constructor(code: AssessmentSchemaError["code"]) {
    super(code);
    this.name = "AssessmentSchemaError";
    this.code = code;
  }
}

/**
 * This projection is the sole server/client rendering model. It reorders the
 * immutable four-layer manifest only into its declared layer order; it does
 * not add validation, visibility, or blocking rules.
 */
export function resolveAssessmentSchema(input: {
  readonly manifestId: string;
  readonly manifest: K12ManifestComposition;
}): AssessmentSchemaView {
  if (!isUuid(input.manifestId) || input.manifest.applicationType !== "k12") {
    throw new AssessmentSchemaError("ASSESSMENT_SCHEMA_INVALID");
  }

  const fields: AssessmentSchemaField[] = [];
  const fieldIds = new Set<string>();
  for (const layer of K12_MODULE_LAYERS) {
    const module = input.manifest.modules.find((candidate) => candidate.layer === layer);
    if (!module) throw new AssessmentSchemaError("ASSESSMENT_SCHEMA_INVALID");

    for (const field of module.fields) {
      if (fieldIds.has(field.fieldId)) {
        throw new AssessmentSchemaError("ASSESSMENT_SCHEMA_INVALID");
      }
      fieldIds.add(field.fieldId);
      const catalogueMetadata = module.catalogueStatus === "approved"
        ? {
          label: field.label ?? field.fieldId,
          moduleId: module.moduleId,
          moduleVersion: module.version,
          ...(field.enumValues ? { enumValues: Object.freeze([...field.enumValues]) } : {}),
        }
        : {};
      fields.push(
        Object.freeze({
          fieldId: field.fieldId,
          layer,
          valueType: field.valueType,
          visibility: field.visibility,
          blockingStages: Object.freeze([...field.blockingStages]),
          ...catalogueMetadata,
        }),
      );
    }
  }

  if (fields.length !== input.manifest.fields.length) {
    throw new AssessmentSchemaError("ASSESSMENT_SCHEMA_INVALID");
  }

  return Object.freeze({
    manifestId: input.manifestId,
    compositionVersion: input.manifest.compositionVersion,
    fields: Object.freeze(fields),
  });
}

export function getAssessmentSchemaField(
  schema: AssessmentSchemaView,
  fieldId: string,
): AssessmentSchemaField {
  const field = schema.fields.find((candidate) => candidate.fieldId === fieldId);
  if (!field) throw new AssessmentSchemaError("ASSESSMENT_FIELD_NOT_FOUND");
  return field;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
