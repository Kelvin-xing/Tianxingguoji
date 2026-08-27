/** Neutral transaction facts shared by Cases, Access, Documents and Tasks. */
export interface TaskFactsTransaction {
  query<Row = Record<string, unknown>>(query: Readonly<{ text: string; values?: readonly unknown[] }>): Promise<Readonly<{
    rows: readonly Row[]; rowCount?: number | null;
  }>>;
}
export type TaskFactsKind = "application_prepare_submit" | "interview_support";
export type TaskFactsAssigneeRole = "advisor" | "contractor";

export interface CaseTaskProvisioningFacts {
  readonly caseId: string; readonly targetId: string; readonly assignmentId: string; readonly state: string;
  readonly assigneeUserId: string; readonly assigneeRole: TaskFactsAssigneeRole;
  readonly assigneeMembershipId: string; readonly assigneeRoleBindingId: string;
  readonly caseStage: string; readonly workflowStatus: string; readonly ownerUserId: string;
  readonly isPrimaryAdvisor: boolean; readonly collaboratorId: string | null;
}

export interface CasesTaskFactsPort {
  readCurrentTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string }>): Promise<CaseTaskProvisioningFacts | null>;
  readTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string; assignmentId: string }>): Promise<CaseTaskProvisioningFacts | null>;
}

export interface AccessTaskBinding {
  readonly role: "founder" | "advisor" | "contractor";
  readonly membershipId: string; readonly roleBindingId: string;
}

export interface AccessTaskFactsPort {
  readActorBindingFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; userId: string }>): Promise<Readonly<{ bindings: readonly AccessTaskBinding[] }> | null>;
  canAssigneeOperate(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; userId: string; kind: TaskFactsKind; assigneeRole: TaskFactsAssigneeRole; isPrimaryAdvisor: boolean; collaboratorId: string | null }>): Promise<boolean>;
}

export interface DocumentsCleanEvidencePort {
  readCleanCaseEvidence(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string; taskId: string; evidenceId: string }>): Promise<boolean>;
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
