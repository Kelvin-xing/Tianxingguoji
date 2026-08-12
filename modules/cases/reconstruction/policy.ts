import {
  RECONSTRUCTION_EVENT_TYPES,
  RECONSTRUCTION_EVIDENCE_TYPES,
  RECONSTRUCTION_GAP_REASON_CODES,
  RECONSTRUCTION_GAP_TYPES,
  ReconstructionError,
  type ReconstructionEventInput,
  type ReconstructionGapInput,
} from "./contract.ts";

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertReconstructionEvent(event: ReconstructionEventInput, recordedAt: string): void {
  const occurredAtMs = Date.parse(event.occurredAt);
  const recordedAtMs = Date.parse(recordedAt);
  if (!RECONSTRUCTION_EVENT_TYPES.includes(event.eventType)) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  if (!Number.isFinite(occurredAtMs) || !Number.isFinite(recordedAtMs) || occurredAtMs > recordedAtMs) {
    throw new ReconstructionError("RECONSTRUCTION_OCCURRED_AT_FUTURE");
  }
  if (!Number.isSafeInteger(event.sequenceNo) || event.sequenceNo < 1) {
    throw new ReconstructionError("RECONSTRUCTION_ORDER_INVALID");
  }
  if (
    !RECONSTRUCTION_EVIDENCE_TYPES.includes(event.evidenceType) ||
    !OPAQUE_REF.test(event.evidenceRef) ||
    (event.reportedActorRef !== undefined && !OPAQUE_REF.test(event.reportedActorRef))
  ) {
    throw new ReconstructionError("RECONSTRUCTION_EVIDENCE_INVALID");
  }
}

export function assertReconstructionGap(gap: ReconstructionGapInput, recordedAt: string): void {
  if (
    !RECONSTRUCTION_GAP_TYPES.includes(gap.gapType) ||
    !RECONSTRUCTION_GAP_REASON_CODES.includes(gap.reasonCode) ||
    !OPAQUE_REF.test(gap.ownerRef) ||
    !Number.isFinite(Date.parse(gap.resolutionTargetAt)) ||
    Date.parse(gap.resolutionTargetAt) < Date.parse(recordedAt)
  ) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
}

export function assertOpaqueReference(value: string): void {
  if (!OPAQUE_REF.test(value)) throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
}
