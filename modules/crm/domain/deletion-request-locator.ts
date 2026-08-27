import "server-only";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = "del_v1_";

export type DeletionLocatorEntityType = "student" | "guardian";

export function encodeDeletionRequestLocator(entityType: DeletionLocatorEntityType, entityId: string): string {
  if (!UUID.test(entityId)) throw new Error("DELETION_LOCATOR_INVALID");
  return PREFIX + Buffer.from(`v1:${entityType}:${entityId.toLowerCase()}`, "utf8").toString("base64url");
}

export function decodeDeletionRequestLocator(value: string): Readonly<{ entityType: DeletionLocatorEntityType; entityId: string }> {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) throw new Error("DELETION_LOCATOR_INVALID");
  let decoded: string;
  try { decoded = Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8"); } catch { throw new Error("DELETION_LOCATOR_INVALID"); }
  const match = /^v1:(student|guardian):([0-9a-f-]+)$/.exec(decoded);
  if (!match || !UUID.test(match[2]!) || encodeDeletionRequestLocator(match[1] as DeletionLocatorEntityType, match[2]!) !== value) throw new Error("DELETION_LOCATOR_INVALID");
  return Object.freeze({ entityType: match[1] as DeletionLocatorEntityType, entityId: match[2]! });
}
