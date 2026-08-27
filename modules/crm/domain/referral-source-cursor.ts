import "server-only";

const PREFIX = "rs_v1_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ReferralSourceCursor {
  readonly displayName: string;
  readonly id: string;
  readonly filterHash: string;
}

export function encodeReferralSourceCursor(input: ReferralSourceCursor): string {
  const displayName = input.displayName.trim().normalize("NFKC");
  const id = input.id.toLowerCase();
  if (!displayName || !UUID.test(id) || !/^[a-f0-9]{64}$/.test(input.filterHash)) {
    throw new TypeError("Invalid referral source cursor.");
  }
  const payload = JSON.stringify(["v1", displayName, id, input.filterHash]);
  return `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeReferralSourceCursor(value: unknown): ReferralSourceCursor {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) {
    throw new TypeError("Invalid referral source cursor.");
  }
  const encoded = value.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError("Invalid referral source cursor.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid referral source cursor.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== "v1" ||
      typeof parsed[1] !== "string" || typeof parsed[2] !== "string" ||
      typeof parsed[3] !== "string") {
    throw new TypeError("Invalid referral source cursor.");
  }
  const displayName = parsed[1].trim().normalize("NFKC");
  const id = parsed[2].toLowerCase();
  const filterHash = parsed[3];
  if (displayName !== parsed[1] || id !== parsed[2] || !displayName || !UUID.test(id) ||
      !/^[a-f0-9]{64}$/.test(filterHash)) {
    throw new TypeError("Invalid referral source cursor.");
  }
  const canonical = encodeReferralSourceCursor({ displayName, id, filterHash });
  if (canonical !== value) throw new TypeError("Invalid referral source cursor.");
  return Object.freeze({ displayName, id, filterHash });
}
