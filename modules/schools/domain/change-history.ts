import type {JsonValue} from './contract.ts';

export interface SchoolChangeHistoryItem {
  readonly change_request_id:string;
  readonly school_id:string;
  readonly revision_number:number;
  readonly record_version:number;
  readonly status:'candidate'|'approved'|'rejected'|'disabled';
  readonly reason:string;
  readonly requester_name:string|null;
  readonly allowed_actions:readonly ("approve"|"reject")[];
  readonly approval_block_reason:"baseline_changed"|"missing_baseline"|null;
  readonly review:{readonly reviewer_name:string|null;readonly reviewer_role:"founder"|"l1";readonly decision:"approve"|"reject";readonly reason:string;readonly reviewed_at:string}|null;
  readonly submitted_at:string;
  readonly approved_at:string|null;
  readonly disabled_at:string|null;
  readonly disable_reason:string|null;
  readonly fields:readonly {
    readonly field_name:string;
    readonly field_class:'identity'|'general';
    readonly snapshot_value:JsonValue;
    readonly current_value:JsonValue;
    readonly submitted_effective_value:{readonly value:JsonValue}|null;
    readonly proposed_value:JsonValue;
    readonly source_url:string;
    readonly quote:string;
  }[];
}
