/** Neutral transaction facts shared by Cases, Access, Documents and Tasks. */
export interface TaskFactsTransaction {
  query<Row = Record<string, unknown>>(query: Readonly<{ text: string; values?: readonly unknown[] }>): Promise<Readonly<{
    rows: readonly Row[]; rowCount?: number | null;
  }>>;
}
export type TaskFactsKind = "application_prepare_submit" | "interview_support";
export type TaskFactsAssigneeRole = "advisor" | "contractor" | "founder" | "l1" | "l2" | "l3";

export interface CaseTaskProvisioningFacts {
  readonly caseId: string; readonly targetId: string; readonly assignmentId: string; readonly state: string;
  readonly assigneeUserId: string; readonly assigneeRole: TaskFactsAssigneeRole;
  readonly assigneeMembershipId: string; readonly assigneeRoleBindingId: string;
  readonly businessCategory?: string | null;
  readonly caseStage: string; readonly workflowStatus: string; readonly ownerUserId: string;
  readonly isPrimaryAdvisor: boolean; readonly collaboratorId: string | null;
}

export interface CasesTaskFactsPort {
  readCurrentTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string }>): Promise<CaseTaskProvisioningFacts | null>;
  readTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string; assignmentId: string }>): Promise<CaseTaskProvisioningFacts | null>;
}

export interface AccessTaskBinding {
  readonly role: TaskFactsAssigneeRole;
  readonly membershipId: string; readonly roleBindingId: string;
}

export interface AccessTaskFactsPort {
  readActorBindingFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; userId: string }>): Promise<Readonly<{ bindings: readonly AccessTaskBinding[] }> | null>;
  canAssigneeOperate(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; userId: string; kind: TaskFactsKind; assigneeRole: TaskFactsAssigneeRole; businessCategory?: string | null; isPrimaryAdvisor: boolean; collaboratorId: string | null }>): Promise<boolean>;
}

export interface DocumentsCleanEvidencePort {
  readCleanCaseEvidence(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string; taskId: string; evidenceId: string; actorUserId?: string }>): Promise<boolean>;
}

export interface TaskCompletionFacts {
  readonly organizationId: string; readonly caseId: string; readonly targetId: string;
  readonly taskId: string; readonly receiptId: string; readonly evidenceReference: string | null;
  readonly kind: TaskFactsKind; readonly completionRecord: Readonly<Record<string, unknown>>;
}

export interface TaskCompletionFactsPort {
  readCompletionFacts(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; targetId: string; taskId: string; receiptId: string;
  }>): Promise<TaskCompletionFacts | null>;
}

export interface ApplicationTaskRequestRef {
  readonly sourceEventId: string;
  readonly targetId: string;
}

export interface ApplicationTaskRequestFacts {
  readonly sourceEventId: string;
  readonly targetId: string;
  readonly caseId: string;
  readonly applicationRound: number;
  readonly applicationDeadline: string | null;
  readonly assignmentId: string;
  readonly assigneeUserId: string;
  readonly assigneeRole: TaskFactsAssigneeRole;
  readonly assigneeMembershipId: string;
  readonly assigneeRoleBindingId: string;
  readonly ownerUserId: string;
  readonly sourceActorUserId: string;
  readonly targetRecordVersion: number;
}

export interface CasesApplicationTaskRequestFactsPort {
  listForCandidateVersion(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; versionId: string;
  }>): Promise<readonly ApplicationTaskRequestRef[]>;
  readRequestFacts(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; targetId: string; sourceEventId: string;
  }>): Promise<ApplicationTaskRequestFacts | null>;
}

export interface ApplicationTaskCompletionEventFacts {
  readonly taskId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly receiptId: string;
  readonly actorUserId: string;
  readonly completionRecord: Readonly<Record<string, unknown>>;
  readonly evidenceReference: string | null;
}

export interface TasksApplicationCompletionEventFactsPort {
  readApplicationCompletionEvent(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; taskId: string;
  }>): Promise<ApplicationTaskCompletionEventFacts | null>;
}

export interface InterviewTaskRequestFacts {
  readonly sourceEventId:string; readonly invitationId:string; readonly caseId:string; readonly targetId:string;
  readonly interviewAt:string; readonly taskBrief:string; readonly ownerUserId:string; readonly assigneeRole:TaskFactsAssigneeRole;
  readonly assigneeMembershipId:string; readonly assigneeRoleBindingId:string; readonly sourceActorUserId:string;
}
export interface CasesInterviewTaskRequestFactsPort {
  readSource(transaction:TaskFactsTransaction,input:Readonly<{organizationId:string;targetId:string;invitationId:string}>):Promise<string|null>;
  readFacts(transaction:TaskFactsTransaction,input:Readonly<{organizationId:string;targetId:string;invitationId:string}>):Promise<InterviewTaskRequestFacts|null>;
}
