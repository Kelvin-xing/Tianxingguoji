import type {
  AssessmentRepository,
  AssessmentSnapshot,
  StoredAssessmentAnswer,
  UpdateAssessmentAnswerResult,
} from "../../modules/cases/application/assessment-service.ts";
import { AssessmentServiceError } from "../../modules/cases/application/assessment-service.ts";
import type { AssessmentStatus, K12ManifestComposition } from "../../modules/cases/domain/contract.ts";

interface StoredIdempotencyResult {
  readonly requestHash: string;
  readonly result: UpdateAssessmentAnswerResult;
}

/** Deterministic transaction-port fake. It is never a runtime persistence fallback. */
export class InMemoryAssessmentRepository implements AssessmentRepository {
  private readonly assessmentId: string;
  private readonly caseId: string;
  private readonly organizationId: string;
  private readonly manifestId: string;
  private readonly manifest: K12ManifestComposition;
  private readonly primaryAdvisorKeys = new Set<string>();
  private readonly educationProfileReaderKeys = new Set<string>();
  private readonly educationProfileEditorKeys = new Set<string>();
  private readonly answersByField = new Map<string, StoredAssessmentAnswer>();
  private readonly resultsByIdempotency = new Map<string, StoredIdempotencyResult>();
  private readonly auditIds = new Set<string>();
  private readonly outboxIds = new Set<string>();
  private failNextCommit = false;

  constructor(input: {
    readonly assessmentId: string;
    readonly caseId: string;
    readonly organizationId: string;
    readonly manifestId: string;
    readonly manifest: K12ManifestComposition;
  }) {
    this.assessmentId = input.assessmentId;
    this.caseId = input.caseId;
    this.organizationId = input.organizationId;
    this.manifestId = input.manifestId;
    this.manifest = input.manifest;
  }

  assignPrimaryAdvisor(input: { readonly organizationId: string; readonly caseId: string; readonly userId: string }): void {
    this.primaryAdvisorKeys.add(accessKey(input));
  }

  grantEducationProfileEdit(input: {
    readonly organizationId: string;
    readonly caseId: string;
    readonly userId: string;
  }): void {
    const key = accessKey(input);
    this.educationProfileReaderKeys.add(key);
    this.educationProfileEditorKeys.add(key);
  }

  grantEducationProfileView(input: {
    readonly organizationId: string;
    readonly caseId: string;
    readonly userId: string;
  }): void {
    this.educationProfileReaderKeys.add(accessKey(input));
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{ answers: number; audits: number; outbox: number }> {
    return Object.freeze({
      answers: this.answersByField.size,
      audits: this.auditIds.size,
      outbox: this.outboxIds.size,
    });
  }

  async readCaseAssessment(
    input: Parameters<AssessmentRepository["readCaseAssessment"]>[0],
  ): Promise<AssessmentSnapshot> {
    this.assertCase(input);
    this.assertReadable(input);
    return Object.freeze({
      assessmentId: this.assessmentId,
      manifestId: this.manifestId,
      status: "draft" as AssessmentStatus,
      manifest: this.manifest,
      answers: Object.freeze([...this.answersByField.values()]),
    });
  }

  async updateAssessmentAnswer(
    input: Parameters<AssessmentRepository["updateAssessmentAnswer"]>[0],
  ): Promise<UpdateAssessmentAnswerResult> {
    this.assertCase(input);
    this.assertWritable(input);
    if (input.assessmentId !== this.assessmentId || input.manifestId !== this.manifestId) {
      throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
    }

    const idempotencyScope = `${input.organizationId}:${input.actorUserId}:cases.assessment_answer.update:${input.idempotencyKey}`;
    const replay = this.resultsByIdempotency.get(idempotencyScope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new AssessmentServiceError("ASSESSMENT_ANSWER_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }

    const current = this.answersByField.get(input.field.fieldId);
    const currentVersion = current?.recordVersion ?? 0;
    if (currentVersion !== input.expectedRecordVersion) {
      throw new AssessmentServiceError("ASSESSMENT_ANSWER_STALE_VERSION", {
        currentRecordVersion: currentVersion,
        diffToken: `assessment-${this.assessmentId}-${currentVersion}`,
      });
    }

    const result: UpdateAssessmentAnswerResult = Object.freeze({
      assessmentId: this.assessmentId,
      fieldId: input.field.fieldId,
      semanticState: input.semanticState,
      value: input.value,
      valueType: input.valueType,
      recordVersion: currentVersion + 1,
    });
    const nextAnswers = new Map(this.answersByField);
    const nextAudits = new Set(this.auditIds);
    const nextOutbox = new Set(this.outboxIds);
    const nextResults = new Map(this.resultsByIdempotency);
    nextAnswers.set(input.field.fieldId, Object.freeze({
      id: current?.id ?? input.answerId,
      fieldId: input.field.fieldId,
      semanticState: input.semanticState,
      value: input.value,
      valueType: input.valueType,
      recordVersion: result.recordVersion,
    }));
    nextAudits.add(input.effects.audit.id);
    nextOutbox.add(input.effects.outbox.id);
    nextResults.set(idempotencyScope, { requestHash: input.requestHash, result });

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    this.answersByField.clear();
    for (const [fieldId, answer] of nextAnswers) this.answersByField.set(fieldId, answer);
    this.auditIds.clear();
    for (const auditId of nextAudits) this.auditIds.add(auditId);
    this.outboxIds.clear();
    for (const outboxId of nextOutbox) this.outboxIds.add(outboxId);
    this.resultsByIdempotency.clear();
    for (const [key, value] of nextResults) this.resultsByIdempotency.set(key, value);
    return result;
  }

  private assertCase(input: { readonly organizationId: string; readonly caseId: string }): void {
    if (input.organizationId !== this.organizationId || input.caseId !== this.caseId) {
      throw new AssessmentServiceError("ASSESSMENT_CASE_NOT_FOUND");
    }
  }

  private assertReadable(input: { readonly organizationId: string; readonly caseId: string; readonly actorUserId: string }): void {
    const key = accessKey({
      organizationId: input.organizationId,
      caseId: input.caseId,
      userId: input.actorUserId,
    });
    if (!this.primaryAdvisorKeys.has(key) && !this.educationProfileReaderKeys.has(key)) {
      throw new AssessmentServiceError("ASSESSMENT_READ_FORBIDDEN");
    }
  }

  private assertWritable(input: { readonly organizationId: string; readonly caseId: string; readonly actorUserId: string }): void {
    const key = accessKey({
      organizationId: input.organizationId,
      caseId: input.caseId,
      userId: input.actorUserId,
    });
    if (!this.primaryAdvisorKeys.has(key) && !this.educationProfileEditorKeys.has(key)) {
      throw new AssessmentServiceError("ASSESSMENT_WRITE_FORBIDDEN");
    }
  }
}

function accessKey(input: { readonly organizationId: string; readonly caseId: string; readonly userId: string }): string {
  return `${input.organizationId}:${input.caseId}:${input.userId}`;
}
