import { expectNullableString, expectRecord, expectString, requestApi } from "../../../lib/api/client.ts";
import type { SchoolDirectoryItem } from "./directory-client.ts";

export interface ResolvedSchoolDetail extends Omit<SchoolDirectoryItem,"source_school_key"> {
  readonly change_context:{readonly can_submit:boolean;readonly can_edit_existing:boolean;readonly effective_value_hashes:Readonly<Record<string,string>>;readonly base_value_hashes:Readonly<Record<string,string>>;readonly empty_value_sha256:string};
}
export function getResolvedSchool(schoolId: string, signal?: AbortSignal): Promise<ResolvedSchoolDetail> {
  return requestApi({ path: `/api/v1/schools/${encodeURIComponent(schoolId)}/resolved`, signal }, (value) => {
    const row = expectRecord(value);
    const id = expectString(row.school_id);
    if (id !== schoolId) throw new TypeError("Resolved school identity mismatch");
    const context=expectRecord(row.change_context),hashes=expectRecord(context.base_value_hashes),effectiveHashes=expectRecord(context.effective_value_hashes);
    const hash=(input:unknown)=>{const value=expectString(input);if(!/^[a-f0-9]{64}$/.test(value))throw new TypeError('Invalid school change baseline');return value;};
    if(typeof context.can_submit!=='boolean'||typeof context.can_edit_existing!=='boolean')throw new TypeError('Invalid school change capabilities');
    return Object.freeze({
      change_context:{can_submit:context.can_submit,can_edit_existing:context.can_edit_existing,
        effective_value_hashes:Object.fromEntries(Object.entries(effectiveHashes).map(([key,value])=>[key,hash(value)])),
        base_value_hashes:Object.fromEntries(Object.entries(hashes).map(([key,value])=>[key,hash(value)])),empty_value_sha256:hash(context.empty_value_sha256)},
      school_id: id,
      base_snapshot_id: expectString(row.base_snapshot_id),
      resolved_revision_id: expectNullableString(row.resolved_revision_id),
      overlay_revision_id: expectNullableString(row.overlay_revision_id),
      resolution_sha256: expectString(row.resolution_sha256),
      fields: expectRecord(row.fields),
    });
  });
}
