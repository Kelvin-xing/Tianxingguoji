import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import {
  GuardianConfirmationOptionsError,
  type GuardianConfirmationOption,
  type GuardianConfirmationOptionsRepository,
} from "../application/guardian-confirmation-options-service.ts";
import { isPrimaryGuardianRelationshipType } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OptionRow extends Record<string, unknown> {
  readonly guardian_id: string;
  readonly guardian_relationship_id: string;
  readonly display_name: string;
  readonly relationship_type: string;
  readonly relationship_description: string | null;
  readonly is_legal_guardian: boolean;
  readonly is_primary_contact: boolean;
}

export class PostgresqlGuardianConfirmationOptionsRepository
implements GuardianConfirmationOptionsRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  list(input: Parameters<GuardianConfirmationOptionsRepository["list"]>[0]) {
    return this.runner.run({
      organizationId: input.organizationId,
      actorKind: "user",
      actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId,
      requestId: `guardian-confirmation-options-${input.studentId}`,
    }, async (transaction) => {
      try {
        const result = await transaction.query<OptionRow>({
          text: `SELECT guardian.id AS guardian_id,relationship.id AS guardian_relationship_id,
                        guardian.display_name,relationship.relationship_type,
                        relationship.relationship_description,relationship.is_legal_guardian,
                        relationship.is_primary_contact
                   FROM crm_student_guardian_relationships AS relationship
                   JOIN crm_guardians AS guardian
                     ON guardian.id=relationship.guardian_id
                    AND guardian.organization_id=relationship.organization_id
                  WHERE relationship.organization_id=$1 AND relationship.student_id=$2
                    AND relationship.ends_at IS NULL AND guardian.status='active'
                  ORDER BY relationship.is_primary_contact DESC,relationship.starts_at,
                           relationship.id::text COLLATE "C" ASC`,
          values: [input.organizationId,input.studentId],
        });
        return Object.freeze(result.rows.map(toView));
      } catch (error) {
        if (error instanceof GuardianConfirmationOptionsError) throw error;
        throw new GuardianConfirmationOptionsError("GUARDIAN_CONFIRMATION_OPTIONS_UNAVAILABLE");
      }
    });
  }
}

function toView(row: OptionRow): GuardianConfirmationOption {
  const guardianId = row.guardian_id?.toLowerCase();
  const guardianRelationshipId = row.guardian_relationship_id?.toLowerCase();
  const displayName = row.display_name?.trim();
  if (!UUID.test(guardianId) || !UUID.test(guardianRelationshipId) || !displayName ||
      !isPrimaryGuardianRelationshipType(row.relationship_type) ||
      typeof row.is_legal_guardian !== "boolean" || typeof row.is_primary_contact !== "boolean" ||
      (row.relationship_description !== null &&
        (typeof row.relationship_description !== "string" || !row.relationship_description.trim()))) {
    throw new GuardianConfirmationOptionsError("GUARDIAN_CONFIRMATION_OPTIONS_UNAVAILABLE");
  }
  return Object.freeze({
    guardianId,
    guardianRelationshipId,
    displayName,
    relationshipType: row.relationship_type,
    relationshipDescription: row.relationship_description?.trim() ?? null,
    isLegalGuardian: row.is_legal_guardian,
    isPrimaryContact: row.is_primary_contact,
  });
}
