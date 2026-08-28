import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_SCHOOLS,
  NEON_TEST_SCHOOL_SNAPSHOT_ID,
  NEON_TEST_SCHOOL_SOURCE_RELEASE_ID,
  neonTestSchoolSnapshotManifestSha256,
} from "../../../scripts/db/neon-test-synthetic-fixture.ts";
import type { AccessContext } from "../../access/public.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";

const RESOLVED_REVISION_IDS = Object.freeze([
  "51000000-0000-4000-8000-000000000911",
  "51000000-0000-4000-8000-000000000912",
  "51000000-0000-4000-8000-000000000913",
] as const);

export type DatabaseTestSchoolFixtureErrorCode =
  | "DATABASE_TEST_SCHOOL_FIXTURE_FORBIDDEN"
  | "DATABASE_TEST_SCHOOL_FIXTURE_UNAVAILABLE";

export class DatabaseTestSchoolFixtureError extends Error {
  readonly code: DatabaseTestSchoolFixtureErrorCode;

  constructor(code: DatabaseTestSchoolFixtureErrorCode) {
    super(`Database-test school fixture failed: ${code}.`);
    this.name = "DatabaseTestSchoolFixtureError";
    this.code = code;
  }
}

export type DatabaseTestResolvedSchool = Readonly<{
  schoolId: string;
  displayName: string;
  resolvedRevisionId: string;
  resolutionSha256: string;
}>;

/**
 * Completes the fixed ENV01 school seed for Vercel UAT. It accepts no fixture
 * payload and is unavailable outside the database-test deployment boundary.
 */
export async function ensureDatabaseTestResolvedSchoolFixture(input: Readonly<{
  actor: AccessContext;
  requestId: string;
}>): Promise<readonly DatabaseTestResolvedSchool[]> {
  assertDatabaseTestFounder(input.actor);

  try {
    return await getApplicationTenantRunner().run({
      organizationId: input.actor.organizationId,
      actorKind: "user",
      actorOpaqueId: input.actor.userId,
      actorUserId: input.actor.userId,
      requestId: input.requestId,
    }, async (transaction) => {
      const results: DatabaseTestResolvedSchool[] = [];

      for (const [index, school] of NEON_TEST_SCHOOLS.entries()) {
        const base = await transaction.query<{ count: number }>({
          text: `SELECT count(*)::int AS count
                   FROM schools_schools AS school_row
                   JOIN schools_snapshots AS snapshot
                     ON snapshot.id=$2 AND snapshot.organization_id=school_row.organization_id
                   JOIN schools_snapshot_records AS record
                     ON record.organization_id=school_row.organization_id
                    AND record.snapshot_id=snapshot.id
                    AND record.school_id=school_row.id
                  WHERE school_row.id=$1
                    AND school_row.organization_id=$3
                    AND school_row.source_school_key=$4
                    AND snapshot.source_release_id=$5
                    AND snapshot.manifest_sha256=$6
                    AND snapshot.status='active'
                    AND snapshot.record_count=$7
                    AND record.id=$8
                    AND record.source_school_key=$4
                    AND record.fields_json=$9::jsonb
                    AND record.provenance_json=$10::jsonb
                    AND record.record_sha256=$11`,
          values: [
            school.id,
            NEON_TEST_SCHOOL_SNAPSHOT_ID,
            NEON_TEST_ORGANIZATION.id,
            school.sourceSchoolKey,
            NEON_TEST_SCHOOL_SOURCE_RELEASE_ID,
            neonTestSchoolSnapshotManifestSha256(),
            NEON_TEST_SCHOOLS.length,
            school.recordId,
            JSON.stringify(school.fields),
            JSON.stringify(school.provenance),
            school.recordSha256,
          ],
        });
        if (base.rows[0]?.count !== 1) {
          throw new DatabaseTestSchoolFixtureError("DATABASE_TEST_SCHOOL_FIXTURE_UNAVAILABLE");
        }

        await transaction.query({
          text: `INSERT INTO schools_resolved_revisions
                  (id, organization_id, school_id, base_snapshot_id, overlay_revision_id,
                   resolution_sha256, fields_json, provenance_json, conflicts_json)
                 VALUES ($1,$2,$3,$4,NULL,$5,$6::jsonb,$7::jsonb,'[]'::jsonb)
                 ON CONFLICT (organization_id, school_id, resolution_sha256) DO NOTHING`,
          values: [
            RESOLVED_REVISION_IDS[index],
            NEON_TEST_ORGANIZATION.id,
            school.id,
            NEON_TEST_SCHOOL_SNAPSHOT_ID,
            school.recordSha256,
            JSON.stringify(school.fields),
            JSON.stringify(school.provenance),
          ],
        });

        const resolved = await transaction.query<{ id: string }>({
          text: `SELECT id
                   FROM schools_resolved_revisions
                  WHERE organization_id=$1
                    AND school_id=$2
                    AND base_snapshot_id=$3
                    AND overlay_revision_id IS NULL
                    AND resolution_sha256=$4
                    AND fields_json=$5::jsonb
                    AND provenance_json=$6::jsonb
                    AND conflicts_json='[]'::jsonb`,
          values: [
            NEON_TEST_ORGANIZATION.id,
            school.id,
            NEON_TEST_SCHOOL_SNAPSHOT_ID,
            school.recordSha256,
            JSON.stringify(school.fields),
            JSON.stringify(school.provenance),
          ],
        });
        const row = resolved.rows[0];
        if (!row || resolved.rows.length !== 1) {
          throw new DatabaseTestSchoolFixtureError("DATABASE_TEST_SCHOOL_FIXTURE_UNAVAILABLE");
        }
        results.push(Object.freeze({
          schoolId: school.id,
          displayName: school.fields.school_name_en,
          resolvedRevisionId: row.id,
          resolutionSha256: school.recordSha256,
        }));
      }

      return Object.freeze(results);
    });
  } catch (error) {
    if (error instanceof DatabaseTestSchoolFixtureError) throw error;
    throw new DatabaseTestSchoolFixtureError("DATABASE_TEST_SCHOOL_FIXTURE_UNAVAILABLE");
  }
}

function assertDatabaseTestFounder(actor: AccessContext): void {
  const runtime = loadRuntimeEnvironment();
  if (
    runtime.appEnvironment !== "test" ||
    runtime.appRuntimeMode !== "test-database" ||
    runtime.authMode !== "database-test" ||
    runtime.vercel === false ||
    actor.organizationId !== NEON_TEST_ORGANIZATION.id ||
    !actor.roles.includes("founder")
  ) {
    throw new DatabaseTestSchoolFixtureError("DATABASE_TEST_SCHOOL_FIXTURE_FORBIDDEN");
  }
}
