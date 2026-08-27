import {
  hasRequestCapability,
  type RequestAccessActor,
} from "../../access/public.ts";
import type {
  CandidateListStatus,
  FounderListDecision,
  GuardianConfirmationChannel,
  GuardianListDecision,
} from "../domain/candidate-list-case-flow.ts";
import {
  decodeCandidateListCursor,
  encodeCandidateListCursor,
  type CandidateListCursor,
} from "../domain/candidate-list-cursor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CandidateListQueryItemView {
  readonly id: string;
  readonly schoolId: string;
  readonly pinnedResolvedRevisionId: string;
  readonly pinnedResolutionSha256: string;
  readonly ordinal: number;
  readonly schoolTargetId: string | null;
  readonly applicationDeadline: string | null;
}

export interface CandidateListFounderApprovalView {
  readonly decision: FounderListDecision;
  readonly decidedByUserId: string;
  readonly decidedAt: string;
  readonly reason: string | null;
  readonly decisionSha256: string;
}

export interface CandidateListGuardianDecisionView {
  readonly guardianId: string;
  readonly guardianRelationshipId: string;
  readonly decision: GuardianListDecision;
  readonly decidedAt: string;
  readonly channel: GuardianConfirmationChannel;
  readonly recordedByUserId: string;
  readonly recordedAt: string;
  readonly boundFounderDecisionSha256: string;
}

export interface CandidateListVersionView {
  readonly id: string;
  readonly versionNumber: number;
  readonly previousVersionId: string | null;
  readonly schoolSetSha256: string;
  readonly status: CandidateListStatus;
  readonly recordVersion: number;
  readonly changeSummary: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly items: readonly CandidateListQueryItemView[];
  readonly founderApproval: CandidateListFounderApprovalView | null;
  readonly guardianDecision: CandidateListGuardianDecisionView | null;
}

export interface CandidateListQueryResult {
  readonly items: readonly CandidateListVersionView[];
  readonly nextCursor: string | null;
}

export interface CandidateListQueryRepository {
  list(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    caseId: string;
    requestId: string;
    limit: number;
    cursor: CandidateListCursor | null;
  }>): Promise<Readonly<{
    items: readonly CandidateListVersionView[];
    hasMore: boolean;
  }>>;
}

export type CandidateListQueryErrorCode =
  | "CANDIDATE_LIST_QUERY_INVALID"
  | "CANDIDATE_LIST_QUERY_FORBIDDEN"
  | "CANDIDATE_LIST_QUERY_NOT_FOUND"
  | "CANDIDATE_LIST_QUERY_UNAVAILABLE";

const QUERY_ERROR_CODES = new Set<CandidateListQueryErrorCode>([
  "CANDIDATE_LIST_QUERY_INVALID",
  "CANDIDATE_LIST_QUERY_FORBIDDEN",
  "CANDIDATE_LIST_QUERY_NOT_FOUND",
  "CANDIDATE_LIST_QUERY_UNAVAILABLE",
]);

export class CandidateListQueryError extends Error {
  readonly code: CandidateListQueryErrorCode;
  constructor(code: CandidateListQueryErrorCode) {
    super(`Candidate list query rejected ${code}.`);
    this.name = "CandidateListQueryError";
    this.code = code;
  }
}

export function isCandidateListQueryError(value: unknown): value is CandidateListQueryError {
  if (!(value instanceof Error) || value.name !== "CandidateListQueryError") return false;
  return QUERY_ERROR_CODES.has((value as CandidateListQueryError).code);
}

export class CandidateListQueryService {
  private readonly repository: CandidateListQueryRepository;
  constructor(repository: CandidateListQueryRepository) { this.repository = repository; }

  async list(input: Readonly<{
    actor: RequestAccessActor;
    caseId: string;
    requestId: string;
    limit?: number;
    cursor?: string | null;
  }>): Promise<CandidateListQueryResult> {
    authorize(input.actor);
    const caseId = input.caseId.toLowerCase();
    const limit = input.limit ?? 25;
    if (!UUID.test(caseId) || !REQUEST_ID.test(input.requestId) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    let cursor: CandidateListCursor | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
      try { cursor = decodeCandidateListCursor(input.cursor); }
      catch { invalid(); }
      if (cursor.caseId !== caseId) invalid();
    }
    const result = await this.repository.list({
      organizationId: input.actor.organizationId.toLowerCase(),
      actorUserId: input.actor.userId.toLowerCase(),
      caseId,
      requestId: input.requestId,
      limit,
      cursor,
    });
    const items = Object.freeze([...result.items]);
    const last = items.at(-1);
    return Object.freeze({
      items,
      nextCursor: result.hasMore && last
        ? encodeCandidateListCursor({
          caseId,
          versionNumber: last.versionNumber,
          id: last.id,
        })
        : null,
    });
  }
}

function authorize(actor: RequestAccessActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, "cases.workflow.manage") ||
      (actor.roles?.includes("founder") !== true && actor.roles?.includes("advisor") !== true)) {
    throw new CandidateListQueryError("CANDIDATE_LIST_QUERY_FORBIDDEN");
  }
}

function invalid(): never {
  throw new CandidateListQueryError("CANDIDATE_LIST_QUERY_INVALID");
}
