import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import {
  proposeSchoolOverlay,
  sha256SchoolValue,
  type JsonValue,
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
} from "../../modules/schools/contract.ts";
import {
  SchoolServiceError,
  type ProvisionalSchoolResult,
  type SchoolChangeRequestResult,
  type SchoolRepository,
} from "../../modules/schools/service.ts";

interface StoredResult<Result> {
  readonly requestHash: string;
  readonly result: Result;
}

interface StoredProvisionalSchool {
  readonly organizationId: string;
  readonly identity: string;
  readonly district: string;
  readonly system: string;
  readonly stage: string;
  readonly reason: string;
  readonly officialWebsite: null;
}

interface StoredChangeRequest {
  readonly organizationId: string;
  readonly schoolId: string;
  readonly requesterUserId: string;
  readonly overlayRevisionId: string;
  readonly status: "submitted";
}

/**
 * Deterministic P1-08 adapter. It stages every mutation before replacement;
 * production must provide the same atomic behavior through an HK RDS adapter.
 */
export class InMemorySchoolRepository implements SchoolRepository {
  private readonly baseRecords = new Map<string, SchoolBaseRecord>();
  private provisionalSchools = new Map<string, StoredProvisionalSchool>();
  private changeRequests = new Map<string, StoredChangeRequest>();
  private candidateOverlays = new Map<string, SchoolOverlayRevision>();
  private provisionalResults = new Map<string, StoredResult<ProvisionalSchoolResult>>();
  private changeResults = new Map<string, StoredResult<SchoolChangeRequestResult>>();
  private effects = new Map<string, MutationEffectBundle>();
  private failNextCommit = false;

  addBaseRecord(base: SchoolBaseRecord): void {
    this.baseRecords.set(baseKey(base.organizationId, base.schoolId, base.snapshotId), base);
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{
    provisionalSchools: number;
    changeRequests: number;
    candidateOverlays: number;
    audits: number;
    outbox: number;
  }> {
    return Object.freeze({
      provisionalSchools: this.provisionalSchools.size,
      changeRequests: this.changeRequests.size,
      candidateOverlays: this.candidateOverlays.size,
      audits: this.effects.size,
      outbox: this.effects.size,
    });
  }

  getProvisionalSchool(schoolId: string): StoredProvisionalSchool | undefined {
    return this.provisionalSchools.get(schoolId);
  }

  getCandidateOverlay(changeRequestId: string): SchoolOverlayRevision | undefined {
    return this.candidateOverlays.get(changeRequestId);
  }

  getEffects(resourceId: string): MutationEffectBundle | undefined {
    return this.effects.get(resourceId);
  }

  async createProvisionalSchool(
    input: Parameters<SchoolRepository["createProvisionalSchool"]>[0],
  ): Promise<ProvisionalSchoolResult> {
    const scope = `${input.organizationId}:${input.actorUserId}:schools.provisional.create:${input.idempotencyKey}`;
    const existing = this.provisionalResults.get(scope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new SchoolServiceError("SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    const result: ProvisionalSchoolResult = Object.freeze({
      schoolId: input.schoolId,
      status: "provisional",
      recordVersion: 1,
    });
    const nextProvisionals = new Map(this.provisionalSchools);
    const nextResults = new Map(this.provisionalResults);
    const nextEffects = new Map(this.effects);
    nextProvisionals.set(input.schoolId, {
      organizationId: input.organizationId,
      identity: input.identity,
      district: input.district,
      system: input.system,
      stage: input.stage,
      reason: input.reason,
      officialWebsite: null,
    });
    nextResults.set(scope, { requestHash: input.requestHash, result });
    nextEffects.set(input.schoolId, input.effects);

    this.commitOrFail(() => {
      this.provisionalSchools = nextProvisionals;
      this.provisionalResults = nextResults;
      this.effects = nextEffects;
    });
    return result;
  }

  async submitSchoolChange(
    input: Parameters<SchoolRepository["submitSchoolChange"]>[0],
  ): Promise<SchoolChangeRequestResult> {
    const scope = `${input.organizationId}:${input.actorUserId}:schools.change.submit:${input.idempotencyKey}`;
    const existing = this.changeResults.get(scope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new SchoolServiceError("SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    const base = this.baseRecords.get(baseKey(input.organizationId, input.schoolId, input.baseSnapshotId));
    if (!base) throw new SchoolServiceError("SCHOOL_CHANGE_BASE_NOT_FOUND");
    const currentBaseValue = Object.hasOwn(base.fields, input.fieldName)
      ? base.fields[input.fieldName]
      : null;
    if (sha256SchoolValue(currentBaseValue) !== input.baseValueSha256) {
      throw new SchoolServiceError("SCHOOL_CHANGE_BASE_STALE");
    }

    const revisionNumber =
      Math.max(
        0,
        ...[...this.candidateOverlays.values()]
          .filter(
            (revision) =>
              revision.organizationId === input.organizationId && revision.schoolId === input.schoolId,
          )
          .map((revision) => revision.revisionNumber),
      ) + 1;
    const candidate = proposeSchoolOverlay({
      organizationId: input.organizationId,
      schoolId: input.schoolId,
      baseSnapshotId: input.baseSnapshotId,
      revisionId: input.changeRequestId,
      revisionNumber,
      requestedBy: input.actorUserId,
      reason: input.reason,
      changes: [
        {
          fieldName: input.fieldName,
          fieldClass: input.fieldClass,
          proposedValue: input.proposedValue,
          baseValueSha256: input.baseValueSha256,
          evidence: input.evidence,
        },
      ],
      createdAt: new Date(input.submittedAtMs).toISOString(),
    });
    const result: SchoolChangeRequestResult = Object.freeze({
      changeRequestId: input.changeRequestId,
      schoolId: input.schoolId,
      baseSnapshotId: input.baseSnapshotId,
      fieldName: input.fieldName,
      status: "submitted",
      recordVersion: 1,
    });
    const nextRequests = new Map(this.changeRequests);
    const nextOverlays = new Map(this.candidateOverlays);
    const nextResults = new Map(this.changeResults);
    const nextEffects = new Map(this.effects);
    nextRequests.set(input.changeRequestId, {
      organizationId: input.organizationId,
      schoolId: input.schoolId,
      requesterUserId: input.actorUserId,
      overlayRevisionId: input.changeRequestId,
      status: "submitted",
    });
    nextOverlays.set(input.changeRequestId, candidate);
    nextResults.set(scope, { requestHash: input.requestHash, result });
    nextEffects.set(input.changeRequestId, input.effects);

    this.commitOrFail(() => {
      this.changeRequests = nextRequests;
      this.candidateOverlays = nextOverlays;
      this.changeResults = nextResults;
      this.effects = nextEffects;
    });
    return result;
  }

  baseValueHash(input: {
    readonly organizationId: string;
    readonly schoolId: string;
    readonly snapshotId: string;
    readonly fieldName: string;
  }): string {
    const base = this.baseRecords.get(baseKey(input.organizationId, input.schoolId, input.snapshotId));
    if (!base) throw new Error("base record not found");
    const value: JsonValue | null = Object.hasOwn(base.fields, input.fieldName)
      ? base.fields[input.fieldName]
      : null;
    return sha256SchoolValue(value);
  }

  private commitOrFail(commit: () => void): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }
    commit();
  }
}

function baseKey(organizationId: string, schoolId: string, snapshotId: string): string {
  return `${organizationId}:${schoolId}:${snapshotId}`;
}
