import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getGuardianRelationshipRuntime } from "@/modules/crm/server";
import { handleApiRequest } from "@/modules/shared/public";
import { mapGuardianRelationshipError } from "../../guardians/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ studentId: string }> }) {
  return handleApiRequest(request, async () => {
    try {
      const { studentId } = await context.params;
      const actor = await requireApiRequestAccessContext();
      const view = await getGuardianRelationshipRuntime().service.listHistory(actor, studentId);
      return {
        student: { id: view.student.id, display_name: view.student.displayName },
        relationships: view.relationships.map(({ relationship, guardian }) => ({
          relationship: {
            id: relationship.relationshipId, student_id: relationship.studentId,
            guardian_id: relationship.guardianId, relationship_type: relationship.relationshipType,
            relationship_description: relationship.relationshipDescription ?? null,
            is_legal_guardian: relationship.isLegalGuardian,
            is_primary_contact: relationship.isPrimaryContact,
            is_emergency_contact: relationship.isEmergencyContact,
            is_billing_contact: relationship.isBillingContact,
            notification_consent: relationship.notificationConsent,
            starts_at: relationship.startsAt, ends_at: relationship.endsAt ?? null,
            record_version: relationship.recordVersion,
          },
          guardian: { id: guardian.id, display_name: guardian.displayName,
            email_hint: guardian.emailHint, phone_hint: guardian.phoneHint },
        })),
      };
    } catch (error) {
      throw mapGuardianRelationshipError(error);
    }
  });
}
