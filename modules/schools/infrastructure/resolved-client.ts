import { expectNullableString, expectRecord, expectString, requestApi } from "../../../lib/api/client.ts";
import type { SchoolDirectoryItem } from "./directory-client.ts";

export function getResolvedSchool(schoolId: string, signal?: AbortSignal): Promise<Omit<SchoolDirectoryItem, "source_school_key">> {
  return requestApi({ path: `/api/v1/schools/${encodeURIComponent(schoolId)}/resolved`, signal }, (value) => {
    const row = expectRecord(value);
    const id = expectString(row.school_id);
    if (id !== schoolId) throw new TypeError("Resolved school identity mismatch");
    return Object.freeze({
      school_id: id,
      base_snapshot_id: expectString(row.base_snapshot_id),
      resolved_revision_id: expectNullableString(row.resolved_revision_id),
      overlay_revision_id: expectNullableString(row.overlay_revision_id),
      resolution_sha256: expectString(row.resolution_sha256),
      fields: expectRecord(row.fields),
    });
  });
}
