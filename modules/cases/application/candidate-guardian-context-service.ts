import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CandidateGuardianContextRepository {
  find(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    caseId: string;
  }>): Promise<Readonly<{ caseId: string; studentId: string }> | null>;
}

export type CandidateGuardianContextErrorCode =
  | "CANDIDATE_GUARDIAN_CONTEXT_INVALID"
  | "CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND"
  | "CANDIDATE_GUARDIAN_CONTEXT_UNAVAILABLE";

export class CandidateGuardianContextError extends Error {
  readonly code: CandidateGuardianContextErrorCode;
  constructor(code: CandidateGuardianContextErrorCode) {
    super(`Candidate Guardian context rejected ${code}.`);
    this.name = "CandidateGuardianContextError";
    this.code = code;
  }
}

export function isCandidateGuardianContextError(value: unknown): value is CandidateGuardianContextError {
  return value instanceof Error && value.name === "CandidateGuardianContextError" &&
    new Set<CandidateGuardianContextErrorCode>([
      "CANDIDATE_GUARDIAN_CONTEXT_INVALID", "CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND",
      "CANDIDATE_GUARDIAN_CONTEXT_UNAVAILABLE",
    ]).has((value as CandidateGuardianContextError).code);
}

export class CandidateGuardianContextService {
  private readonly repository: CandidateGuardianContextRepository;

  constructor(repository: CandidateGuardianContextRepository) {
    this.repository = repository;
  }

  async resolve(input: Readonly<{ actor: RequestAccessActor; caseId: string }>) {
    if (!UUID.test(input.caseId)) {
      throw new CandidateGuardianContextError("CANDIDATE_GUARDIAN_CONTEXT_INVALID");
    }
    if (!UUID.test(input.actor.organizationId) || !UUID.test(input.actor.userId) ||
        !hasRequestCapability(input.actor, "cases.workflow.manage") ||
        input.actor.roles?.includes("advisor") !== true) {
      throw new CandidateGuardianContextError("CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND");
    }
    const result = await this.repository.find({
      organizationId: input.actor.organizationId.toLowerCase(),
      actorUserId: input.actor.userId.toLowerCase(),
      caseId: input.caseId.toLowerCase(),
    });
    if (!result) throw new CandidateGuardianContextError("CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND");
    return result;
  }
}
