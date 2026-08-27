import type { TenantTransaction } from "../../shared/server.ts";

export interface CasesPortalCaseFacts {
  readonly studentId: string;
  readonly primaryUserId: string;
  readonly workflowStatus: string;
  readonly stage: string;
  readonly updatedAt: string;
}

export interface CasesPortalSchoolTargetFact {
  readonly schoolId: string;
  readonly status: string;
}

export interface CasesPortalWorkspaceFacts extends CasesPortalCaseFacts {
  readonly schoolTargets: readonly CasesPortalSchoolTargetFact[];
  readonly actionItems: readonly { readonly title: string; readonly deadline: string | null; readonly completed: boolean; readonly customerVisible: boolean }[];
  readonly messages: readonly { readonly body: string; readonly publishedAt: string; readonly customerVisible: boolean }[];
}

export interface CasesPortalReadPort {
  readCaseFacts(transaction: TenantTransaction, input: Readonly<{ organizationId: string; serviceCaseId: string }>): Promise<CasesPortalCaseFacts | null>;
  readWorkspaceFacts(transaction: TenantTransaction, input: Readonly<{ organizationId: string; serviceCaseId: string }>): Promise<CasesPortalWorkspaceFacts | null>;
}
