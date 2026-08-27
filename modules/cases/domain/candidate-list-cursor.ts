import "server-only";

const PREFIX = "cl_v1_";
const SORT = "version_number_desc_id_asc" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CandidateListCursor {
  readonly caseId: string;
  readonly versionNumber: number;
  readonly id: string;
  readonly sort: typeof SORT;
}

export function encodeCandidateListCursor(input: Omit<CandidateListCursor, "sort">): string {
  const caseId = input.caseId.toLowerCase();
  const id = input.id.toLowerCase();
  if (!UUID.test(caseId) || !UUID.test(id) ||
      !Number.isSafeInteger(input.versionNumber) || input.versionNumber < 1) {
    throw new TypeError("Invalid candidate list cursor.");
  }
  const payload = JSON.stringify(["v1", caseId, SORT, input.versionNumber, id]);
  return `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeCandidateListCursor(value: unknown): CandidateListCursor {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) {
    throw new TypeError("Invalid candidate list cursor.");
  }
  const encoded = value.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("Invalid candidate list cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid candidate list cursor.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== "v1" ||
      typeof parsed[1] !== "string" || parsed[2] !== SORT ||
      typeof parsed[3] !== "number" || typeof parsed[4] !== "string") {
    throw new TypeError("Invalid candidate list cursor.");
  }
  const caseId = parsed[1].toLowerCase();
  const versionNumber = parsed[3];
  const id = parsed[4].toLowerCase();
  if (caseId !== parsed[1] || id !== parsed[4] || !UUID.test(caseId) || !UUID.test(id) ||
      !Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new TypeError("Invalid candidate list cursor.");
  }
  if (encodeCandidateListCursor({ caseId, versionNumber, id }) !== value) {
    throw new TypeError("Invalid candidate list cursor.");
  }
  return Object.freeze({ caseId, versionNumber, id, sort: SORT });
}
