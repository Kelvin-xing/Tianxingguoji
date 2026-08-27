import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import {
  CandidateGuardianContextRuntimeUnavailable,
  getCandidateGuardianContextRuntime,
  isCandidateGuardianContextError,
} from "@/modules/cases/server";
import {
  getGuardianConfirmationOptionsRuntime,
  GuardianConfirmationOptionsRuntimeUnavailable,
  isGuardianConfirmationOptionsError,
} from "@/modules/crm/server";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: {
  readonly params: Promise<{ readonly caseId: string }>;
}): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { caseId } = await context.params;
      const actor = await requireApiRequestAccessContext();
      const candidateContext = await getCandidateGuardianContextRuntime().service.resolve({
        actor,caseId,
      });
      const items = await getGuardianConfirmationOptionsRuntime().service.list({
        actor,studentId: candidateContext.studentId,
      });
      return {
        items: items.map((item) => ({
          guardian_id: item.guardianId,
          guardian_relationship_id: item.guardianRelationshipId,
          display_name: item.displayName,
          relationship_type: item.relationshipType,
          relationship_description: item.relationshipDescription,
          is_legal_guardian: item.isLegalGuardian,
          is_primary_contact: item.isPrimaryContact,
        })),
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof CandidateGuardianContextRuntimeUnavailable ||
          error instanceof GuardianConfirmationOptionsRuntimeUnavailable) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      if (isGuardianConfirmationOptionsError(error)) {
        if (error.code === "GUARDIAN_CONFIRMATION_OPTIONS_NOT_FOUND") {
          throw createApiError("NOT_FOUND");
        }
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      if (isCandidateGuardianContextError(error)) {
        if (error.code === "CANDIDATE_GUARDIAN_CONTEXT_INVALID") {
          throw createApiError("INVALID_REQUEST");
        }
        if (error.code === "CANDIDATE_GUARDIAN_CONTEXT_NOT_FOUND") {
          throw createApiError("NOT_FOUND");
        }
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}
