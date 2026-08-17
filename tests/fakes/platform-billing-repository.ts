import { randomUUID } from "node:crypto";

import {
  BillingContractError,
  buildAdvancingCaseCount,
  createCustomerContractVersion,
  evaluateContractEffectivePeriod,
  parseCaseLifecycleProjectionEvent,
  type BillingCaseStage,
  type CaseLifecycleProjectionEvent,
} from "../../modules/platform-billing/domain/contract.ts";
import {
  evaluateContractActivation,
  evaluateContractDraftCreation,
  type PlatformBillingActor,
} from "../../modules/platform-billing/domain/policy.ts";
import {
  PlatformBillingPersistenceError,
  type PlatformBillingRepository,
  type PlatformContractRecord,
  type PlatformMetricSnapshot,
} from "../../modules/platform-billing/application/repository-port.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";

type Receipt = Readonly<{ requestHash: string; result: unknown }>;
type Audit = Readonly<{
  id: string;
  actorId: string;
  action: "contract.draft_created" | "contract.activated" | "metric.snapshot_closed";
  resourceType: "contract" | "metric_snapshot";
  resourceId: string;
}>;

export class FakePlatformBillingRepository implements PlatformBillingRepository {
  readonly finance: PlatformBillingActor = {
    actorId: "20000000-0000-4000-8000-000000000001",
    role: "platform_finance",
    status: "active",
  };
  readonly approver: PlatformBillingActor = {
    actorId: "30000000-0000-4000-8000-000000000001",
    role: "platform_billing_approver",
    status: "active",
  };
  failPlatformAudit = false;

  private projectionEvents = new Map<string, CaseLifecycleProjectionEvent>();
  private contracts = new Map<string, PlatformContractRecord>();
  private metricSnapshots: PlatformMetricSnapshot[] = [];
  private platformAuditEvents: Audit[] = [];
  private receipts = new Map<string, Receipt>();

  caseEvent(
    eventId: string,
    overrides: Partial<CaseLifecycleProjectionEvent> & { caseIdSuffix?: string } = {},
  ): CaseLifecycleProjectionEvent {
    const { caseIdSuffix = "1", ...eventOverrides } = overrides;
    return {
      eventId,
      organizationId: ORGANIZATION_ID,
      caseId: `40000000-0000-4000-8000-${caseIdSuffix.padStart(12, "0")}`,
      stage: "background_collection" as BillingCaseStage,
      effectiveAt: "2026-08-15T00:00:00.000Z",
      caseVersion: 1,
      ...eventOverrides,
    };
  }

  async ingestCaseLifecycleEvent(
    input: Parameters<PlatformBillingRepository["ingestCaseLifecycleEvent"]>[0],
  ): Promise<CaseLifecycleProjectionEvent> {
    const event = parseCaseLifecycleProjectionEvent(input.event);
    return this.transact(`projection:${input.idempotencyKey}`, input.requestHash, () => {
      const existing = this.projectionEvents.get(event.eventId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new PlatformBillingPersistenceError("BILLING_IDEMPOTENCY_CONFLICT");
      }
      this.projectionEvents.set(event.eventId, event);
      return event;
    });
  }

  async createContractDraft(
    input: Parameters<PlatformBillingRepository["createContractDraft"]>[0],
  ): Promise<PlatformContractRecord> {
    const decision = evaluateContractDraftCreation(input.actor);
    if (!decision.allowed) throwBilling(decision.code);
    return this.transact(`contract-draft:${input.actor.actorId}:${input.idempotencyKey}`, input.requestHash, () => {
      if (this.contracts.has(input.contractId)) {
        throw new PlatformBillingPersistenceError("BILLING_IDEMPOTENCY_CONFLICT");
      }
      // Core construction validates identity, currency, integer value, and range.
      const validated = createCustomerContractVersion({
        ...input,
        id: input.contractId,
        createdByActorId: input.actor.actorId,
        approvedByActorId: this.approver.actorId,
        approvedAt: "2026-08-13T00:00:00.000Z",
        recordVersion: 1,
      });
      const draft: PlatformContractRecord = {
        ...validated,
        approvedByActorId: null,
        approvedAt: null,
        status: "draft",
      };
      this.commitAudit({
        id: randomUUID(), actorId: input.actor.actorId, action: "contract.draft_created",
        resourceType: "contract", resourceId: draft.id,
      });
      this.contracts.set(draft.id, draft);
      return draft;
    });
  }

  async activateContract(
    input: Parameters<PlatformBillingRepository["activateContract"]>[0],
  ): Promise<PlatformContractRecord> {
    return this.transact(`contract-activate:${input.actor.actorId}:${input.idempotencyKey}`, input.requestHash, () => {
      const current = this.contracts.get(input.contractId);
      if (!current) throw new PlatformBillingPersistenceError("BILLING_CONTRACT_NOT_FOUND");
      const decision = evaluateContractActivation({ creatorActorId: current.createdByActorId, approver: input.actor });
      if (!decision.allowed) throwBilling(decision.code);
      if (current.recordVersion !== input.expectedRecordVersion || current.status !== "draft") {
        throw new PlatformBillingPersistenceError("BILLING_VERSION_CONFLICT");
      }
      const period = evaluateContractEffectivePeriod({
        proposed: current,
        existing: [...this.contracts.values()].filter((contract) =>
          contract.id !== current.id && contract.organizationId === current.organizationId && contract.status === "active",
        ),
      });
      if (!period.allowed) throwBilling(period.code);
      const next: PlatformContractRecord = {
        ...current,
        status: "active",
        approvedByActorId: input.actor.actorId,
        approvedAt: "2026-08-13T00:00:00.000Z",
        recordVersion: current.recordVersion + 1,
      };
      this.commitAudit({
        id: randomUUID(), actorId: input.actor.actorId, action: "contract.activated",
        resourceType: "contract", resourceId: next.id,
      });
      this.contracts.set(next.id, next);
      return next;
    });
  }

  async closeMonthlySnapshot(
    input: Parameters<PlatformBillingRepository["closeMonthlySnapshot"]>[0],
  ): Promise<PlatformMetricSnapshot> {
    const decision = evaluateContractDraftCreation(input.actor);
    if (!decision.allowed) throwBilling(decision.code);
    return this.transact(`metric-close:${input.actor.actorId}:${input.idempotencyKey}`, input.requestHash, () => {
      const currentRevision = this.metricSnapshots.filter((snapshot) =>
        snapshot.organizationId === input.organizationId && snapshot.billingMonth === input.billingMonth,
      ).length;
      if (currentRevision !== input.expectedRevision) {
        throw new PlatformBillingPersistenceError("BILLING_VERSION_CONFLICT");
      }
      if (input.sourceProjectionVersion !== this.projectionEvents.size) {
        throw new PlatformBillingPersistenceError("BILLING_VERSION_CONFLICT");
      }
      const count = buildAdvancingCaseCount({
        organizationId: input.organizationId,
        billingMonth: input.billingMonth,
        projectionComplete: true,
        events: [...this.projectionEvents.values()],
      });
      const snapshot: PlatformMetricSnapshot = {
        ...count,
        id: randomUUID(),
        revision: currentRevision + 1,
        sourceProjectionVersion: input.sourceProjectionVersion,
        generatedByActorId: input.actor.actorId,
        generatedAt: "2026-09-01T00:00:00.000Z",
      };
      this.commitAudit({
        id: randomUUID(), actorId: input.actor.actorId, action: "metric.snapshot_closed",
        resourceType: "metric_snapshot", resourceId: snapshot.id,
      });
      this.metricSnapshots.push(snapshot);
      return snapshot;
    });
  }

  snapshot(): Readonly<{ contracts: number; projectionEvents: number; metricSnapshots: number; platformAuditEvents: number }> {
    return {
      contracts: this.contracts.size,
      projectionEvents: this.projectionEvents.size,
      metricSnapshots: this.metricSnapshots.length,
      platformAuditEvents: this.platformAuditEvents.length,
    };
  }

  serializedState(): string {
    return JSON.stringify({
      contracts: [...this.contracts.values()],
      projectionEvents: [...this.projectionEvents.values()],
      metricSnapshots: this.metricSnapshots,
      platformAuditEvents: this.platformAuditEvents,
    });
  }

  private transact<Result>(scope: string, requestHash: string, operation: () => Result): Result {
    const existing = this.receipts.get(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new PlatformBillingPersistenceError("BILLING_IDEMPOTENCY_CONFLICT");
      }
      return existing.result as Result;
    }
    const state = this.cloneState();
    try {
      const result = operation();
      this.receipts.set(scope, { requestHash, result });
      return result;
    } catch (error) {
      this.restoreState(state);
      throw error;
    }
  }

  private commitAudit(audit: Audit): void {
    if (this.failPlatformAudit) throw new Error("platform audit unavailable");
    this.platformAuditEvents.push(audit);
  }

  private cloneState() {
    return {
      projectionEvents: new Map(this.projectionEvents),
      contracts: new Map(this.contracts),
      metricSnapshots: [...this.metricSnapshots],
      platformAuditEvents: [...this.platformAuditEvents],
      receipts: new Map(this.receipts),
    };
  }

  private restoreState(state: ReturnType<FakePlatformBillingRepository["cloneState"]>): void {
    this.projectionEvents = state.projectionEvents;
    this.contracts = state.contracts;
    this.metricSnapshots = state.metricSnapshots;
    this.platformAuditEvents = state.platformAuditEvents;
    this.receipts = state.receipts;
  }
}

function throwBilling(code: ConstructorParameters<typeof BillingContractError>[0]): never {
  throw new BillingContractError(code);
}
