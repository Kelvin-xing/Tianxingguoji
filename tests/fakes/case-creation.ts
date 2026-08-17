import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import type { PreparedStudent } from "../../modules/crm/application/service.ts";
import {
  CaseCreationError,
  type CaseCreationRepository,
  type CaseCreationResult,
} from "../../modules/cases/application/service.ts";

interface StoredCreateResult {
  readonly requestHash: string;
  readonly result: CaseCreationResult;
}

interface StoredCase {
  readonly organizationId: string;
  readonly studentId: string;
  readonly intakeYear: number;
  readonly admissionType: string;
}

/**
 * Deterministic test adapter. It stages all facts before replacing its state,
 * which models the all-or-nothing repository contract without pretending to
 * be a production database implementation.
 */
export class InMemoryCaseCreationRepository implements CaseCreationRepository {
  private readonly approvedManifestIds = new Set<string>();
  private readonly activeAdvisorKeys = new Set<string>();
  private readonly resultsByIdempotency = new Map<string, StoredCreateResult>();
  private readonly activeCaseKeys = new Set<string>();
  private students = new Map<string, PreparedStudent>();
  private cases = new Map<string, StoredCase>();
  private assessments = new Set<string>();
  private audits = new Set<string>();
  private outbox = new Set<string>();
  private failNextCommit = false;

  approveManifest(manifestId: string): void {
    this.approvedManifestIds.add(manifestId);
  }

  activateAdvisor(input: { readonly organizationId: string; readonly userId: string }): void {
    this.activeAdvisorKeys.add(`${input.organizationId}:${input.userId}`);
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{
    students: number;
    cases: number;
    assessments: number;
    audits: number;
    outbox: number;
  }> {
    return Object.freeze({
      students: this.students.size,
      cases: this.cases.size,
      assessments: this.assessments.size,
      audits: this.audits.size,
      outbox: this.outbox.size,
    });
  }

  async createStudentAndK12Case(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly student: PreparedStudent;
    readonly serviceCaseId: string;
    readonly assessmentId: string;
    readonly intakeYear: number;
    readonly admissionType: string;
    readonly caseNumber: string;
    readonly schemaManifestId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CaseCreationResult> {
    const idempotencyScope = `${input.organizationId}:${input.actorUserId}:cases.service_case.create:${input.idempotencyKey}`;
    const existing = this.resultsByIdempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new CaseCreationError("CASE_CREATION_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }
    if (!this.activeAdvisorKeys.has(`${input.organizationId}:${input.actorUserId}`)) {
      throw new CaseCreationError("CASE_CREATION_PRIMARY_BINDING_INACTIVE");
    }
    if (!this.approvedManifestIds.has(input.schemaManifestId)) {
      throw new CaseCreationError("CASE_CREATION_MANIFEST_NOT_APPROVED");
    }

    const activeCaseKey = [
      input.organizationId,
      input.student.studentId,
      input.intakeYear,
      input.admissionType,
    ].join(":");
    if (this.activeCaseKeys.has(activeCaseKey)) {
      throw new CaseCreationError("CASE_CREATION_ACTIVE_DUPLICATE");
    }

    const result: CaseCreationResult = Object.freeze({
      studentId: input.student.studentId,
      serviceCaseId: input.serviceCaseId,
      assessmentId: input.assessmentId,
      primaryAdvisorUserId: input.actorUserId,
      stage: "signed",
      recordVersion: 1,
    });
    const nextStudents = new Map(this.students);
    const nextCases = new Map(this.cases);
    const nextAssessments = new Set(this.assessments);
    const nextAudits = new Set(this.audits);
    const nextOutbox = new Set(this.outbox);
    const nextResults = new Map(this.resultsByIdempotency);
    const nextActiveCases = new Set(this.activeCaseKeys);

    nextStudents.set(input.student.studentId, input.student);
    nextCases.set(input.serviceCaseId, {
      organizationId: input.organizationId,
      studentId: input.student.studentId,
      intakeYear: input.intakeYear,
      admissionType: input.admissionType,
    });
    nextAssessments.add(input.assessmentId);
    nextAudits.add(input.effects.audit.id);
    nextOutbox.add(input.effects.outbox.id);
    nextResults.set(idempotencyScope, { requestHash: input.requestHash, result });
    nextActiveCases.add(activeCaseKey);

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    this.students = nextStudents;
    this.cases = nextCases;
    this.assessments = nextAssessments;
    this.audits = nextAudits;
    this.outbox = nextOutbox;
    this.resultsByIdempotency.clear();
    for (const [key, value] of nextResults) this.resultsByIdempotency.set(key, value);
    this.activeCaseKeys.clear();
    for (const key of nextActiveCases) this.activeCaseKeys.add(key);
    return result;
  }
}
