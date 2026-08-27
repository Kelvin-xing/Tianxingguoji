import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import type { CrmGender } from "../domain/approved-p2-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StudentListItem {
  readonly id: string;
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly gender: CrmGender | null;
  readonly status: "active" | "pending_delete";
  readonly primaryGuardianName: string | null;
  readonly updatedAt: string;
}

export interface StudentGuardianItem {
  readonly id: string;
  readonly displayName: string;
  readonly status: "active" | "pending_delete";
  readonly email: string | null;
  readonly phone: string | null;
  readonly dateOfBirth: string | null;
  readonly gender: CrmGender | null;
  readonly recordVersion: number;
  readonly relationshipType: string;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
}

export interface StudentDetail extends StudentListItem {
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly recordVersion: number;
  readonly guardians: readonly StudentGuardianItem[];
}

export interface StudentReadRepository {
  listStudents(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
  }): Promise<readonly StudentListItem[]>;
  findStudent(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
  }): Promise<StudentDetail | null>;
}

export type StudentReadErrorCode = "STUDENT_READ_FORBIDDEN" | "STUDENT_ID_INVALID";

export class StudentReadError extends Error {
  readonly code: StudentReadErrorCode;

  constructor(code: StudentReadErrorCode) {
    super(`Student read rejected ${code}.`);
    this.name = "StudentReadError";
    this.code = code;
  }
}

const STUDENT_READ_ERROR_CODES = new Set<StudentReadErrorCode>([
  "STUDENT_READ_FORBIDDEN",
  "STUDENT_ID_INVALID",
]);

export function isStudentReadError(
  error: unknown,
  code?: StudentReadErrorCode,
): error is StudentReadError {
  if (!(error instanceof Error) || error.name !== "StudentReadError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  if (
    typeof candidate !== "string" ||
    !STUDENT_READ_ERROR_CODES.has(candidate as StudentReadErrorCode)
  ) {
    return false;
  }
  return code === undefined || candidate === code;
}

export class StudentReadService {
  private readonly repository: StudentReadRepository;

  constructor(repository: StudentReadRepository) {
    this.repository = repository;
  }

  listStudents(actor: RequestAccessActor): Promise<readonly StudentListItem[]> {
    assertReader(actor);
    return this.repository.listStudents({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
    });
  }

  findStudent(actor: RequestAccessActor, studentId: string): Promise<StudentDetail | null> {
    assertReader(actor);
    if (!UUID.test(studentId)) throw new StudentReadError("STUDENT_ID_INVALID");
    return this.repository.findStudent({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      studentId,
    });
  }
}

function assertReader(actor: RequestAccessActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, "students.read")) {
    throw new StudentReadError("STUDENT_READ_FORBIDDEN");
  }
}
