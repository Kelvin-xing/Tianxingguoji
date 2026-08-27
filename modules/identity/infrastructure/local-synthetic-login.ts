import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import type { OrganizationRole } from "../../access/public.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import { hashOpaqueSecret } from "../application/opaque-secret.ts";
import type { LocalSyntheticSessionRepository } from "../application/session-port.ts";
import {
  getLocalSyntheticPrincipal,
  LOCAL_SYNTHETIC_ORGANIZATION,
} from "./local-synthetic-principals.ts";

export const LOCAL_SYNTHETIC_ROLES = [
  "founder",
  "admin",
  "advisor",
  "contractor",
] as const satisfies readonly OrganizationRole[];

export type LocalSyntheticRole = (typeof LOCAL_SYNTHETIC_ROLES)[number];

export interface LocalSyntheticSession {
  readonly cookieSecret: string;
  readonly actor: IdentitySessionActor;
}

export class LocalSyntheticLoginService {
  private readonly repository: LocalSyntheticSessionRepository;

  constructor(repository: LocalSyntheticSessionRepository) {
    this.repository = repository;
  }

  async createSession(role: unknown): Promise<LocalSyntheticSession> {
    if (!isLocalSyntheticRole(role)) {
      throw new TypeError("Local synthetic login requires an approved role.");
    }
    const principal = getLocalSyntheticPrincipal(role);
    const cookieSecret = randomBytes(32).toString("base64url");
    const actor = await this.repository.createLocalSyntheticSession({
      userId: principal.userId,
      organizationId: LOCAL_SYNTHETIC_ORGANIZATION.id,
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
