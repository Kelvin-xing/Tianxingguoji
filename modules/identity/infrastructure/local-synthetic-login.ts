import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import type { OrganizationRole } from "../../access/public.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import { hashOpaqueSecret } from "../application/opaque-secret.ts";
import type { LocalSyntheticSessionRepository } from "../application/session-port.ts";

export const LOCAL_SYNTHETIC_ROLES = [
  "founder",
  "admin",
  "advisor",
  "data_reviewer",
  "contractor",
] as const satisfies readonly OrganizationRole[];

export type LocalSyntheticRole = (typeof LOCAL_SYNTHETIC_ROLES)[number];

export interface LocalSyntheticSession {
  readonly cookieSecret: string;
  readonly actor: IdentitySessionActor;
}

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_IDS: Readonly<Record<LocalSyntheticRole, string>> = Object.freeze({
  founder: "10000000-0000-4000-8000-000000000101",
  admin: "10000000-0000-4000-8000-000000000102",
  advisor: "10000000-0000-4000-8000-000000000103",
  data_reviewer: "10000000-0000-4000-8000-000000000104",
  contractor: "10000000-0000-4000-8000-000000000105",
});

export class LocalSyntheticLoginService {
  private readonly repository: LocalSyntheticSessionRepository;

  constructor(repository: LocalSyntheticSessionRepository) {
    this.repository = repository;
  }

  async createSession(role: unknown): Promise<LocalSyntheticSession> {
    if (!isLocalSyntheticRole(role)) {
      throw new TypeError("Local synthetic login requires an approved role.");
    }
    const cookieSecret = randomBytes(32).toString("base64url");
    const actor = await this.repository.createLocalSyntheticSession({
      userId: USER_IDS[role],
      organizationId: ORGANIZATION_ID,
      role,
      sessionId: randomUUID(),
      secretHash: hashOpaqueSecret(cookieSecret),
      nowMs: Date.now(),
    });
    return Object.freeze({ cookieSecret, actor });
  }
}

export function isLocalSyntheticRole(value: unknown): value is LocalSyntheticRole {
  return typeof value === "string" && (LOCAL_SYNTHETIC_ROLES as readonly string[]).includes(value);
}
