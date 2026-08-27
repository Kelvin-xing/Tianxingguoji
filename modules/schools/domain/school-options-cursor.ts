import "server-only";

const PREFIX = "so_v1_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface SchoolOptionsCursor {
  readonly displayName: string;
  readonly schoolId: string;
  readonly filterHash: string;
}

export function encodeSchoolOptionsCursor(input: SchoolOptionsCursor): string {
  const displayName = input.displayName.trim().normalize("NFKC");
  const schoolId = input.schoolId.toLowerCase();
  if (!displayName || !UUID.test(schoolId) || !SHA256.test(input.filterHash)) {
    throw new TypeError("Invalid School options cursor.");
  }
  const payload = JSON.stringify(["v1", displayName, schoolId, input.filterHash]);
  return `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeSchoolOptionsCursor(value: unknown): SchoolOptionsCursor {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) {
    throw new TypeError("Invalid School options cursor.");
  }
  const encoded = value.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("Invalid School options cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid School options cursor.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== "v1" ||
      typeof parsed[1] !== "string" || typeof parsed[2] !== "string" ||
      typeof parsed[3] !== "string") {
    throw new TypeError("Invalid School options cursor.");
  }
  const displayName = parsed[1].trim().normalize("NFKC");
  const schoolId = parsed[2].toLowerCase();
  const filterHash = parsed[3];
  if (displayName !== parsed[1] || schoolId !== parsed[2] || !displayName ||
      !UUID.test(schoolId) || !SHA256.test(filterHash)) {
    throw new TypeError("Invalid School options cursor.");
  }
  const canonical = encodeSchoolOptionsCursor({ displayName, schoolId, filterHash });
  if (canonical !== value) throw new TypeError("Invalid School options cursor.");
  return Object.freeze({ displayName, schoolId, filterHash });
}
