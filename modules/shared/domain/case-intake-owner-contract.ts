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
  readonly role: "advisor";
}

export interface CrmCaseIntakeOwnerPort {
  listStudents(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly query: string | null;
  }>): Promise<readonly CaseIntakeOwnerOption[]>;
  listReferralSources(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly query: string | null;
  }>): Promise<readonly CaseIntakeOwnerOption[]>;
  lockStudent(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; studentId: string }>,
  ): Promise<boolean>;
  lockReferralSource(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; sourceId: string }>,
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
  }>): Promise<readonly CaseIntakeOwnerAdvisorOption[]>;
  lockAdvisor(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; roleBindingId: string }>,
  ): Promise<Readonly<{ id: string; membershipId: string; userId: string }> | null>;
  assertCurrentAdvisor(
    transaction: CaseIntakeOwnerTransaction,
    input: Readonly<{ organizationId: string; actorUserId: string }>,
  ): Promise<boolean>;
}
