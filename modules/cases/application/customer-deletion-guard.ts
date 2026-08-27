import type { TenantTransaction } from "../../shared/server.ts";

export interface CustomerDeletionGuardResult {
  readonly actorScoped: boolean;
  readonly hasOpenCase: boolean;
}

export interface CustomerDeletionGuardPort {
  evaluateStudentDeletion(input: {
    readonly transaction: TenantTransaction;
    readonly studentId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
  }): Promise<CustomerDeletionGuardResult>;
}
