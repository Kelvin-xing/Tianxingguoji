export type SyntheticScannerOutcome = "clean" | "malicious" | "failed" | "timeout";
export type SyntheticScannerErrorCode = "SCANNER_TIMEOUT";

export interface SyntheticScanRequest {
  readonly requestId: string;
  readonly objectKey: string;
  readonly objectVersionId: string | null;
}

export interface SyntheticScanResult {
  readonly requestId: string;
  readonly objectKey: string;
  readonly objectVersionId: string | null;
  readonly verdict: "clean" | "malicious" | "failed";
  readonly scannerVersion: "synthetic-scanner-v1";
}

export interface SyntheticScanCall {
  readonly requestId: string;
  readonly objectKey: string;
  readonly objectVersionId: string | null;
}

export class SyntheticScannerError extends Error {
  readonly code: SyntheticScannerErrorCode;
  readonly retryable = true;

  constructor(code: SyntheticScannerErrorCode) {
    super(code);
    this.name = "SyntheticScannerError";
    this.code = code;
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,255}$/;

export class SyntheticScannerFake {
  private readonly outcomeQueue: SyntheticScannerOutcome[] = [];
  private readonly recordedCalls: SyntheticScanCall[] = [];

  constructor(...outcomes: SyntheticScannerOutcome[]) {
    this.outcomeQueue.push(...outcomes);
  }

  enqueue(...outcomes: SyntheticScannerOutcome[]): void {
    this.outcomeQueue.push(...outcomes);
  }

  async scan(input: SyntheticScanRequest): Promise<SyntheticScanResult> {
    assertSafeIdentifier(input.requestId, "requestId");
    assertSafeIdentifier(input.objectKey, "objectKey");
    if (input.objectVersionId !== null) {
      assertSafeIdentifier(input.objectVersionId, "objectVersionId");
    }
    this.recordedCalls.push({ ...input });

    const outcome = this.outcomeQueue.shift() ?? "clean";
    if (outcome === "timeout") throw new SyntheticScannerError("SCANNER_TIMEOUT");
    return {
      requestId: input.requestId,
      objectKey: input.objectKey,
      objectVersionId: input.objectVersionId,
      verdict: outcome,
      scannerVersion: "synthetic-scanner-v1",
    };
  }

  calls(): readonly SyntheticScanCall[] {
    return this.recordedCalls.slice();
  }
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Synthetic scanner ${field} is not a safe identifier.`);
  }
}
