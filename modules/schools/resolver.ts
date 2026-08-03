import {
  canonicalSchoolValue,
  SchoolContractError,
  sha256SchoolValue,
  schoolValuesEqual,
  type JsonValue,
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
  type SchoolResolutionConflict,
  type SchoolResolutionProvenance,
} from "./contract.ts";

export interface ResolvedSchoolView {
  readonly organizationId: string;
  readonly schoolId: string;
  readonly sourceSchoolKey: string;
  readonly baseSnapshotId: string;
  readonly overlayRevisionId: string | null;
  readonly overlayRevisionNumber: number | null;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly provenance: Readonly<Record<string, SchoolResolutionProvenance>>;
  readonly conflicts: readonly SchoolResolutionConflict[];
  readonly resolutionSha256: string;
}

export type OverlayReconciliation =
  | {
      readonly action: "close_override";
      readonly fields: readonly [{ readonly fieldName: string; readonly kind: "base_matches_override" }];
    }
  | {
      readonly action: "preserve_and_review";
      readonly fields: readonly SchoolResolutionConflict[];
    }
  | {
      readonly action: "retain_override";
      readonly fields: readonly [{ readonly fieldName: string; readonly kind: "override_still_applies" }];
    };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function baseValue(base: SchoolBaseRecord, fieldName: string): JsonValue | null {
  return Object.prototype.hasOwnProperty.call(base.fields, fieldName) ? base.fields[fieldName] : null;
}

function validRevision(revision: SchoolOverlayRevision): void {
  if (revision.revisionNumber < 1 || !Number.isSafeInteger(revision.revisionNumber)) {
    throw new SchoolContractError("SCHOOL_OVERLAY_REVISION_INVALID");
  }
  const fields = new Set<string>();
  for (const change of revision.changes) {
    if (fields.has(change.fieldName)) throw new SchoolContractError("SCHOOL_OVERLAY_FIELD_DUPLICATE");
    fields.add(change.fieldName);
  }
}

function activeRevision(
  base: SchoolBaseRecord,
  revisions: readonly SchoolOverlayRevision[],
): SchoolOverlayRevision | null {
  const applicable = revisions.filter(
    (revision) =>
      revision.organizationId === base.organizationId &&
      revision.schoolId === base.schoolId &&
      revision.status === "approved",
  );
  const seenNumbers = new Set<number>();
  for (const revision of applicable) {
    validRevision(revision);
    if (seenNumbers.has(revision.revisionNumber)) {
      throw new SchoolContractError("SCHOOL_OVERLAY_REVISION_DUPLICATE");
    }
    seenNumbers.add(revision.revisionNumber);
  }
  return [...applicable].sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
}

export function resolveSchoolView(
  base: SchoolBaseRecord,
  revisions: readonly SchoolOverlayRevision[],
): ResolvedSchoolView {
  const selected = activeRevision(base, revisions);
  const fields: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(base.fields).map(([fieldName, value]) => [fieldName, canonicalSchoolValue(value)]),
  );
  const provenance: Record<string, SchoolResolutionProvenance> = {};
  const conflicts: SchoolResolutionConflict[] = [];

  for (const fieldName of Object.keys(fields)) {
    provenance[fieldName] = {
      sourceKind: "crawler_snapshot",
      sourceSnapshotId: base.snapshotId,
      sourceSchoolKey: base.sourceSchoolKey,
      valueSha256: sha256SchoolValue(fields[fieldName]),
    };
  }

  if (selected) {
    for (const change of selected.changes) {
      const currentBaseValue = baseValue(base, change.fieldName);
      const currentBaseValueSha256 = sha256SchoolValue(currentBaseValue);
      const proposedValueSha256 = sha256SchoolValue(change.proposedValue);
      const baseChanged = currentBaseValueSha256 !== change.baseValueSha256;

      if (baseChanged && currentBaseValueSha256 !== proposedValueSha256) {
        conflicts.push({
          fieldName: change.fieldName,
          kind: "base_changed",
          previousBaseValueSha256: change.baseValueSha256,
          currentBaseValueSha256,
        });
      }

      fields[change.fieldName] = canonicalSchoolValue(change.proposedValue);
      provenance[change.fieldName] = {
        sourceKind: "approved_overlay",
        sourceSnapshotId: base.snapshotId,
        sourceSchoolKey: base.sourceSchoolKey,
        overlayRevisionId: selected.revisionId,
        baseValueSha256: change.baseValueSha256,
        valueSha256: proposedValueSha256,
      };
    }
  }

  const resolvedIdentity = {
    organizationId: base.organizationId,
    schoolId: base.schoolId,
    sourceSchoolKey: base.sourceSchoolKey,
    baseSnapshotId: base.snapshotId,
    overlayRevisionId: selected?.revisionId ?? null,
    overlayRevisionNumber: selected?.revisionNumber ?? null,
    fields,
    provenance,
    conflicts,
  };

  return deepFreeze({
    ...resolvedIdentity,
    resolutionSha256: sha256SchoolValue(resolvedIdentity),
  });
}

export function reconcileSchoolOverlay(
  base: SchoolBaseRecord,
  revision: SchoolOverlayRevision,
): OverlayReconciliation {
  if (revision.status !== "approved") {
    throw new SchoolContractError("SCHOOL_OVERLAY_NOT_APPROVED");
  }
  const fields: Array<
    | { readonly fieldName: string; readonly kind: "base_matches_override" }
    | SchoolResolutionConflict
    | { readonly fieldName: string; readonly kind: "override_still_applies" }
  > = [];

  for (const change of revision.changes) {
    const currentBaseValueSha256 = sha256SchoolValue(baseValue(base, change.fieldName));
    const proposedValueSha256 = sha256SchoolValue(change.proposedValue);
    if (currentBaseValueSha256 === proposedValueSha256) {
      fields.push({ fieldName: change.fieldName, kind: "base_matches_override" });
    } else if (currentBaseValueSha256 !== change.baseValueSha256) {
      fields.push({
        fieldName: change.fieldName,
        kind: "base_changed",
        previousBaseValueSha256: change.baseValueSha256,
        currentBaseValueSha256,
      });
    } else {
      fields.push({ fieldName: change.fieldName, kind: "override_still_applies" });
    }
  }

  if (fields.some((field) => field.kind === "base_changed")) {
    return { action: "preserve_and_review", fields: fields as readonly SchoolResolutionConflict[] };
  }
  if (fields.every((field) => field.kind === "base_matches_override")) {
    return {
      action: "close_override",
      fields: fields as readonly [{ fieldName: string; kind: "base_matches_override" }],
    };
  }
  return {
    action: "retain_override",
    fields: fields as readonly [{ fieldName: string; kind: "override_still_applies" }],
  };
}
