import {
  COGNITO_REVOKE_LEASE_MS,
  COGNITO_REVOKE_MAX_ATTEMPTS,
  type IdentityRevokeClock,
  type IdentityRevokeRepository,
  retryAvailableAtMs,
} from "../modules/identity/server.ts";

export interface CognitoRevokeClient {
  revoke(input: {
    readonly requestId: string;
    readonly providerSubject: string;
  }): Promise<{
    readonly status: "revoked" | "denied";
    readonly errorCode: string | null;
    readonly retryable: boolean;
  }>;
}

export interface CognitoReconcileResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/**
 * Bounded worker entry point. Each claimed item carries an optimistic lease;
 * the repository rejects late or concurrent completion attempts.
 */
export async function reconcileCognitoRevokes(input: {
  readonly repository: IdentityRevokeRepository;
  readonly cognito: CognitoRevokeClient;
  readonly clock: IdentityRevokeClock;
  readonly maxJobs: number;
}): Promise<CognitoReconcileResult> {
  if (!Number.isSafeInteger(input.maxJobs) || input.maxJobs < 1 || input.maxJobs > 100) {
    throw new TypeError("maxJobs must be an integer between 1 and 100.");
  }

  let claimed = 0;
  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;

  for (let index = 0; index < input.maxJobs; index += 1) {
    const lease = await input.repository.claimDueCognitoRevoke({
      nowMs: input.clock.nowMs(),
      leaseDurationMs: COGNITO_REVOKE_LEASE_MS,
    });
    if (lease === null) break;
    claimed += 1;

    const attemptedAtMs = input.clock.nowMs();
    try {
      const result = await input.cognito.revoke({
        requestId: `cognito-revoke-${lease.revokeWorkId}`,
        providerSubject: lease.providerSubject,
      });
      if (result.status === "revoked") {
        await input.repository.recordCognitoRevokeDelivered({
          revokeWorkId: lease.revokeWorkId,
          leaseVersion: lease.leaseVersion,
          completedAtMs: attemptedAtMs,
        });
        delivered += 1;
      } else {
        await input.repository.recordCognitoRevokeDeadLetter({
          revokeWorkId: lease.revokeWorkId,
          leaseVersion: lease.leaseVersion,
          completedAtMs: attemptedAtMs,
          errorCode: result.errorCode ?? "COGNITO_REVOKE_DENIED",
        });
        deadLettered += 1;
      }
    } catch (error) {
      const failure = classifyProviderFailure(error);
      const completedAttemptCount = lease.attemptCount + 1;
      if (failure.retryable && completedAttemptCount < COGNITO_REVOKE_MAX_ATTEMPTS) {
        await input.repository.recordCognitoRevokeRetry({
          revokeWorkId: lease.revokeWorkId,
          leaseVersion: lease.leaseVersion,
          attemptedAtMs,
          nextAvailableAtMs: retryAvailableAtMs({ attemptedAtMs, completedAttemptCount }),
          errorCode: failure.code,
        });
        retried += 1;
      } else {
        await input.repository.recordCognitoRevokeDeadLetter({
          revokeWorkId: lease.revokeWorkId,
          leaseVersion: lease.leaseVersion,
          completedAtMs: attemptedAtMs,
          errorCode: failure.code,
        });
        deadLettered += 1;
      }
    }
  }

  return Object.freeze({ claimed, delivered, retried, deadLettered });
}

function classifyProviderFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_:-]{0,127}$/.test(error.code) &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "COGNITO_PROVIDER_ERROR", retryable: false };
}
