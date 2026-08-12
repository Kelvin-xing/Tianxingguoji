import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import {
  DocumentScanError,
  type DocumentScanClaim,
  type DocumentScanEvent,
  type DocumentScanFailureResult,
  type DocumentScanReconciliationCandidate,
  type DocumentScanRepository,
  type DocumentScanVerdictResult,
  type DocumentScanWork,
} from "../../modules/documents/scan-service.ts";

interface StoredVersion {
  readonly organizationId: string;
  readonly documentVersionId: string;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  state: "quarantined" | "scanning" | "available" | "rejected" | "scan_failed";
}

/** A staged transaction fake for P1-11 scan tuple and state behavior. */
export class InMemoryDocumentScanRepository implements DocumentScanRepository {
  private readonly versionsByTuple = new Map<string, StoredVersion>();
  private readonly worksByTuple = new Map<string, DocumentScanWork>();
  private readonly candidates: DocumentScanReconciliationCandidate[] = [];
  private readonly audits = new Map<string, MutationEffectBundle["audit"]>();
  private readonly outbox = new Map<string, MutationEffectBundle["outbox"]>();
  private failNextCommit = false;

  registerQuarantinedVersion(input: Omit<StoredVersion, "state">): void {
    this.versionsByTuple.set(tuple(input.bucket, input.key, input.versionId, "scanner-v1"), {
      ...input,
      state: "quarantined",
    });
  }

  addReconciliationCandidate(candidate: DocumentScanReconciliationCandidate): void {
    this.candidates.push(candidate);
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  state(event: Pick<DocumentScanEvent, "bucket" | "key" | "versionId" | "scanPolicyVersion">) {
    return this.versionsByTuple.get(tuple(event.bucket, event.key, event.versionId, event.scanPolicyVersion))?.state;
  }

  work(event: Pick<DocumentScanEvent, "bucket" | "key" | "versionId" | "scanPolicyVersion">) {
    return this.worksByTuple.get(tuple(event.bucket, event.key, event.versionId, event.scanPolicyVersion));
  }

  snapshot(): Readonly<{ versions: number; works: number; audits: number; outbox: number }> {
    return Object.freeze({
      versions: this.versionsByTuple.size,
      works: this.worksByTuple.size,
      audits: this.audits.size,
      outbox: this.outbox.size,
    });
  }

  effectPayload(): string {
    return JSON.stringify({ audits: [...this.audits.values()], outbox: [...this.outbox.values()] });
  }

  async claimScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly workId: string;
    readonly startedAtMs: number;
    readonly createEffects: (context: {
      readonly organizationId: string;
      readonly documentVersionId: string;
    }) => MutationEffectBundle;
  }): Promise<DocumentScanClaim> {
    const workKey = tupleFromEvent(input.event);
    const version = this.versionsByTuple.get(workKey);
    if (!version) throw new DocumentScanError("DOCUMENT_SCAN_EVENT_INVALID");
    const existing = this.worksByTuple.get(workKey);
    if (existing) {
      if (existing.state !== "failed" || input.event.deliveryAttempt <= existing.attemptCount) {
        return {
          status: "duplicate",
          workId: existing.id,
          terminalState: existing.state,
        };
      }
      if (input.event.deliveryAttempt !== existing.attemptCount + 1 || existing.attemptCount >= 3) {
        return {
          status: "duplicate",
          workId: existing.id,
          terminalState: existing.state,
        };
      }
      const resumed: DocumentScanWork = Object.freeze({
        ...existing,
        attemptCount: input.event.deliveryAttempt,
        state: "running",
      });
      const effects = input.createEffects({
        organizationId: version.organizationId,
        documentVersionId: version.documentVersionId,
      });
      return this.commitClaim({ workKey, version, work: resumed, effects });
    }
    if (version.state !== "quarantined" || input.event.deliveryAttempt !== 1) {
      throw new DocumentScanError("DOCUMENT_SCAN_EVENT_INVALID");
    }
    const work: DocumentScanWork = Object.freeze({
      id: input.workId,
      organizationId: version.organizationId,
      documentVersionId: version.documentVersionId,
      bucket: input.event.bucket,
      key: input.event.key,
      versionId: input.event.versionId,
      scanPolicyVersion: input.event.scanPolicyVersion,
      attemptCount: 1,
      state: "running",
    });
    const effects = input.createEffects({
      organizationId: version.organizationId,
      documentVersionId: version.documentVersionId,
    });
    return this.commitClaim({ workKey, version, work, effects });
  }

  async completeScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly verdict: "clean" | "malicious";
    readonly completedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentScanVerdictResult> {
    const workKey = tupleFromEvent(input.event);
    const version = this.versionsByTuple.get(workKey);
    const work = this.worksByTuple.get(workKey);
    if (!version || !work || work.id !== input.work.id || work.state !== "running" || version.state !== "scanning") {
      throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
    }
    assertEffects(input.effects, version);
    const nextVersions = cloneVersions(this.versionsByTuple);
    const nextWorks = new Map(this.worksByTuple);
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);
    nextVersions.set(workKey, { ...version, state: input.verdict === "clean" ? "available" : "rejected" });
    nextWorks.set(workKey, Object.freeze({ ...work, state: input.verdict === "clean" ? "clean" : "rejected" }));
    nextAudits.set(input.effects.audit.id, input.effects.audit);
    nextOutbox.set(input.effects.outbox.id, input.effects.outbox);
    this.commit({ versions: nextVersions, works: nextWorks, audits: nextAudits, outbox: nextOutbox });
    return {
      status: input.verdict === "clean" ? "available" : "rejected",
      workId: work.id,
      documentVersionId: version.documentVersionId,
    };
  }

  async failScanWork(input: {
    readonly event: DocumentScanEvent;
    readonly work: DocumentScanWork;
    readonly failedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentScanFailureResult> {
    const workKey = tupleFromEvent(input.event);
    const version = this.versionsByTuple.get(workKey);
    const work = this.worksByTuple.get(workKey);
    if (!version || !work || work.id !== input.work.id || work.state !== "running" || version.state !== "scanning") {
      throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
    }
    assertEffects(input.effects, version);
    const nextVersions = cloneVersions(this.versionsByTuple);
    const nextWorks = new Map(this.worksByTuple);
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);
    nextVersions.set(workKey, { ...version, state: "scan_failed" });
    nextWorks.set(workKey, Object.freeze({ ...work, state: "failed" }));
    nextAudits.set(input.effects.audit.id, input.effects.audit);
    nextOutbox.set(input.effects.outbox.id, input.effects.outbox);
    this.commit({ versions: nextVersions, works: nextWorks, audits: nextAudits, outbox: nextOutbox });
    return {
      status: input.event.deliveryAttempt === 3 ? "dead_letter" : "retry",
      workId: work.id,
      documentVersionId: version.documentVersionId,
      attemptCount: input.event.deliveryAttempt,
    };
  }

  async findReconciliationCandidates(input: {
    readonly nowMs: number;
    readonly staleAfterMs: number;
    readonly limit: number;
  }): Promise<readonly DocumentScanReconciliationCandidate[]> {
    return this.candidates.slice(0, input.limit);
  }

  async reconcileScanCandidate(input: {
    readonly candidate: DocumentScanReconciliationCandidate;
    readonly reconciledAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<"requeued" | "dead_letter" | "ignored"> {
    const candidateKey = tuple(
      input.candidate.bucket,
      input.candidate.key,
      input.candidate.versionId,
      input.candidate.scanPolicyVersion,
    );
    const version = this.versionsByTuple.get(candidateKey);
    if (!version || version.documentVersionId !== input.candidate.documentVersionId) return "ignored";
    assertEffects(input.effects, version);
    const work = this.worksByTuple.get(candidateKey);
    const nextVersions = cloneVersions(this.versionsByTuple);
    const nextWorks = new Map(this.worksByTuple);
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);

    if (input.candidate.kind === "missed_event") {
      if (version.state !== "quarantined" || work) return "ignored";
    } else {
      if (!work || work.state !== "running" || version.state !== "scanning") return "ignored";
      nextVersions.set(candidateKey, { ...version, state: "scan_failed" });
      nextWorks.set(candidateKey, Object.freeze({ ...work, state: "failed" }));
    }
    nextAudits.set(input.effects.audit.id, input.effects.audit);
    nextOutbox.set(input.effects.outbox.id, input.effects.outbox);
    this.commit({ versions: nextVersions, works: nextWorks, audits: nextAudits, outbox: nextOutbox });
    removeCandidate(this.candidates, input.candidate);
    return input.candidate.kind === "stuck_scan" && input.candidate.attemptCount >= 3
      ? "dead_letter"
      : "requeued";
  }

  private commitClaim(input: {
    readonly workKey: string;
    readonly version: StoredVersion;
    readonly work: DocumentScanWork;
    readonly effects: MutationEffectBundle;
  }): DocumentScanClaim {
    assertEffects(input.effects, input.version);
    const nextVersions = cloneVersions(this.versionsByTuple);
    const nextWorks = new Map(this.worksByTuple);
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);
    nextVersions.set(input.workKey, { ...input.version, state: "scanning" });
    nextWorks.set(input.workKey, input.work);
    nextAudits.set(input.effects.audit.id, input.effects.audit);
    nextOutbox.set(input.effects.outbox.id, input.effects.outbox);
    this.commit({ versions: nextVersions, works: nextWorks, audits: nextAudits, outbox: nextOutbox });
    return { status: "claimed", work: input.work };
  }

  private commit(input: {
    readonly versions: Map<string, StoredVersion>;
    readonly works: Map<string, DocumentScanWork>;
    readonly audits: Map<string, MutationEffectBundle["audit"]>;
    readonly outbox: Map<string, MutationEffectBundle["outbox"]>;
  }): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic scan transaction failure");
    }
    replaceMap(this.versionsByTuple, input.versions);
    replaceMap(this.worksByTuple, input.works);
    replaceMap(this.audits, input.audits);
    replaceMap(this.outbox, input.outbox);
  }
}

function tupleFromEvent(event: Pick<DocumentScanEvent, "bucket" | "key" | "versionId" | "scanPolicyVersion">): string {
  return tuple(event.bucket, event.key, event.versionId, event.scanPolicyVersion);
}

function tuple(bucket: string, key: string, versionId: string, policy: string): string {
  return `${bucket}:${key}:${versionId}:${policy}`;
}

function assertEffects(effects: MutationEffectBundle, version: StoredVersion): void {
  if (
    effects.audit.organizationId !== version.organizationId ||
    effects.audit.resourceId !== version.documentVersionId ||
    effects.outbox.organizationId !== version.organizationId ||
    effects.outbox.aggregateId !== version.documentVersionId
  ) {
    throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
  }
}

function cloneVersions(source: Map<string, StoredVersion>): Map<string, StoredVersion> {
  return new Map([...source].map(([key, version]) => [key, { ...version }]));
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function removeCandidate(
  candidates: DocumentScanReconciliationCandidate[],
  target: DocumentScanReconciliationCandidate,
): void {
  const index = candidates.indexOf(target);
  if (index >= 0) candidates.splice(index, 1);
}
