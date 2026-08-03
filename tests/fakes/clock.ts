export interface SyntheticClockPort {
  nowMs(): number;
  nowIso(): string;
  advance(milliseconds: number): string;
  set(isoTimestamp: string): string;
}

const INITIAL_TIMESTAMP = "2026-08-03T00:00:00.000Z";

export class SyntheticClock implements SyntheticClockPort {
  private currentMs: number;

  constructor(initialTimestamp = INITIAL_TIMESTAMP) {
    const initialMs = Date.parse(initialTimestamp);
    if (!Number.isFinite(initialMs)) {
      throw new Error("Synthetic clock requires a valid ISO timestamp.");
    }
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(milliseconds: number): string {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Synthetic clock advances must be non-negative safe integers.");
    }
    this.currentMs += milliseconds;
    return this.nowIso();
  }

  set(isoTimestamp: string): string {
    const nextMs = Date.parse(isoTimestamp);
    if (!Number.isFinite(nextMs)) {
      throw new Error("Synthetic clock requires a valid ISO timestamp.");
    }
    this.currentMs = nextMs;
    return this.nowIso();
  }
}
