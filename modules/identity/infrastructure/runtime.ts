import "server-only";

import { loadAuthMode, type AuthMode } from "./auth-mode.ts";
import {
  findActorBySecret,
  revokeSessionBySecret,
  SessionAccessError,
} from "./postgresql-session-service.ts";
import type { CognitoManagedLoginVerifier } from "../application/cognito-port.ts";
import { CognitoInviteAdapter } from "./cognito-adapter.ts";
import {
  LocalSyntheticLoginService,
} from "./local-synthetic-login.ts";
import { IdentityService, IdentityServiceError } from "../application/service.ts";
import { InMemoryIdentitySessionRepository } from "./in-memory-session-repository.ts";

export type IdentityRuntimeService = Pick<
  IdentityService,
  | "createFounderInvite"
  | "claimInviteActivation"
  | "completeManagedLogin"
  | "requireSession"
  | "revokeSession"
>;

export interface IdentityRuntime {
  readonly authMode: AuthMode;
  readonly service: IdentityRuntimeService;
  readonly managedLoginVerifier: CognitoManagedLoginVerifier | null;
  readonly localLogin: LocalSyntheticLoginService | null;
}

export class IdentityRuntimeUnavailable extends Error {
  constructor() {
    super("Identity runtime is not configured.");
    this.name = "IdentityRuntimeUnavailable";
  }
}

export function getIdentityRuntime(): IdentityRuntime {
  const mode = loadAuthMode();
  return mode === "local-synthetic" ? getLocalSyntheticRuntime() : getCognitoRuntime();
}

const globalForIdentity = globalThis as typeof globalThis & {
  __txLocalSyntheticIdentityRuntime?: IdentityRuntime;
};

function getLocalSyntheticRuntime(): IdentityRuntime {
  if (!globalForIdentity.__txLocalSyntheticIdentityRuntime) {
    const repository = new InMemoryIdentitySessionRepository();
    const service = new IdentityService({
      repository,
      cognito: new CognitoInviteAdapter({
        userPoolId: "ap-east-1_localSynthetic",
        client: {
          async adminCreateUser(request) {
            return { providerSubject: `local_${request.username}` };
          },
        },
      }),
      deliveryChannel: {
        async deliver(input) {
          return {
            channelPolicyId: "hk_dpa_reviewed_transactional",
            receiptReference: `local-${input.inviteId}`,
            deliveredAtMs: Date.now(),
          };
        },
      },
    });
    globalForIdentity.__txLocalSyntheticIdentityRuntime = Object.freeze({
      authMode: "local-synthetic",
      service,
      managedLoginVerifier: null,
      localLogin: new LocalSyntheticLoginService(repository),
    });
  }
  return globalForIdentity.__txLocalSyntheticIdentityRuntime;
}

function getCognitoRuntime(): IdentityRuntime {
  const unavailable = async (): Promise<never> => {
    throw new IdentityRuntimeUnavailable();
  };
  const service: IdentityRuntimeService = {
    createFounderInvite: unavailable,
    claimInviteActivation: unavailable,
    completeManagedLogin: unavailable,
    async requireSession(input) {
      try {
        const actor = await findActorBySecret(
          input.cookieSecret,
          Date.now(),
          input.sensitiveAction,
        );
        return Object.freeze({
          userId: actor.userId,
          organizationId: actor.organizationId,
          role: actor.role,
          sessionId: actor.sessionId,
          capturedSessionVersion: actor.capturedSessionVersion,
          reauthenticatedAtMs: actor.reauthenticatedAt,
        });
      } catch (error) {
        if (error instanceof SessionAccessError) {
          throw new IdentityServiceError("SESSION_NOT_FOUND");
        }
        throw error;
      }
    },
    async revokeSession(input) {
      await revokeSessionBySecret(input.cookieSecret, input.reason);
    },
  };
  return Object.freeze({
    authMode: "cognito",
    service,
    managedLoginVerifier: null,
    localLogin: null,
  });
}
