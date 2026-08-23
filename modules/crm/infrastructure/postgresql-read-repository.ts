import "server-only";

import type {
  StudentDetail,
  StudentListItem,
  StudentReadRepository,
} from "../application/read-service.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

interface StudentRow {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  status: "active" | "pending_delete";
  primary_guardian_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  updated_at: Date | string;
  record_version: number | string;
}

interface GuardianRow {
  id: string;
  display_name: string;
  status: "active" | "pending_delete";
  email: string | null;
  phone: string | null;
  relationship_type: string;
  is_legal_guardian: boolean;
  is_primary_contact: boolean;
  is_emergency_contact: boolean;
  is_billing_contact: boolean;
  notification_consent: boolean;
  record_version: number | string;
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
      const resolvedStudent = await resolveDuplicateProfile(transaction, "student", input.studentId);
      const studentResult = await transaction.query<StudentRow>({
        text: studentSelect("student.id = $1 AND student.status <> 'purged'"),
        values: [resolvedStudent?.id ?? input.studentId],
      });
      const storedStudent = studentResult.rows[0];
      const student = storedStudent && resolvedStudent ? { ...storedStudent,
        id: resolvedStudent.id, display_name: resolvedStudent.displayName,
        date_of_birth: resolvedStudent.dateOfBirth, contact_email: resolvedStudent.contactEmail,
        contact_phone: resolvedStudent.contactPhone } : storedStudent;
      if (!student) return null;

      const guardianResult = await transaction.query<GuardianRow>({
        text: `SELECT guardian.id, guardian.display_name, guardian.status, guardian.email, guardian.phone,
                      relationship.relationship_type, relationship.is_legal_guardian,
                      relationship.is_primary_contact, relationship.is_emergency_contact,
                      relationship.is_billing_contact, relationship.notification_consent,
                      guardian.record_version
                 FROM crm_student_guardian_relationships AS relationship
                 JOIN crm_guardians AS guardian
                   ON guardian.id = relationship.guardian_id
                  AND guardian.organization_id = relationship.organization_id
                WHERE relationship.student_id = $1
                  AND relationship.ends_at IS NULL
                  AND guardian.status <> 'purged'
                ORDER BY relationship.is_primary_contact DESC, guardian.display_name, guardian.id`,
        values: [student.id],
      });
      const guardians: StudentDetail["guardians"][number][] = [];
      for (const row of guardianResult.rows) {
        const resolved = await resolveDuplicateProfile(transaction, "guardian", row.id);
        guardians.push(Object.freeze({
          id: resolved?.id ?? row.id,
          displayName: resolved?.displayName ?? row.display_name,
          status: resolved?.status ?? row.status,
          email: resolved?.email ?? row.email,
          phone: resolved?.phone ?? row.phone,
          recordVersion: resolved?.recordVersion ?? toVersion(row.record_version),
          relationshipType: row.relationship_type,
          isLegalGuardian: row.is_legal_guardian,
          isPrimaryContact: row.is_primary_contact,
          isEmergencyContact: row.is_emergency_contact,
          isBillingContact: row.is_billing_contact,
          notificationConsent: row.notification_consent,
        }));
      }
      return Object.freeze({
        ...toListItem(student),
        contactEmail: student.contact_email,
        contactPhone: student.contact_phone,
        recordVersion: toVersion(student.record_version),
        guardians: Object.freeze(guardians),
      }) satisfies StudentDetail;
    });
  }
}

interface ResolvedProfile {
  id: string;
  displayName: string;
  status: "active" | "pending_delete";
  dateOfBirth: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  email: string | null;
  phone: string | null;
  recordVersion: number;
}

async function resolveDuplicateProfile(
  transaction: TenantTransaction,
  entityType: "student" | "guardian",
  requestedId: string,
): Promise<ResolvedProfile | null> {
  const aliasResult = await transaction.query<{
    source_record_id: string; target_record_id: string; merge_id: string;
  }>({
    text: `WITH latest AS (
      SELECT DISTINCT ON (source_record_id) source_record_id,target_record_id,merge_id,revision_number
        FROM crm_duplicate_alias_revisions WHERE entity_type=$1
       ORDER BY source_record_id,revision_number DESC
    ) SELECT latest.source_record_id,latest.target_record_id,latest.merge_id
        FROM latest JOIN crm_duplicate_merges AS merge ON merge.id=latest.merge_id AND merge.status='active'
       WHERE latest.target_record_id<>latest.source_record_id
         AND (latest.source_record_id=$2 OR latest.target_record_id=$2)
       ORDER BY latest.revision_number DESC LIMIT 1`,
    values: [entityType, requestedId],
  });
  const alias = aliasResult.rows[0];
  const canonicalId = alias?.target_record_id ?? requestedId;
  const provenance = alias ? await transaction.query<{ field_name: string; selected_record_id: string }>({
    text: `SELECT field_name,selected_record_id FROM crm_duplicate_field_provenance_revisions
            WHERE merge_id=$1 AND correction_id IS NULL ORDER BY field_name`, values: [alias.merge_id],
  }) : { rows: [] as readonly { field_name: string; selected_record_id: string }[] };
  const selectedIds = [...new Set([canonicalId, ...provenance.rows.map((row) => row.selected_record_id)])];
  const table = entityType === "student" ? "crm_students" : "crm_guardians";
  const rows = await transaction.query<Record<string, unknown>>({
    text: `SELECT id,display_name,${entityType === "student" ? "date_of_birth::text" : "NULL::text"} AS date_of_birth,
      ${entityType === "student" ? "contact_email" : "NULL::text"} AS contact_email,
      ${entityType === "student" ? "contact_phone" : "NULL::text"} AS contact_phone,
      ${entityType === "student" ? "NULL::text" : "email"} AS email,
      ${entityType === "student" ? "NULL::text" : "phone"} AS phone,status,record_version
      FROM ${table} WHERE id=ANY($1::uuid[]) AND status<>'purged'`, values: [selectedIds],
  });
  const byId = new Map(rows.rows.map((row) => [String(row.id), row]));
  const canonical = byId.get(canonicalId); if (!canonical) return null;
  const selected = new Map(provenance.rows.map((row) => [row.field_name, row.selected_record_id]));
  const value = (field: string) => byId.get(selected.get(field) ?? canonicalId)?.[field] ?? null;
  const status = canonical.status;
  if (status !== "active" && status !== "pending_delete") return null;
  return Object.freeze({ id: canonicalId, displayName: String(value("display_name")), status,
    dateOfBirth: value("date_of_birth") as string | null,
    contactEmail: value("contact_email") as string | null,
    contactPhone: value("contact_phone") as string | null,
    email: value("email") as string | null, phone: value("phone") as string | null,
    recordVersion: toVersion(canonical.record_version as number | string) });
}

function studentSelect(condition: string): string {
  return `SELECT student.id, student.display_name, student.date_of_birth::text,
                 student.status, student.contact_email, student.contact_phone,
                 student.updated_at, student.record_version,
                 primary_guardian.display_name AS primary_guardian_name
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

function toVersion(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError("CRM record version is invalid.");
  }
  return result;
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
