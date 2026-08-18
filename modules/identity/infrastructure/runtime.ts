import "server-only";

import { loadAuthMode, type AuthMode } from "./auth-mode.ts";
import {
  findActorBySecret,
  revokeSessionBySecret,
  SessionAccessError,
  type SessionActor,
} from "./postgresql-session-service.ts";
import type { CognitoManagedLoginVerifier } from "../application/cognito-port.ts";
import {
  LocalSyntheticLoginService,
} from "./local-synthetic-login.ts";
import { IdentityServiceError, type IdentityService } from "../application/service.ts";
import { IdentityRepositoryError } from "../application/session-port.ts";
import { hashOpaqueSecret } from "../application/opaque-secret.ts";
import { loadLocalSyntheticConfig } from "../../../lib/runtime/local-synthetic-config.ts";
import {
  getPostgresqlLocalSyntheticSessionRepository,
} from "./postgresql-local-synthetic-repository.ts";

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
  readonly legacySessionReader: Readonly<{
    findByCookieSecret(cookieSecret: string): Promise<SessionActor>;
  }>;
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
    const config = loadLocalSyntheticConfig();
    const repository = getPostgresqlLocalSyntheticSessionRepository(
      config.database.identityConnectionString,
      config.dependencyTimeoutMs,
    );
    const unavailable = async (): Promise<never> => {
      throw new IdentityRuntimeUnavailable();
    };
    const service: IdentityRuntimeService = {
      createFounderInvite: unavailable,
      claimInviteActivation: unavailable,
      completeManagedLogin: unavailable,
      async requireSession(input) {
        try {
          return await repository.findActorBySessionSecretHash({
            secretHash: hashOpaqueSecret(input.cookieSecret),
            nowMs: Date.now(),
            sensitiveAction: input.sensitiveAction,
          });
        } catch (error) {
          if (error instanceof IdentityRepositoryError) {
            throw new IdentityServiceError("SESSION_NOT_FOUND");
          }
          throw error;
        }
      },
      async revokeSession(input) {
        await repository.revokeSessionBySecretHash({
          secretHash: hashOpaqueSecret(input.cookieSecret),
          reason: input.reason,
        });
      },
    };
    globalForIdentity.__txLocalSyntheticIdentityRuntime = Object.freeze({
      authMode: "local-synthetic",
      service,
      managedLoginVerifier: null,
      localLogin: new LocalSyntheticLoginService(repository),
      legacySessionReader: Object.freeze({
        async findByCookieSecret(cookieSecret: string) {
          try {
            return await repository.findLegacyActorBySessionSecretHash({
              secretHash: hashOpaqueSecret(cookieSecret),
              nowMs: Date.now(),
              sensitiveAction: false,
            });
          } catch (error) {
            if (error instanceof IdentityRepositoryError) {
              throw new IdentityServiceError("SESSION_NOT_FOUND");
            }
            throw error;
          }
        },
      }),
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
    legacySessionReader: Object.freeze({
      findByCookieSecret: findActorBySecret,
    }),
  });
}
