import {
  DIRECTORY_CAMPUS_FIELDS, DIRECTORY_SCHOOL_FIELDS,
  type DirectoryCampusField, type DirectoryFieldValues, type DirectorySchoolField,
  type DirectoryValue,
} from "../domain/directory-structure.ts";

/** Internal, transaction-scoped storage seam only. No runtime composition, API,
 * authorization or application-role grant is introduced by this module. */
export interface DirectoryStructureTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}
export class DirectoryStructureStore {
  private readonly tx: DirectoryStructureTransaction;
  constructor(tx: DirectoryStructureTransaction) { this.tx = tx; }

  async context(input: { organizationId: string; actorId: string; source: object; occurredAt: string }) {
    await this.tx.query(`SELECT set_config('app.organization_id',$1,true),
      set_config('app.actor_user_id',$2,true),set_config('app.schools_directory_source',$3,true),
      set_config('app.schools_directory_time',$4,true)`,
    [input.organizationId, input.actorId, JSON.stringify(input.source), input.occurredAt]);
  }

  async create(input: { id: string; organizationId: string; edbNumber: string | null;
    origin: "edb" | "manual"; fields: DirectoryFieldValues; campusId: string;
    campusOrigin: "edb" | "manual"; campusFields: DirectoryFieldValues;
    sharedFields: readonly DirectoryCampusField[] }) {
    await this.tx.query(`INSERT INTO schools_directory_schools
      (id,organization_id,edb_number,origin,fields) VALUES ($1,$2,$3,$4,$5)`,
    [input.id, input.organizationId, input.edbNumber, input.origin, input.fields]);
    await this.addCampus({ id: input.campusId, schoolId: input.id, organizationId: input.organizationId,
      origin: input.campusOrigin, fields: input.campusFields });
    for (const field of DIRECTORY_CAMPUS_FIELDS) {
      await this.tx.query(`INSERT INTO schools_directory_field_modes
        (school_id,organization_id,field_key,shared) VALUES ($1,$2,$3,$4)`,
      [input.id, input.organizationId, field, input.sharedFields.includes(field)]);
    }
  }

  async addCampus(input: { id: string; schoolId: string; organizationId: string;
    origin: "edb" | "manual"; fields: DirectoryFieldValues }) {
    await this.tx.query(`INSERT INTO schools_directory_campuses
      (id,school_id,organization_id,origin,fields) VALUES ($1,$2,$3,$4,$5)`,
    [input.id, input.schoolId, input.organizationId, input.origin, input.fields]);
  }

  async setSchoolField(id: string, field: DirectorySchoolField, value: DirectoryValue, version: number) {
    if (!DIRECTORY_SCHOOL_FIELDS.includes(field)) throw new Error("directory_school_field_required");
    const result = await this.tx.query(`UPDATE schools_directory_schools SET
      fields=jsonb_set(fields,ARRAY[$2::text],$3::jsonb),record_version=record_version+1
      WHERE id=$1 AND record_version=$4 RETURNING id`, [id, field, JSON.stringify(value), version]);
    if (result.rowCount !== 1) throw new Error("directory_version_conflict");
  }

  async setCampusField(id: string, field: DirectoryCampusField, value: DirectoryValue, version: number) {
    if (!DIRECTORY_CAMPUS_FIELDS.includes(field)) throw new Error("directory_campus_field_required");
    const result = await this.tx.query(`UPDATE schools_directory_campuses SET
      fields=jsonb_set(fields,ARRAY[$2::text],$3::jsonb),record_version=record_version+1
      WHERE id=$1 AND record_version=$4 AND deleted_at IS NULL RETURNING id`,
    [id, field, JSON.stringify(value), version]);
    if (result.rowCount !== 1) throw new Error("directory_version_conflict");
  }

  async setSharedField(schoolId: string, field: DirectoryCampusField, value: DirectoryValue,
    expectedSchoolVersion: number) {
    await this.lockVersion(schoolId, expectedSchoolVersion);
    await this.tx.query(`UPDATE schools_directory_field_modes SET shared=true WHERE school_id=$1 AND field_key=$2`, [schoolId, field]);
    await this.tx.query(`UPDATE schools_directory_campuses SET fields=jsonb_set(fields,ARRAY[$2::text],$3::jsonb),
      record_version=record_version+1 WHERE school_id=$1 AND deleted_at IS NULL`, [schoolId, field, JSON.stringify(value)]);
  }

  async splitField(schoolId: string, field: DirectoryCampusField, expectedSchoolVersion: number) {
    await this.lockVersion(schoolId, expectedSchoolVersion);
    await this.tx.query(`UPDATE schools_directory_field_modes SET shared=false WHERE school_id=$1 AND field_key=$2`, [schoolId, field]);
  }

  async deleteCampus(id: string, version: number) {
    const result = await this.tx.query(`UPDATE schools_directory_campuses SET
      deleted_at=current_setting('app.schools_directory_time')::timestamptz,
      record_version=record_version+1 WHERE id=$1 AND record_version=$2 AND deleted_at IS NULL RETURNING id`, [id, version]);
    if (result.rowCount !== 1) throw new Error("directory_version_conflict");
  }

  async restoreField(historyId: string, expectedVersion: number, expectedSchoolVersion?: number) {
    const result = await this.tx.query<{ school_id: string; campus_id: string | null; field_key: string; old_value: DirectoryValue }>(
      `SELECT school_id,campus_id,field_key,old_value FROM schools_directory_history WHERE id=$1`, [historyId]);
    const entry = result.rows[0];
    if (!entry) throw new Error("directory_history_not_found");
    if (entry.campus_id && DIRECTORY_CAMPUS_FIELDS.includes(entry.field_key as DirectoryCampusField)) {
      // A common displayed value belongs to every live campus for this field.
      // Version both its selected history target and the school-wide scope.
      const mode = await this.tx.query<{ shared: boolean }>(
        "SELECT shared FROM schools_directory_field_modes WHERE school_id=$1 AND field_key=$2",
        [entry.school_id, entry.field_key]);
      if (mode.rows[0]?.shared) {
        if (expectedSchoolVersion === undefined) throw new Error("directory_school_version_required_for_shared_restore");
        await this.lockVersion(entry.school_id, expectedSchoolVersion);
        const target = await this.tx.query("SELECT id FROM schools_directory_campuses WHERE id=$1 AND record_version=$2 AND deleted_at IS NULL", [entry.campus_id, expectedVersion]);
        if (target.rowCount !== 1) throw new Error("directory_version_conflict");
        await this.setSharedField(entry.school_id, entry.field_key as DirectoryCampusField,
          entry.old_value ?? null, expectedSchoolVersion);
      } else {
        await this.setCampusField(entry.campus_id, entry.field_key as DirectoryCampusField, entry.old_value ?? null, expectedVersion);
      }
    } else if (!entry.campus_id && DIRECTORY_SCHOOL_FIELDS.includes(entry.field_key as DirectorySchoolField)) {
      await this.setSchoolField(entry.school_id, entry.field_key as DirectorySchoolField, entry.old_value ?? null, expectedVersion);
    } else if (!entry.campus_id && entry.field_key === "is_closed"
      && (entry.old_value === null || typeof entry.old_value === "boolean")) {
      const changed = await this.tx.query(`UPDATE schools_directory_schools SET is_closed=$2,
        record_version=record_version+1 WHERE id=$1 AND record_version=$3 RETURNING id`,
      [entry.school_id, entry.old_value, expectedVersion]);
      if (changed.rowCount !== 1) throw new Error("directory_version_conflict");
    } else {
      throw new Error("directory_value_history_required");
    }
  }

  private async lockVersion(id: string, version: number) {
    const result = await this.tx.query(`SELECT id FROM schools_directory_schools WHERE id=$1 AND record_version=$2 FOR UPDATE`, [id, version]);
    if (result.rowCount !== 1) throw new Error("directory_version_conflict");
  }
}
