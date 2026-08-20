import {
  GuardianRelationshipError,
  GuardianRelationshipRuntimeUnavailable,
} from "@/modules/crm/server";
import {
  IdentityRuntimeUnavailable,
  IdentityServiceError,
} from "@/modules/identity/server";
import { createApiError } from "@/modules/shared/public";

export function mapGuardianRelationshipError(error: unknown) {
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof GuardianRelationshipRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof GuardianRelationshipError)) {
    return createApiError("SERVICE_UNAVAILABLE");
  }

  switch (error.code) {
    case "GUARDIAN_RELATIONSHIP_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND":
    case "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "GUARDIAN_RELATIONSHIP_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "GUARDIAN_RELATIONSHIP_INVALID":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED":
      return createApiError("VALIDATION_FAILED");
  }
}
