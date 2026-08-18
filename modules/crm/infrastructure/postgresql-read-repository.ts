import "server-only";

import type {
  StudentDetail,
  StudentListItem,
  StudentReadRepository,
} from "../application/read-service.ts";
import type { TenantTransactionRunner } from "../../shared/server.ts";

interface StudentRow {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  status: "active" | "pending_delete";
  primary_guardian_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  updated_at: Date | string;
}

interface GuardianRow {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  relationship_type: string;
  is_legal_guardian: boolean;
  is_primary_contact: boolean;
  is_emergency_contact: boolean;
  is_billing_contact: boolean;
  notification_consent: boolean;
}

export class PostgresqlStudentReadRepository implements StudentReadRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  listStudents(input: Parameters<StudentReadRepository["listStudents"]>[0]) {
    return this.runner.run(input, async (transaction) => {
      const result = await transaction.query<StudentRow>({
        text: studentSelect(`student.status <> 'purged'`) + " ORDER BY student.display_name, student.id",
      });
      return Object.freeze(result.rows.map(toListItem));
    });
  }

  findStudent(input: Parameters<StudentReadRepository["findStudent"]>[0]) {
    return this.runner.run(input, async (transaction) => {
      const studentResult = await transaction.query<StudentRow>({
        text: studentSelect("student.id = $1 AND student.status <> 'purged'"),
        values: [input.studentId],
      });
      const student = studentResult.rows[0];
      if (!student) return null;

      const guardianResult = await transaction.query<GuardianRow>({
        text: `SELECT guardian.id, guardian.display_name, guardian.email, guardian.phone,
                      relationship.relationship_type, relationship.is_legal_guardian,
                      relationship.is_primary_contact, relationship.is_emergency_contact,
                      relationship.is_billing_contact, relationship.notification_consent
                 FROM crm_student_guardian_relationships AS relationship
                 JOIN crm_guardians AS guardian
                   ON guardian.id = relationship.guardian_id
                  AND guardian.organization_id = relationship.organization_id
                WHERE relationship.student_id = $1
                  AND relationship.ends_at IS NULL
                  AND guardian.status = 'active'
                ORDER BY relationship.is_primary_contact DESC, guardian.display_name, guardian.id`,
        values: [input.studentId],
      });
      return Object.freeze({
        ...toListItem(student),
        contactEmail: student.contact_email,
        contactPhone: student.contact_phone,
        guardians: Object.freeze(guardianResult.rows.map((row) => Object.freeze({
          id: row.id,
          displayName: row.display_name,
          email: row.email,
          phone: row.phone,
          relationshipType: row.relationship_type,
          isLegalGuardian: row.is_legal_guardian,
          isPrimaryContact: row.is_primary_contact,
          isEmergencyContact: row.is_emergency_contact,
          isBillingContact: row.is_billing_contact,
          notificationConsent: row.notification_consent,
        }))),
      }) satisfies StudentDetail;
    });
  }
}

function studentSelect(condition: string): string {
  return `SELECT student.id, student.display_name, student.date_of_birth::text,
                 student.status, student.contact_email, student.contact_phone,
                 student.updated_at, primary_guardian.display_name AS primary_guardian_name
            FROM crm_students AS student
            LEFT JOIN LATERAL (
              SELECT guardian.display_name
                FROM crm_student_guardian_relationships AS relationship
                JOIN crm_guardians AS guardian
                  ON guardian.id = relationship.guardian_id
                 AND guardian.organization_id = relationship.organization_id
               WHERE relationship.student_id = student.id
                 AND relationship.organization_id = student.organization_id
                 AND relationship.is_primary_contact
                 AND relationship.ends_at IS NULL
                 AND guardian.status = 'active'
               LIMIT 1
            ) AS primary_guardian ON true
           WHERE ${condition}`;
}

function toListItem(row: StudentRow): StudentListItem {
  return Object.freeze({
    id: row.id,
    displayName: row.display_name,
    dateOfBirth: row.date_of_birth,
    status: row.status,
    primaryGuardianName: row.primary_guardian_name,
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}
