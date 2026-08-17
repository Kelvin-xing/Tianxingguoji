const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StudentDraft {
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

export interface PreparedStudent extends StudentDraft {
  readonly studentId: string;
  readonly status: "active";
}

export type CrmServiceErrorCode = "STUDENT_DRAFT_INVALID" | "STUDENT_ID_INVALID";

export class CrmServiceError extends Error {
  readonly code: CrmServiceErrorCode;

  constructor(code: CrmServiceErrorCode) {
    super(`CRM service rejected ${code}.`);
    this.name = "CrmServiceError";
    this.code = code;
  }
}

/**
 * CRM owns the shape of a newly captured Student. It deliberately does not
 * decide case authorization, create a case, or assign an access role.
 */
export class CrmService {
  prepareActiveStudent(input: { readonly studentId: string; readonly draft: StudentDraft }): PreparedStudent {
    if (!UUID.test(input.studentId)) throw new CrmServiceError("STUDENT_ID_INVALID");
    assertStudentDraft(input.draft);

    return Object.freeze({
      studentId: input.studentId,
      displayName: input.draft.displayName.trim(),
      dateOfBirth: input.draft.dateOfBirth,
      contactEmail: input.draft.contactEmail,
      contactPhone: input.draft.contactPhone,
      status: "active",
    });
  }
}

function assertStudentDraft(draft: StudentDraft): void {
  if (draft.displayName.trim().length === 0 || draft.displayName.length > 512) {
    throw new CrmServiceError("STUDENT_DRAFT_INVALID");
  }
  if (draft.dateOfBirth !== null && !ISO_DATE.test(draft.dateOfBirth)) {
    throw new CrmServiceError("STUDENT_DRAFT_INVALID");
  }
  if (draft.contactEmail !== null && (draft.contactEmail.trim().length === 0 || draft.contactEmail.length > 320)) {
    throw new CrmServiceError("STUDENT_DRAFT_INVALID");
  }
  if (draft.contactPhone !== null && (draft.contactPhone.trim().length === 0 || draft.contactPhone.length > 64)) {
    throw new CrmServiceError("STUDENT_DRAFT_INVALID");
  }
}
