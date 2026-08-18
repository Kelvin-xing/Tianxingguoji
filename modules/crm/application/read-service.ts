import type { IdentitySessionActor } from "../../identity/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_ROLES = new Set(["founder", "admin", "advisor"]);

export interface StudentListItem {
  readonly id: string;
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly status: "active" | "pending_delete";
  readonly primaryGuardianName: string | null;
  readonly updatedAt: string;
}

export interface StudentGuardianItem {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
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

export class StudentReadService {
  private readonly repository: StudentReadRepository;

  constructor(repository: StudentReadRepository) {
    this.repository = repository;
  }

  listStudents(actor: IdentitySessionActor): Promise<readonly StudentListItem[]> {
    assertReader(actor);
    return this.repository.listStudents({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
    });
  }

  findStudent(actor: IdentitySessionActor, studentId: string): Promise<StudentDetail | null> {
    assertReader(actor);
    if (!UUID.test(studentId)) throw new StudentReadError("STUDENT_ID_INVALID");
    return this.repository.findStudent({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      studentId,
    });
  }
}

function assertReader(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !READ_ROLES.has(actor.role)) {
    throw new StudentReadError("STUDENT_READ_FORBIDDEN");
  }
}
