export type CaseIntakeBusinessCategory = "international_school" | "local_school";
export type CaseIntakeOwnerRole = "advisor" | "founder" | "l1" | "l2";

export interface CaseIntakeOwnerTransaction {
  query<Row = Record<string, unknown>>(query: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}
export interface CaseIntakeOwnerOption {
  readonly id: string;
  readonly displayName: string;
}

export interface CaseIntakeOwnerAdvisorOption extends CaseIntakeOwnerOption {
  readonly role: CaseIntakeOwnerRole;
}

export interface CrmCaseIntakeOwnerPort {
  listStudents(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly query: string | null;
    readonly businessCategory?: CaseIntakeBusinessCategory | null;
  }>): Promise<readonly CaseIntakeOwnerOption[]>;
  listReferralSources(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly query: string | null;
    readonly businessCategory?: CaseIntakeBusinessCategory | null;
  }>): Promise<readonly CaseIntakeOwnerOption[]>;
  lockStudent(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; studentId: string; actorUserId?: string; businessCategory?: CaseIntakeBusinessCategory | null }>,
  ): Promise<boolean>;
  lockReferralSource(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; sourceId: string; actorUserId?: string; businessCategory?: CaseIntakeBusinessCategory | null }>,
  ): Promise<Readonly<{
    id: string;
    displayName: string;
    sourceType: string;
    recordVersion: number;
  }> | null>;
}

export interface AccessCaseIntakeOwnerPort {
  listAdvisors(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly query: string | null;
    readonly businessCategory?: CaseIntakeBusinessCategory | null;
  }>): Promise<readonly CaseIntakeOwnerAdvisorOption[]>;
  lockAdvisor(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; roleBindingId: string; businessCategory?: CaseIntakeBusinessCategory | null }>,
  ): Promise<Readonly<{ id: string; membershipId: string; userId: string; role?: CaseIntakeOwnerRole }> | null>;
  assertCurrentAdvisor(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; actorUserId: string; actorRole?: string; businessCategory?: CaseIntakeBusinessCategory | null }>,
  ): Promise<boolean>;
}
