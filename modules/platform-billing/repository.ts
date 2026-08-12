import type {
  AdvancingCaseCountSnapshot,
  BillingContractCurrency,
  CaseLifecycleProjectionEvent,
} from "./contract.ts";
import type { PlatformBillingActor } from "./policy.ts";

export type PlatformBillingPersistenceErrorCode =
  | "BILLING_CONTRACT_NOT_FOUND"
  | "BILLING_IDEMPOTENCY_CONFLICT"
  | "BILLING_SNAPSHOT_EXISTS"
  | "BILLING_VERSION_CONFLICT";

export class PlatformBillingPersistenceError extends Error {
  readonly code: PlatformBillingPersistenceErrorCode;

  constructor(code: PlatformBillingPersistenceErrorCode) {
    super(code);
    this.name = "PlatformBillingPersistenceError";
    this.code = code;
  }
}

export interface PlatformContractRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly contractNumber: string;
  readonly currency: BillingContractCurrency;
  /** Opaque source value only; never a fee, charge, subtotal, tax, or payable amount. */
  readonly contractValueMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceReference: string;
  readonly createdByActorId: string;
  readonly approvedByActorId: string | null;
  readonly approvedAt: string | null;
  readonly status: "draft" | "active" | "superseded";
  readonly recordVersion: number;
}

export interface PlatformMetricSnapshot extends AdvancingCaseCountSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly sourceProjectionVersion: number;
  readonly generatedByActorId: string;
  readonly generatedAt: string;
}

export interface IdempotentPlatformCommand {
  readonly idempotencyKey: string;
  /** SHA-256 over normalized actor, operation, target, version, and business payload. */
  readonly requestHash: string;
}

export interface PlatformBillingRepository {
  /** Cases-owned ingestion seam. Input is parsed against the exact six-field allowlist. */
  ingestCaseLifecycleEvent(input: IdempotentPlatformCommand & {
    readonly event: unknown;
  }): Promise<CaseLifecycleProjectionEvent>;

  /** Rechecks the current platform_finance actor and appends audit in one transaction. */
  createContractDraft(input: IdempotentPlatformCommand & {
    readonly actor: PlatformBillingActor;
    readonly contractId: string;
    readonly organizationId: string;
    readonly contractNumber: string;
    readonly currency: BillingContractCurrency;
    readonly contractValueMinor: number;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly sourceReference: string;
  }): Promise<PlatformContractRecord>;

  /** Locks organization contracts; version, overlap, actor, mutation, receipt and audit are atomic. */
  activateContract(input: IdempotentPlatformCommand & {
    readonly actor: PlatformBillingActor;
    readonly contractId: string;
    readonly expectedRecordVersion: number;
  }): Promise<PlatformContractRecord>;

  /** Appends an immutable count revision at a complete Cases projection checkpoint. */
  closeMonthlySnapshot(input: IdempotentPlatformCommand & {
    readonly actor: PlatformBillingActor;
    readonly organizationId: string;
    readonly billingMonth: string;
    readonly sourceProjectionVersion: number;
    readonly expectedRevision: number;
  }): Promise<PlatformMetricSnapshot>;
}

