import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import {
  decodeSchoolOptionsCursor,
  encodeSchoolOptionsCursor,
  type SchoolOptionsCursor,
} from "../domain/school-options-cursor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SchoolOptionView {
  readonly schoolId: string;
  readonly displayName: string;
  readonly resolvedRevisionId: string;
  readonly resolutionSha256: string;
}

export interface SchoolOptionsRepository {
  list(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    query: string | null;
    limit: number;
    cursor: SchoolOptionsCursor | null;
  }>): Promise<Readonly<{ items: readonly SchoolOptionView[]; hasMore: boolean }>>;
}

export type SchoolOptionsErrorCode =
  | "SCHOOL_OPTIONS_INVALID"
  | "SCHOOL_OPTIONS_FORBIDDEN"
  | "SCHOOL_OPTIONS_UNAVAILABLE";

export class SchoolOptionsError extends Error {
  readonly code: SchoolOptionsErrorCode;
  constructor(code: SchoolOptionsErrorCode) {
    super(`School options rejected ${code}.`);
    this.name = "SchoolOptionsError";
    this.code = code;
  }
}

export function isSchoolOptionsError(value: unknown): value is SchoolOptionsError {
  return value instanceof Error && value.name === "SchoolOptionsError" &&
    new Set<SchoolOptionsErrorCode>([
      "SCHOOL_OPTIONS_INVALID", "SCHOOL_OPTIONS_FORBIDDEN", "SCHOOL_OPTIONS_UNAVAILABLE",
    ]).has((value as SchoolOptionsError).code);
}

export class SchoolOptionsService {
  private readonly repository: SchoolOptionsRepository;

  constructor(repository: SchoolOptionsRepository) {
    this.repository = repository;
  }

  async list(input: Readonly<{
    actor: RequestAccessActor;
    query?: string | null;
    limit?: number;
    cursor?: string | null;
  }>) {
    authorize(input.actor);
    const query = normalizeQuery(input.query);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    const filterHash = hashRequestPayload({
      organization_id: input.actor.organizationId.toLowerCase(),
      q: query,
      sort: "display_name_c_school_id_asc",
    });
    let cursor: SchoolOptionsCursor | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
      try { cursor = decodeSchoolOptionsCursor(input.cursor); } catch { invalid(); }
      if (cursor.filterHash !== filterHash) invalid();
    }
    const result = await this.repository.list({
      organizationId: input.actor.organizationId.toLowerCase(),
      actorUserId: input.actor.userId.toLowerCase(),
      query,
      limit,
      cursor,
    });
    const items = Object.freeze([...result.items]);
    const last = items.at(-1);
    return Object.freeze({
      items,
      nextCursor: result.hasMore && last ? encodeSchoolOptionsCursor({
        displayName: last.displayName,
        schoolId: last.schoolId,
        filterHash,
      }) : null,
    });
  }
}

function authorize(actor: RequestAccessActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, "schools.read") ||
      (actor.roles?.includes("founder") !== true && actor.roles?.includes("advisor") !== true)) {
    throw new SchoolOptionsError("SCHOOL_OPTIONS_FORBIDDEN");
  }
}

function normalizeQuery(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().normalize("NFKC");
  if (normalized.length < 1 || normalized.length > 100) invalid();
  return normalized;
}

function invalid(): never {
  throw new SchoolOptionsError("SCHOOL_OPTIONS_INVALID");
}
