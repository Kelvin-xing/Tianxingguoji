import {
  expectArray,
  expectNullableString,
  expectRecord,
  expectString,
  requestApi,
} from "../../../lib/api/client.ts";

export interface SchoolDirectoryItem {
  readonly school_id: string;
  readonly source_school_key: string;
  readonly base_snapshot_id: string;
  readonly resolved_revision_id: string | null;
  readonly overlay_revision_id: string | null;
  readonly resolution_sha256: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function listSchoolDirectory(): Promise<readonly SchoolDirectoryItem[]> {
  return requestApi({ path: "/api/v1/schools" }, (value) => {
    const root = expectRecord(value);
    return expectArray(root.items, decodeSchoolDirectoryItem);
  });
}

function decodeSchoolDirectoryItem(value: unknown): SchoolDirectoryItem {
  const item = expectRecord(value);
  const fields = expectRecord(item.fields);
  return Object.freeze({
    school_id: expectString(item.school_id),
    source_school_key: expectString(item.source_school_key),
    base_snapshot_id: expectString(item.base_snapshot_id),
    resolved_revision_id: expectNullableString(item.resolved_revision_id),
    overlay_revision_id: expectNullableString(item.overlay_revision_id),
    resolution_sha256: expectString(item.resolution_sha256),
    fields,
  });
}
