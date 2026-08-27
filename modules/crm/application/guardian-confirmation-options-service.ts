import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import type { PrimaryGuardianRelationshipType } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GuardianConfirmationOption {
  readonly guardianId: string;
  readonly guardianRelationshipId: string;
  readonly displayName: string;
  readonly relationshipType: PrimaryGuardianRelationshipType;
  readonly relationshipDescription: string | null;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
}

export interface GuardianConfirmationOptionsRepository {
  list(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    studentId: string;
  }>): Promise<readonly GuardianConfirmationOption[]>;
}

export type GuardianConfirmationOptionsErrorCode =
  | "GUARDIAN_CONFIRMATION_OPTIONS_NOT_FOUND"
  | "GUARDIAN_CONFIRMATION_OPTIONS_UNAVAILABLE";

export class GuardianConfirmationOptionsError extends Error {
  readonly code: GuardianConfirmationOptionsErrorCode;
  constructor(code: GuardianConfirmationOptionsErrorCode) {
    super(`Guardian confirmation options rejected ${code}.`);
    this.name = "GuardianConfirmationOptionsError";
    this.code = code;
  }
}

export function isGuardianConfirmationOptionsError(
  value: unknown,
): value is GuardianConfirmationOptionsError {
  return value instanceof Error && value.name === "GuardianConfirmationOptionsError" &&
    new Set<GuardianConfirmationOptionsErrorCode>([
      "GUARDIAN_CONFIRMATION_OPTIONS_NOT_FOUND",
      "GUARDIAN_CONFIRMATION_OPTIONS_UNAVAILABLE",
    ]).has((value as GuardianConfirmationOptionsError).code);
}

export class GuardianConfirmationOptionsService {
  private readonly repository: GuardianConfirmationOptionsRepository;

  constructor(repository: GuardianConfirmationOptionsRepository) {
    this.repository = repository;
  }

  list(input: Readonly<{ actor: RequestAccessActor; studentId: string }>) {
    if (!UUID.test(input.actor.organizationId) || !UUID.test(input.actor.userId) ||
        !UUID.test(input.studentId) || !hasRequestCapability(input.actor, "students.read")) {
      throw new GuardianConfirmationOptionsError("GUARDIAN_CONFIRMATION_OPTIONS_NOT_FOUND");
    }
    return this.repository.list({
      organizationId: input.actor.organizationId.toLowerCase(),
      actorUserId: input.actor.userId.toLowerCase(),
      studentId: input.studentId.toLowerCase(),
    });
  }
}
