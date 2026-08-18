import "server-only";

import {
  persistResolvedSchoolPin,
  resolveSchoolTargetView,
  SchoolResolutionError,
  type ResolvedSchoolTargetView,
  type SchoolResolutionSource,
} from "../application/resolved-view.ts";
import type {
  JsonValue,
  SchoolBaseRecord,
  SchoolOverlayChange,
  SchoolOverlayRevision,
} from "../domain/contract.ts";

export interface SchoolResolutionTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

interface BaseRow extends Record<string, unknown> {
  school_id: string;
  snapshot_id: string;
  source_school_key: string;
  fields_json: unknown;
}

interface OverlayRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  base_snapshot_id: string;
  revision_number: number | string;
  requested_by_user_id: string;
  reason: string;
  approved_by_user_id: string;
  approved_role: "founder" | "data_reviewer";
  approved_at: Date | string;
  created_at: Date | string;
  field_name: string | null;
  field_class: "identity" | "general" | null;
  proposed_value_json: unknown;
  base_value_sha256: string | null;
  evidence_json: unknown;
}

interface ResolvedRevisionRow extends Record<string, unknown> {
  id: string;
}

export class PostgresqlResolvedSchoolTransaction {
  async listCurrentResolvedSchools(input: {
    readonly transaction: SchoolResolutionTransaction;
    readonly organizationId: string;
  }): Promise<readonly ResolvedSchoolTargetView[]> {
    const sources = await readSources(input.transaction, input.organizationId, null, false);
    return Object.freeze(sources.map(resolveSchoolTargetView));
  }

  async readCurrentResolvedSchool(input: {
    readonly transaction: SchoolResolutionTransaction;
    readonly organizationId: string;
    readonly schoolId: string;
  }): Promise<ResolvedSchoolTargetView> {
    const sources = await readSources(
      input.transaction,
      input.organizationId,
      input.schoolId,
      true,
    );
    const source = sources[0];
    if (!source) throw new SchoolResolutionError("SCHOOL_RESOLUTION_NOT_FOUND");
    return resolveSchoolTargetView(source);
  }

  async appendResolvedRevision(input: {
    readonly transaction: SchoolResolutionTransaction;
    readonly organizationId: string;
    readonly proposedResolvedRevisionId: string;
    readonly resolved: ResolvedSchoolTargetView;
    readonly createdAtMs: number;
  }): Promise<ResolvedSchoolTargetView> {
    const view = input.resolved.view;
    if (view.organizationId !== input.organizationId) {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    }
    await input.transaction.query(
      `INSERT INTO schools_resolved_revisions
        (id, organization_id, school_id, base_snapshot_id, overlay_revision_id,
         resolution_sha256, fields_json, provenance_json, conflicts_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,to_timestamp($10 / 1000.0))
       ON CONFLICT (organization_id, school_id, resolution_sha256) DO NOTHING`,
      [input.proposedResolvedRevisionId, input.organizationId, view.schoolId,
        view.baseSnapshotId, view.overlayRevisionId, view.resolutionSha256,
        JSON.stringify(view.fields), JSON.stringify(view.provenance),
        JSON.stringify(view.conflicts), input.createdAtMs],
    );
    const stored = await input.transaction.query<ResolvedRevisionRow>(
      `SELECT id
         FROM schools_resolved_revisions
        WHERE organization_id = $1 AND school_id = $2 AND resolution_sha256 = $3
          AND base_snapshot_id = $4
          AND overlay_revision_id IS NOT DISTINCT FROM $5::uuid
          AND fields_json = $6::jsonb
          AND provenance_json = $7::jsonb
          AND conflicts_json = $8::jsonb
        FOR SHARE`,
      [input.organizationId, view.schoolId, view.resolutionSha256, view.baseSnapshotId,
        view.overlayRevisionId, JSON.stringify(view.fields), JSON.stringify(view.provenance),
        JSON.stringify(view.conflicts)],
    );
    const row = stored.rows[0];
    if (!row) throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    return persistResolvedSchoolPin(input.resolved, row.id);
  }
}

export function resolvedSchoolDisplayName(
  fields: Readonly<Record<string, JsonValue>>,
  sourceSchoolKey: string,
): string {
  for (const name of [fields.school_name_zh, fields.school_name_en]) {
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  if (sourceSchoolKey.trim().length > 0) return sourceSchoolKey.trim();
  throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
}

async function readSources(
  transaction: SchoolResolutionTransaction,
  organizationId: string,
  schoolId: string | null,
  lock: boolean,
): Promise<readonly SchoolResolutionSource[]> {
  if (lock && schoolId) {
    const locked = await transaction.query(
      `SELECT id FROM schools_schools
        WHERE organization_id = $1 AND id = $2
        FOR UPDATE`,
      [organizationId, schoolId],
    );
    if (locked.rowCount !== 1) throw new SchoolResolutionError("SCHOOL_RESOLUTION_NOT_FOUND");
  }
  const baseRows = await transaction.query<BaseRow>(
    `SELECT school.id AS school_id, snapshot.id AS snapshot_id,
            record.source_school_key, record.fields_json
       FROM schools_schools AS school
       JOIN schools_snapshots AS snapshot
         ON snapshot.organization_id = school.organization_id
        AND snapshot.status = 'active'
       JOIN schools_snapshot_records AS record
         ON record.organization_id = school.organization_id
        AND record.snapshot_id = snapshot.id
        AND record.school_id = school.id
      WHERE school.organization_id = $1
        AND ($2::uuid IS NULL OR school.id = $2)
      ORDER BY school.id
      ${lock ? "FOR SHARE OF snapshot, record" : ""}`,
    [organizationId, schoolId],
  );
  if (schoolId && baseRows.rowCount !== 1) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_NOT_FOUND");
  }
  if (baseRows.rowCount === 0) return Object.freeze([]);

  const overlays = await transaction.query<OverlayRow>(
    `SELECT revision.id, revision.school_id, revision.base_snapshot_id,
            revision.revision_number, revision.requested_by_user_id, revision.reason,
            revision.approved_by_user_id, revision.approved_role, revision.approved_at,
            revision.created_at, field.field_name, field.field_class,
            field.proposed_value_json, field.base_value_sha256, field.evidence_json
       FROM schools_overlay_revisions AS revision
       LEFT JOIN schools_overlay_fields AS field
         ON field.organization_id = revision.organization_id
        AND field.revision_id = revision.id
        AND field.school_id = revision.school_id
      WHERE revision.organization_id = $1
        AND revision.school_id = ANY($2::uuid[])
        AND revision.status = 'approved'
      ORDER BY revision.school_id, revision.revision_number, revision.id, field.field_name
      ${lock ? "FOR SHARE OF revision" : ""}`,
    [organizationId, baseRows.rows.map((row) => row.school_id)],
  );
  const revisionsBySchool = buildRevisions(organizationId, overlays.rows);
  return Object.freeze(baseRows.rows.map((row) => Object.freeze({
    base: Object.freeze({
      organizationId,
      schoolId: row.school_id,
      snapshotId: row.snapshot_id,
      sourceSchoolKey: row.source_school_key,
      fields: jsonObject(row.fields_json),
    }) satisfies SchoolBaseRecord,
    revisions: Object.freeze(
      (revisionsBySchool.get(row.school_id) ?? [])
        .filter((revision) => revision.baseSnapshotId === row.snapshot_id),
    ),
  })));
}

function buildRevisions(
  organizationId: string,
  rows: readonly OverlayRow[],
): ReadonlyMap<string, readonly SchoolOverlayRevision[]> {
  const grouped = new Map<string, Map<string, OverlayRow[]>>();
  for (const row of rows) {
    const school = grouped.get(row.school_id) ?? new Map<string, OverlayRow[]>();
    const revision = school.get(row.id) ?? [];
    revision.push(row);
    school.set(row.id, revision);
    grouped.set(row.school_id, school);
  }
  return new Map([...grouped].map(([schoolId, revisions]) => [
    schoolId,
    Object.freeze([...revisions.values()].map((revisionRows) => toRevision(
      organizationId,
      revisionRows,
    ))),
  ]));
}

function toRevision(organizationId: string, rows: readonly OverlayRow[]): SchoolOverlayRevision {
  const first = rows[0];
  if (!first) throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  const changes: SchoolOverlayChange[] = rows.map((row) => {
    if (!row.field_name || !row.field_class || !row.base_value_sha256) {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    }
    const evidence = jsonObject(row.evidence_json);
    const sourceUrl = evidence.sourceUrl ?? evidence.source_url;
    const quote = evidence.quote;
    if (typeof sourceUrl !== "string" || typeof quote !== "string") {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    }
    return Object.freeze({
      fieldName: row.field_name,
      fieldClass: row.field_class,
      proposedValue: row.proposed_value_json as JsonValue,
      baseValueSha256: row.base_value_sha256,
      evidence: Object.freeze({ sourceUrl, quote }),
    });
  });
  return Object.freeze({
    organizationId,
    schoolId: first.school_id,
    baseSnapshotId: first.base_snapshot_id,
    revisionId: first.id,
    revisionNumber: Number(first.revision_number),
    requestedBy: first.requested_by_user_id,
    reason: first.reason,
    changes: Object.freeze(changes),
    status: "approved",
    createdAt: toIso(first.created_at),
    approvedBy: first.approved_by_user_id,
    approvedRole: first.approved_role,
    approvedAt: toIso(first.approved_at),
  });
}

function jsonObject(value: unknown): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }
  return parsed.toISOString();
}
