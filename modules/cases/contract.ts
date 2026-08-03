import { createHash } from "node:crypto";

export const K12_MODULE_LAYERS = Object.freeze([
  "base",
  "education_stage",
  "school_system",
  "admission_route",
] as const);

export type K12ModuleLayer = (typeof K12_MODULE_LAYERS)[number];

export interface K12ModuleField {
  readonly fieldId: string;
  readonly valueType: string;
  readonly visibility: string;
  readonly blockingStages: readonly string[];
}

export interface K12Module {
  readonly applicationType: "k12";
  readonly layer: K12ModuleLayer;
  readonly moduleId: string;
  readonly version: string;
  readonly catalogueStatus: "synthetic_candidate";
  readonly productionEnabled: false;
  readonly fields: readonly K12ModuleField[];
}

export type K12ManifestModule = K12Module;

export interface K12ManifestComposition {
  readonly applicationType: "k12";
  readonly compositionVersion: "k12-structural-v1";
  readonly modules: readonly K12ManifestModule[];
  readonly fields: readonly K12ModuleField[];
  readonly contentSha256: string;
  readonly productionEnabled: false;
}

export type ServiceCaseStage =
  | "signed"
  | "background_collection"
  | "school_selection_confirmed"
  | "interview_preparation"
  | "application_submitted"
  | "awaiting_result"
  | "offer_confirmed"
  | "closed";

export interface ServiceCaseCreationInput {
  readonly applicationType: string;
  readonly organizationId: string;
  readonly studentOrganizationId: string;
  readonly studentStatus: "active" | "pending_delete" | "purged";
  readonly primaryRole: "founder" | "admin" | "advisor" | "data_reviewer" | "contractor";
  readonly primaryOrganizationId: string;
  readonly primaryBindingStatus: "active" | "revoked";
  readonly manifestStatus: "candidate" | "approved" | "retired";
  readonly initialStage: ServiceCaseStage;
}

export type CaseDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string };

export type AnswerSemanticState =
  | "provided"
  | "unknown"
  | "not_applicable"
  | "declined_to_provide";

export interface AssessmentAnswerInput {
  readonly semanticState: AnswerSemanticState;
  readonly value: unknown;
  readonly valueType: string | null;
  readonly manifestValueType: string;
}

export type AssessmentStatus = "draft" | "background_complete" | "selection_ready";

export interface AssessmentStatusInput {
  readonly manifestStatus: "candidate" | "approved" | "retired";
  readonly targetStatus: AssessmentStatus;
  readonly requiredBlockingFieldIds: readonly string[];
  readonly satisfiedBlockingFieldIds: readonly string[];
}

export type SchoolTargetState =
  | "candidate"
  | "preparing"
  | "submitted"
  | "interview"
  | "waitlisted"
  | "accepted"
  | "rejected"
  | "withdrawn";

export type CaseOutcomeCode =
  | "waitlisted"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "not_submitted"
  | "aborted";

export interface SchoolTargetCreationInput {
  readonly initialState: SchoolTargetState;
}

export interface SchoolTargetTransitionInput {
  readonly from: SchoolTargetState;
  readonly to: SchoolTargetState;
  readonly routePolicyApproved: boolean;
}

export interface TargetOutcomeInput {
  readonly targetState: SchoolTargetState;
  readonly currentOutcomeCode: CaseOutcomeCode | null;
}

export class CaseContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaseContractError";
    this.code = code;
  }
}

export function parseK12Module(value: unknown): K12Module {
  if (!isRecord(value)) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 module must be an object.");
  }

  if (
    value.applicationType !== "k12" ||
    typeof value.layer !== "string" ||
    !isK12ModuleLayer(value.layer) ||
    typeof value.moduleId !== "string" ||
    value.moduleId.trim().length === 0 ||
    typeof value.version !== "string" ||
    value.version.trim().length === 0 ||
    value.catalogueStatus !== "synthetic_candidate" ||
    value.productionEnabled !== false ||
    !Array.isArray(value.fields)
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 module metadata is invalid.");
  }

  const fields = value.fields.map(parseK12ModuleField);
  const fieldIds = new Set<string>();
  for (const field of fields) {
    if (fieldIds.has(field.fieldId)) {
      throw new CaseContractError("K12_FIELD_ID_DUPLICATE", field.fieldId);
    }
    fieldIds.add(field.fieldId);
  }

  return Object.freeze({
    applicationType: "k12",
    layer: value.layer,
    moduleId: value.moduleId,
    version: value.version,
    catalogueStatus: "synthetic_candidate",
    productionEnabled: false,
    fields: Object.freeze(fields),
  });
}

export function composeK12Manifest(
  modules: readonly K12Module[],
): K12ManifestComposition {
  const sortedModules = [...modules].sort((left, right) =>
    left.layer.localeCompare(right.layer),
  );
  const layers = new Set(sortedModules.map(({ layer }) => layer));

  if (
    sortedModules.length !== K12_MODULE_LAYERS.length ||
    layers.size !== K12_MODULE_LAYERS.length ||
    K12_MODULE_LAYERS.some((layer) => !layers.has(layer))
  ) {
    throw new CaseContractError(
      "K12_MODULE_SET_INCOMPLETE",
      "Exactly one module for each K12 layer is required.",
    );
  }

  const immutableModules = sortedModules.map((module) =>
    Object.freeze({
      ...module,
      fields: Object.freeze(
        module.fields.map((field) =>
          Object.freeze({
            ...field,
            blockingStages: Object.freeze([...field.blockingStages]),
          }),
        ),
      ),
    }),
  );
  const fields = immutableModules.flatMap(({ fields: moduleFields }) => moduleFields);
  const fieldIds = new Set<string>();
  for (const field of fields) {
    if (fieldIds.has(field.fieldId)) {
      throw new CaseContractError("K12_FIELD_ID_DUPLICATE", field.fieldId);
    }
    fieldIds.add(field.fieldId);
  }

  const modulesForHash = immutableModules.map((module) => ({
    applicationType: module.applicationType,
    catalogueStatus: module.catalogueStatus,
    fields: module.fields,
    layer: module.layer,
    moduleId: module.moduleId,
    productionEnabled: module.productionEnabled,
    version: module.version,
  }));
  const canonicalContent = canonicalize({
    applicationType: "k12",
    compositionVersion: "k12-structural-v1",
    modules: modulesForHash,
  });

  return Object.freeze({
    applicationType: "k12",
    compositionVersion: "k12-structural-v1",
    modules: Object.freeze(immutableModules),
    fields: Object.freeze(fields),
    contentSha256: createHash("sha256").update(canonicalContent).digest("hex"),
    productionEnabled: false,
  });
}

export function evaluateServiceCaseCreation(
  input: ServiceCaseCreationInput,
): CaseDecision {
  if (input.applicationType !== "k12") {
    return { allowed: false, code: "NON_K12_APPLICATION" };
  }
  if (
    input.organizationId !== input.studentOrganizationId ||
    input.organizationId !== input.primaryOrganizationId
  ) {
    return { allowed: false, code: "TENANT_CONTEXT_MISMATCH" };
  }
  if (input.studentStatus !== "active") {
    return { allowed: false, code: "STUDENT_NOT_ACTIVE" };
  }
  if (input.primaryRole !== "founder" && input.primaryRole !== "advisor") {
    return { allowed: false, code: "PRIMARY_ROLE_NOT_ALLOWED" };
  }
  if (input.primaryBindingStatus !== "active") {
    return { allowed: false, code: "PRIMARY_BINDING_INACTIVE" };
  }
  if (input.manifestStatus !== "approved") {
    return { allowed: false, code: "MANIFEST_NOT_APPROVED" };
  }
  if (input.initialStage !== "signed") {
    return { allowed: false, code: "INVALID_INITIAL_STAGE" };
  }

  return { allowed: true };
}

export function evaluateAssessmentAnswer(
  input: AssessmentAnswerInput,
): CaseDecision {
  if (input.semanticState === "provided") {
    if (input.value === null) {
      return { allowed: false, code: "ANSWER_VALUE_REQUIRED" };
    }
    if (input.valueType === null) {
      return { allowed: false, code: "ANSWER_VALUE_TYPE_REQUIRED" };
    }
    if (input.valueType !== input.manifestValueType) {
      return { allowed: false, code: "ANSWER_VALUE_TYPE_MISMATCH" };
    }
    return { allowed: true };
  }

  if (input.value !== null || input.valueType !== null) {
    return { allowed: false, code: "ANSWER_VALUE_FORBIDDEN" };
  }

  return { allowed: true };
}

export function evaluateAssessmentStatus(input: AssessmentStatusInput): CaseDecision {
  if (input.manifestStatus !== "approved") {
    return { allowed: false, code: "MANIFEST_NOT_APPROVED" };
  }
  if (input.targetStatus === "draft") {
    return { allowed: true };
  }

  const satisfied = new Set(input.satisfiedBlockingFieldIds);
  if (input.requiredBlockingFieldIds.some((fieldId) => !satisfied.has(fieldId))) {
    return { allowed: false, code: "ASSESSMENT_BLOCKERS_INCOMPLETE" };
  }

  return { allowed: true };
}

export function evaluateSchoolTargetCreation(
  input: SchoolTargetCreationInput,
): CaseDecision {
  return input.initialState === "candidate"
    ? { allowed: true }
    : { allowed: false, code: "INVALID_INITIAL_TARGET_STATE" };
}

export function evaluateSchoolTargetTransition(
  _input: SchoolTargetTransitionInput,
): CaseDecision {
  return { allowed: false, code: "TARGET_ROUTE_POLICY_REQUIRED" };
}

export function evaluateTargetOutcome(input: TargetOutcomeInput): CaseDecision {
  const terminalStates = new Set<SchoolTargetState>([
    "waitlisted",
    "accepted",
    "rejected",
    "withdrawn",
  ]);

  if (!terminalStates.has(input.targetState)) {
    return input.currentOutcomeCode === null
      ? { allowed: true }
      : { allowed: false, code: "OUTCOME_NOT_ALLOWED" };
  }
  if (input.currentOutcomeCode === null) {
    return { allowed: false, code: "TARGET_OUTCOME_REQUIRED" };
  }
  if (input.currentOutcomeCode !== input.targetState) {
    return { allowed: false, code: "TARGET_OUTCOME_MISMATCH" };
  }

  return { allowed: true };
}

function parseK12ModuleField(value: unknown): K12ModuleField {
  if (!isRecord(value)) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 field must be an object.");
  }

  if (
    typeof value.fieldId !== "string" ||
    value.fieldId.trim().length === 0 ||
    typeof value.valueType !== "string" ||
    value.valueType.trim().length === 0 ||
    typeof value.visibility !== "string" ||
    value.visibility.trim().length === 0 ||
    !Array.isArray(value.blockingStages) ||
    value.blockingStages.some((stage) => typeof stage !== "string" || stage.trim().length === 0)
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 field metadata is invalid.");
  }

  return Object.freeze({
    fieldId: value.fieldId,
    valueType: value.valueType,
    visibility: value.visibility,
    blockingStages: Object.freeze([...value.blockingStages]),
  });
}

function isK12ModuleLayer(value: string): value is K12ModuleLayer {
  return (K12_MODULE_LAYERS as readonly string[]).includes(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
