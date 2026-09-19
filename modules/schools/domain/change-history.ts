import type {JsonValue} from './contract.ts';

export interface SchoolChangeHistoryItem {
  readonly change_request_id:string;
  readonly school_id:string;
  readonly revision_number:number;
  readonly record_version:number;
  readonly status:'candidate'|'approved'|'rejected'|'disabled';
  readonly reason:string;
  readonly submitted_at:string;
  readonly approved_at:string|null;
  readonly disabled_at:string|null;
  readonly disable_reason:string|null;
  readonly fields:readonly {
    readonly field_name:string;
    readonly field_class:'identity'|'general';
    readonly snapshot_value:JsonValue;
    readonly proposed_value:JsonValue;
    readonly source_url:string;
    readonly quote:string;
  }[];
}
