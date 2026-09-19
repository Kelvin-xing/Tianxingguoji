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
import {
  getLocalTrialDemoPrincipal,
  LOCAL_TRIAL_DEMO_ORGANIZATION,
} from "./local-trial-demo-principals.ts";

export const LOCAL_SYNTHETIC_ROLES = [
  "founder",
  "admin",
  "advisor",
  "contractor",
  "l1",
  "l2_international",
  "l2_local",
  "l3",
] as const;

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
    const trialDemoLogin = isTrialDemoLoginRole(role);
    const principal = trialDemoLogin
      ? getLocalTrialDemoPrincipal(role)
      : getLocalSyntheticPrincipal(role as OrganizationRole);
    const cookieSecret = randomBytes(32).toString("base64url");
    const actor = await this.repository.createLocalSyntheticSession({
      userId: principal.userId,
      organizationId: trialDemoLogin
        ? LOCAL_TRIAL_DEMO_ORGANIZATION.id
        : LOCAL_SYNTHETIC_ORGANIZATION.id,
      role: principal.role,
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

function isTrialDemoLoginRole(value: LocalSyntheticRole): value is "l1" | "l2_international" | "l2_local" | "l3" {
  return value === "l1" || value === "l2_international" || value === "l2_local" || value === "l3";
}
