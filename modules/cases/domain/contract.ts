import { createHash } from "node:crypto";

const SAFE_FIELD_ENUM = /^[a-z][a-z0-9_]{0,63}$/;

export const K12_MODULE_LAYERS = Object.freeze([
  "base",
  "education_stage",
  "school_system",
  "admission_route",
] as const);

export type K12ModuleLayer = (typeof K12_MODULE_LAYERS)[number];

export const K12_CATALOGUE_BLOCKER_STAGES = Object.freeze([
  "background_collection",
  "school_selection_confirmed",
] as const);

export type K12CatalogueBlockerStage = (typeof K12_CATALOGUE_BLOCKER_STAGES)[number];
export type K12FieldValueType = "text" | "date" | "integer" | "enum" | "enum_set";
export type K12ModuleCatalogueStatus = "synthetic_candidate" | "approved";
export type K12CompositionVersion = "k12-structural-v1" | "k12-catalogue-v1";

export interface K12ModuleBlockers {
  readonly background_collection: readonly string[];
  readonly school_selection_confirmed: readonly string[];
}

export interface K12ModuleField {
  readonly fieldId: string;
  readonly label?: string;
  readonly valueType: K12FieldValueType;
  readonly enumValues?: readonly string[];
  readonly visibility: string;
  readonly blockingStages: readonly string[];
}

export interface K12Module {
  readonly applicationType: "k12";
  readonly layer: K12ModuleLayer;
  readonly moduleId: string;
  readonly version: string;
  readonly catalogueStatus: K12ModuleCatalogueStatus;
  readonly productionEnabled: boolean;
  readonly fields: readonly K12ModuleField[];
  readonly blockers?: K12ModuleBlockers;
}

export type K12ManifestModule = K12Module;

export interface K12ManifestComposition {
  readonly applicationType: "k12";
  readonly compositionVersion: K12CompositionVersion;
  readonly modules: readonly K12ManifestModule[];
  readonly fields: readonly K12ModuleField[];
  readonly contentSha256: string;
  readonly productionEnabled: boolean;
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

  const isSyntheticCandidate = value.catalogueStatus === "synthetic_candidate" && value.productionEnabled === false;
  const isApprovedCatalogue = value.catalogueStatus === "approved" && value.productionEnabled === true;
  if (
    value.applicationType !== "k12" ||
    typeof value.layer !== "string" ||
    !isK12ModuleLayer(value.layer) ||
    typeof value.moduleId !== "string" ||
    value.moduleId.trim().length === 0 ||
    typeof value.version !== "string" ||
    value.version.trim().length === 0 ||
    (!isSyntheticCandidate && !isApprovedCatalogue) ||
    !Array.isArray(value.fields)
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 module metadata is invalid.");
  }

  const parsedFields = value.fields.map((field) => parseK12ModuleField(field, isApprovedCatalogue));
  const blockers = isApprovedCatalogue
    ? parseK12ModuleBlockers(value.blockers, parsedFields)
    : undefined;
  const fields = isApprovedCatalogue
    ? applyCatalogueBlockers(parsedFields, blockers!)
    : parsedFields;
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
    catalogueStatus: isApprovedCatalogue ? "approved" : "synthetic_candidate",
    productionEnabled: isApprovedCatalogue,
    fields: Object.freeze(fields),
    ...(blockers ? { blockers } : {}),
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

  const catalogueModes = new Set(
    sortedModules.map(({ catalogueStatus, productionEnabled }) => `${catalogueStatus}:${productionEnabled}`),
  );
  if (
    sortedModules.some(
      (module) =>
        (module.catalogueStatus === "approved") !== module.productionEnabled,
    )
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 module mode is invalid.");
  }
  if (catalogueModes.size !== 1) {
    throw new CaseContractError(
      "K12_CATALOGUE_MODE_MISMATCH",
      "Synthetic and approved K12 modules cannot be composed together.",
    );
  }
  const approvedCatalogue = sortedModules[0]?.catalogueStatus === "approved";
  if (approvedCatalogue && sortedModules.some((module) => !module.blockers)) {
    throw new CaseContractError("INVALID_K12_MODULE", "Approved modules require blocker declarations.");
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
      ...(module.blockers
        ? {
          blockers: Object.freeze({
            background_collection: Object.freeze([...module.blockers.background_collection]),
            school_selection_confirmed: Object.freeze([...module.blockers.school_selection_confirmed]),
          }),
        }
        : {}),
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
    ...(module.blockers ? { blockers: module.blockers } : {}),
  }));
  const compositionVersion: K12CompositionVersion = approvedCatalogue
    ? "k12-catalogue-v1"
    : "k12-structural-v1";
  const canonicalContent = canonicalize({
    applicationType: "k12",
    compositionVersion,
    modules: modulesForHash,
  });

  return Object.freeze({
    applicationType: "k12",
    compositionVersion,
    modules: Object.freeze(immutableModules),
    fields: Object.freeze(fields),
    contentSha256: createHash("sha256").update(canonicalContent).digest("hex"),
    productionEnabled: approvedCatalogue,
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

/** Applies the field contract after preserving the P0-07 semantic-state gate. */
export function evaluateAssessmentFieldAnswer(input: {
  readonly field: Pick<K12ModuleField, "valueType" | "enumValues">;
  readonly semanticState: AnswerSemanticState;
  readonly value: unknown;
  readonly valueType: string | null;
}): CaseDecision {
  const semanticDecision = evaluateAssessmentAnswer({
    semanticState: input.semanticState,
    value: input.value,
    valueType: input.valueType,
    manifestValueType: input.field.valueType,
  });
  if (!semanticDecision.allowed || input.semanticState !== "provided") return semanticDecision;

  if (!isTypedAnswerValue(input.value, input.valueType)) {
    return { allowed: false, code: "ANSWER_VALUE_SHAPE_INVALID" };
  }

  switch (input.field.valueType) {
    case "text":
      return typeof input.value.value === "string" && input.value.value.trim().length > 0
        ? { allowed: true }
        : { allowed: false, code: "ANSWER_TEXT_INVALID" };
    case "date":
      return isIsoCalendarDate(input.value.value)
        ? { allowed: true }
        : { allowed: false, code: "ANSWER_DATE_INVALID" };
    case "integer":
      return typeof input.value.value === "number" && Number.isSafeInteger(input.value.value)
        ? { allowed: true }
        : { allowed: false, code: "ANSWER_INTEGER_INVALID" };
    case "enum":
      return typeof input.value.value === "string" && input.field.enumValues?.includes(input.value.value)
        ? { allowed: true }
        : { allowed: false, code: "ANSWER_ENUM_VALUE_NOT_ALLOWED" };
    case "enum_set":
      return isValidEnumSet(input.value.value, input.field.enumValues)
        ? { allowed: true }
        : { allowed: false, code: "ANSWER_ENUM_SET_INVALID" };
  }
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

function parseK12ModuleField(value: unknown, approvedCatalogue: boolean): K12ModuleField {
  if (!isRecord(value)) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 field must be an object.");
  }

  const blockingStages = approvedCatalogue ? [] : value.blockingStages;
  if (
    typeof value.fieldId !== "string" ||
    value.fieldId.trim().length === 0 ||
    (value.label !== undefined && (typeof value.label !== "string" || value.label.trim().length === 0)) ||
    typeof value.valueType !== "string" ||
    !isK12FieldValueType(value.valueType) ||
    typeof value.visibility !== "string" ||
    value.visibility.trim().length === 0 ||
    (approvedCatalogue &&
      (typeof value.label !== "string" || value.label.trim().length === 0 || value.visibility !== "advisor")) ||
    (!approvedCatalogue &&
      (!Array.isArray(blockingStages) ||
        blockingStages.some((stage) => typeof stage !== "string" || stage.trim().length === 0))) ||
    (approvedCatalogue && value.blockingStages !== undefined)
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 field metadata is invalid.");
  }

  const enumValues = parseEnumValues(value.enumValues, value.valueType);
  const validatedBlockingStages = approvedCatalogue ? [] : parseBlockingStages(blockingStages);

  return Object.freeze({
    fieldId: value.fieldId,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    valueType: value.valueType,
    ...(enumValues ? { enumValues } : {}),
    visibility: value.visibility,
    blockingStages: Object.freeze(validatedBlockingStages),
  });
}

function parseBlockingStages(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((stage) => typeof stage !== "string")) {
    throw new CaseContractError("INVALID_K12_MODULE", "K12 blocking stages are invalid.");
  }
  return value;
}

function parseK12ModuleBlockers(
  value: unknown,
  fields: readonly K12ModuleField[],
): K12ModuleBlockers {
  if (!isRecord(value)) {
    throw new CaseContractError("INVALID_K12_MODULE", "Approved module blockers are required.");
  }
  const fieldIds = new Set(fields.map(({ fieldId }) => fieldId));
  const blockers = {} as Record<K12CatalogueBlockerStage, readonly string[]>;
  for (const stage of K12_CATALOGUE_BLOCKER_STAGES) {
    const fieldList = value[stage];
    if (
      !Array.isArray(fieldList) ||
      fieldList.some((fieldId) => typeof fieldId !== "string" || !fieldIds.has(fieldId)) ||
      new Set(fieldList).size !== fieldList.length
    ) {
      throw new CaseContractError("INVALID_K12_MODULE", `Invalid ${stage} blockers.`);
    }
    blockers[stage] = Object.freeze([...fieldList]);
  }
  return Object.freeze({
    background_collection: blockers.background_collection,
    school_selection_confirmed: blockers.school_selection_confirmed,
  });
}

function applyCatalogueBlockers(
  fields: readonly K12ModuleField[],
  blockers: K12ModuleBlockers,
): readonly K12ModuleField[] {
  return fields.map((field) =>
    Object.freeze({
      ...field,
      blockingStages: Object.freeze(
        K12_CATALOGUE_BLOCKER_STAGES.filter((stage) => blockers[stage].includes(field.fieldId)),
      ),
    }),
  );
}

function parseEnumValues(value: unknown, valueType: K12FieldValueType): readonly string[] | undefined {
  const enumType = valueType === "enum" || valueType === "enum_set";
  if (!enumType && value !== undefined) {
    throw new CaseContractError("INVALID_K12_MODULE", "Only enum fields can declare enum values.");
  }
  if (!enumType) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !SAFE_FIELD_ENUM.test(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new CaseContractError("INVALID_K12_MODULE", "Enum values are invalid.");
  }
  return Object.freeze([...value]);
}

function isK12ModuleLayer(value: string): value is K12ModuleLayer {
  return (K12_MODULE_LAYERS as readonly string[]).includes(value);
}

function isK12FieldValueType(value: string): value is K12FieldValueType {
  return (["text", "date", "integer", "enum", "enum_set"] as const).includes(
    value as K12FieldValueType,
  );
}

function isTypedAnswerValue(
  value: unknown,
  expectedType: string | null,
): value is { readonly type: string; readonly value: unknown } {
  return (
    expectedType !== null &&
    isRecord(value) &&
    value.type === expectedType &&
    Object.hasOwn(value, "value")
  );
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidEnumSet(value: unknown, enumValues: readonly string[] | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && enumValues?.includes(entry)) &&
    new Set(value).size === value.length
  );
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
