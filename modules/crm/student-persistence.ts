import "server-only";

import type { PreparedStudent } from "./service.ts";

export interface StudentPersistenceTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

export async function insertActiveStudent(
  transaction: StudentPersistenceTransaction,
  input: Readonly<{ organizationId: string; student: PreparedStudent }>,
): Promise<void> {
  await transaction.query(
    `INSERT INTO crm_students
      (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')`,
    [
      input.student.studentId,
      input.organizationId,
      input.student.displayName,
      input.student.dateOfBirth,
      input.student.contactEmail,
      input.student.contactPhone,
    ],
  );
}
