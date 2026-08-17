import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BackfillPreview } from "../../modules/operations/public.ts";

export type { BackfillPreview } from "../../modules/operations/public.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BackfillSourceRow = {
  sourceRecordReference: string;
  sourceEntity: string;
  fields: Readonly<Record<string, JsonValue>>;
};

export type BackfillMapping = {
  mappingVersion: string;
  sourceEntity: string;
  targetEntity: string;
  fields: readonly {
    sourceField: string;
    targetField: string;
    disposition: "map" | "ignore";
  }[];
  requiredTargetFields: readonly string[];
};

export type BackfillPreviewInput = {
  sourceSnapshot: {
    sourceKind: "synthetic";
    sourceVersion: string;
    rows: readonly BackfillSourceRow[];
  };
  mapping: BackfillMapping;
  schemaVersion: string;
};

type BackfillRejection =
  | {
      sourceRecordReference: string;
      code: "SOURCE_FIELD_UNMAPPED";
      fields: string[];
    }
  | {
      sourceRecordReference: string;
      code: "SOURCE_ENTITY_MISMATCH";
      fields: [];
    }
  | {
      sourceRecordReference: string;
      code: "REQUIRED_TARGET_FIELD_MISSING";
      fields: string[];
    };

export class BackfillPreviewContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BackfillPreviewContractError";
    this.code = code;
  }
}

function requireNonEmpty(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BackfillPreviewContractError(code);
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSourceRows(rows: readonly BackfillSourceRow[]): BackfillSourceRow[] {
  const references = new Set<string>();
  return rows
    .map((row) => {
      requireNonEmpty(row.sourceRecordReference, "SOURCE_RECORD_REFERENCE_REQUIRED");
      requireNonEmpty(row.sourceEntity, "SOURCE_ENTITY_REQUIRED");
      if (references.has(row.sourceRecordReference)) {
        throw new BackfillPreviewContractError("SOURCE_RECORD_REFERENCE_DUPLICATE");
      }
      references.add(row.sourceRecordReference);
      if (row.fields === null || Array.isArray(row.fields) || typeof row.fields !== "object") {
        throw new BackfillPreviewContractError("SOURCE_FIELDS_INVALID");
      }
      return {
        sourceRecordReference: row.sourceRecordReference,
        sourceEntity: row.sourceEntity,
        fields: Object.fromEntries(
          Object.entries(row.fields).sort(([left], [right]) => compareStableStrings(left, right)),
        ),
      };
    })
    .sort((left, right) => compareStableStrings(left.sourceRecordReference, right.sourceRecordReference));
}

function normalizeMapping(mapping: BackfillMapping): BackfillMapping {
  requireNonEmpty(mapping.mappingVersion, "MAPPING_VERSION_REQUIRED");
  requireNonEmpty(mapping.sourceEntity, "MAPPING_SOURCE_ENTITY_REQUIRED");
  requireNonEmpty(mapping.targetEntity, "MAPPING_TARGET_ENTITY_REQUIRED");

  const sourceFields = new Set<string>();
  const targetFields = new Set<string>();
  const fields = mapping.fields
    .map((field) => {
      requireNonEmpty(field.sourceField, "MAPPING_SOURCE_FIELD_REQUIRED");
      requireNonEmpty(field.targetField, "MAPPING_TARGET_FIELD_REQUIRED");
      if (field.disposition !== "map" && field.disposition !== "ignore") {
        throw new BackfillPreviewContractError("MAPPING_DISPOSITION_INVALID");
      }
      if (sourceFields.has(field.sourceField)) {
        throw new BackfillPreviewContractError("MAPPING_SOURCE_FIELD_DUPLICATE");
      }
      sourceFields.add(field.sourceField);
      if (field.disposition === "map") {
        if (targetFields.has(field.targetField)) {
          throw new BackfillPreviewContractError("MAPPING_TARGET_FIELD_DUPLICATE");
        }
        targetFields.add(field.targetField);
      }
      return { ...field };
    })
    .sort((left, right) => compareStableStrings(left.sourceField, right.sourceField));

  const requiredTargetFields = [...mapping.requiredTargetFields].sort();
  if (new Set(requiredTargetFields).size !== requiredTargetFields.length) {
    throw new BackfillPreviewContractError("MAPPING_REQUIRED_TARGET_FIELD_DUPLICATE");
  }
  if (requiredTargetFields.some((field) => !targetFields.has(field))) {
    throw new BackfillPreviewContractError("MAPPING_REQUIRED_TARGET_UNMAPPED");
  }
  return { ...mapping, fields, requiredTargetFields };
}

export function createBackfillPreview(input: BackfillPreviewInput): BackfillPreview {
  if (input?.sourceSnapshot?.sourceKind !== "synthetic") {
    throw new BackfillPreviewContractError("BACKFILL_SOURCE_NOT_SYNTHETIC");
  }
  requireNonEmpty(input.sourceSnapshot.sourceVersion, "SOURCE_VERSION_REQUIRED");
  requireNonEmpty(input.schemaVersion, "SCHEMA_VERSION_REQUIRED");
  if (!Array.isArray(input.sourceSnapshot.rows)) {
    throw new BackfillPreviewContractError("SOURCE_ROWS_INVALID");
  }

  const rows = normalizeSourceRows(input.sourceSnapshot.rows);
  const mapping = normalizeMapping(input.mapping);
  const mappingBySource = new Map(mapping.fields.map((field) => [field.sourceField, field]));
  const acceptedTargets: JsonValue[] = [];
  const rejections: BackfillRejection[] = [];

  for (const row of rows) {
    if (row.sourceEntity !== mapping.sourceEntity) {
      rejections.push({
        sourceRecordReference: row.sourceRecordReference,
        code: "SOURCE_ENTITY_MISMATCH",
        fields: [],
      });
      continue;
    }
    const unmappedFields = Object.keys(row.fields).filter((field) => !mappingBySource.has(field));
    if (unmappedFields.length > 0) {
      rejections.push({
        sourceRecordReference: row.sourceRecordReference,
        code: "SOURCE_FIELD_UNMAPPED",
        fields: unmappedFields.sort(),
      });
      continue;
    }

    const targetFields: Record<string, JsonValue> = {};
    for (const field of mapping.fields) {
      if (field.disposition === "map" && Object.hasOwn(row.fields, field.sourceField)) {
        targetFields[field.targetField] = row.fields[field.sourceField];
      }
    }
    const missingFields = mapping.requiredTargetFields.filter((field) => !Object.hasOwn(targetFields, field));
    if (missingFields.length > 0) {
      rejections.push({
        sourceRecordReference: row.sourceRecordReference,
        code: "REQUIRED_TARGET_FIELD_MISSING",
        fields: missingFields,
      });
      continue;
    }
    acceptedTargets.push({
      sourceRecordReference: row.sourceRecordReference,
      targetEntity: mapping.targetEntity,
      fields: targetFields,
    });
  }

  const counts = {
    source: rows.length,
    accepted: acceptedTargets.length,
    rejected: rejections.length,
    target: acceptedTargets.length,
  };
  const unexplainedDifference = counts.source - counts.accepted - counts.rejected;
  const resumeKey = `backfill:${sha256({
    sourceVersion: input.sourceSnapshot.sourceVersion,
    mappingVersion: mapping.mappingVersion,
    schemaVersion: input.schemaVersion,
  })}`;
  const hashesWithoutReport = {
    sourceSha256: sha256(rows as unknown as JsonValue),
    mappingSha256: sha256(mapping as unknown as JsonValue),
    acceptedTargetSha256: sha256(acceptedTargets),
  };
  const reportBody = {
    reportVersion: 1 as const,
    source: { kind: "synthetic" as const, version: input.sourceSnapshot.sourceVersion },
    mapping: {
      version: mapping.mappingVersion,
      sourceEntity: mapping.sourceEntity,
      targetEntity: mapping.targetEntity,
    },
    schemaVersion: input.schemaVersion,
    execution: {
      mode: "preview_only" as const,
      sourceWrites: "forbidden" as const,
      targetWrites: "forbidden" as const,
    },
    counts,
    rejections,
    reconciliation: {
      status: (rejections.length === 0 && unexplainedDifference === 0
        ? "reconciled"
        : "needs_human") as "reconciled" | "needs_human",
      unexplainedDifference,
    },
    resumeKey,
    hashes: hashesWithoutReport,
  };
  return {
    ...reportBody,
    hashes: {
      ...hashesWithoutReport,
      reportSha256: sha256(reportBody as unknown as JsonValue),
    },
  };
}

async function runCli(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    throw new BackfillPreviewContractError("BACKFILL_INPUT_REQUIRED");
  }
  const raw = await readFile(resolve(process.argv[3]), "utf8");
  const input = JSON.parse(raw) as BackfillPreviewInput;
  process.stdout.write(`${JSON.stringify(createBackfillPreview(input))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error: unknown) => {
    const code = error instanceof BackfillPreviewContractError ? error.code : "BACKFILL_INPUT_INVALID";
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  });
}
