import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import {
  SchoolOptionsError,
  isSchoolOptionsError,
  type SchoolOptionView,
  type SchoolOptionsRepository,
} from "../application/school-options-service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface SchoolOptionRow extends Record<string, unknown> {
  readonly school_id: string;
  readonly display_name: string;
  readonly resolved_revision_id: string;
  readonly resolution_sha256: string;
}

export class PostgresqlSchoolOptionsRepository implements SchoolOptionsRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  list(input: Parameters<SchoolOptionsRepository["list"]>[0]) {
    return this.runner.run({
      organizationId: input.organizationId,
      actorKind: "user",
      actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId,
      requestId: "school-options-query",
    }, async (transaction) => {
      try {
        const result = await transaction.query<SchoolOptionRow>({
          text: `WITH active_snapshot AS (
                   SELECT id
                     FROM schools_snapshots
                    WHERE organization_id=$1 AND status='active'
                 ), current_overlay AS (
                   SELECT DISTINCT ON (overlay.school_id) overlay.school_id,overlay.id
                     FROM schools_overlay_revisions AS overlay
                     JOIN active_snapshot ON active_snapshot.id=overlay.base_snapshot_id
                    WHERE overlay.organization_id=$1 AND overlay.status='approved'
                    ORDER BY overlay.school_id,overlay.revision_number DESC,overlay.id::text COLLATE "C" ASC
                 ), selectable AS (
                   SELECT revision.school_id,
                          COALESCE(NULLIF(btrim(revision.fields_json->>'school_name_zh'),''),
                                   NULLIF(btrim(revision.fields_json->>'school_name_en'),''),
                                   NULLIF(btrim(record.source_school_key),'')) AS display_name,
                          revision.id AS resolved_revision_id,revision.resolution_sha256
                     FROM schools_resolved_revisions AS revision
                     JOIN active_snapshot ON active_snapshot.id=revision.base_snapshot_id
                     JOIN schools_schools AS school
                       ON school.id=revision.school_id AND school.organization_id=revision.organization_id
                     JOIN schools_snapshot_records AS record
                       ON record.organization_id=revision.organization_id
                      AND record.snapshot_id=revision.base_snapshot_id
                      AND record.school_id=revision.school_id
                     LEFT JOIN current_overlay ON current_overlay.school_id=revision.school_id
                    WHERE revision.organization_id=$1
                      AND revision.overlay_revision_id IS NOT DISTINCT FROM current_overlay.id
                 )
                 SELECT school_id,display_name,resolved_revision_id,resolution_sha256
                   FROM selectable
                  WHERE display_name IS NOT NULL
                    AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
                    AND ($3::text IS NULL OR display_name COLLATE "C" > $3 OR
                      (display_name COLLATE "C" = $3 AND school_id::text COLLATE "C" > $4))
                  ORDER BY display_name COLLATE "C" ASC,school_id::text COLLATE "C" ASC
                  LIMIT $5`,
          values: [input.organizationId,input.query,input.cursor?.displayName ?? null,
            input.cursor?.schoolId ?? null,input.limit + 1],
        });
        const items = result.rows.map(toView);
        return Object.freeze({
          items: Object.freeze(items.slice(0,input.limit)),
          hasMore: items.length > input.limit,
        });
      } catch (error) {
        if (isSchoolOptionsError(error)) throw error;
        throw new SchoolOptionsError("SCHOOL_OPTIONS_UNAVAILABLE");
      }
    });
  }
}

function toView(row: SchoolOptionRow): SchoolOptionView {
  const schoolId = row.school_id?.toLowerCase();
  const resolvedRevisionId = row.resolved_revision_id?.toLowerCase();
  const displayName = row.display_name?.trim().normalize("NFKC");
  if (!UUID.test(schoolId) || !UUID.test(resolvedRevisionId) || !displayName ||
      !SHA256.test(row.resolution_sha256)) {
    throw new SchoolOptionsError("SCHOOL_OPTIONS_UNAVAILABLE");
  }
  return Object.freeze({
    schoolId,
    displayName,
    resolvedRevisionId,
    resolutionSha256: row.resolution_sha256,
  });
}
