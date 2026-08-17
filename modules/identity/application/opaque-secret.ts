import { createHash } from "node:crypto";

export function hashOpaqueSecret(secret: string): string {
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== 32) throw new TypeError("Opaque secret must contain exactly 32 bytes.");
  return createHash("sha256").update(bytes).digest("hex");
}
