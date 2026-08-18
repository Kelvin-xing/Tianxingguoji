export type SyntheticCognitoOutcome = "success" | "denied" | "timeout" | "provider_error";
export type SyntheticCognitoOperation = "authenticate" | "revoke";

export type SyntheticCognitoErrorCode = "COGNITO_TIMEOUT" | "COGNITO_PROVIDER_ERROR";

export class SyntheticCognitoError extends Error {
  readonly code: SyntheticCognitoErrorCode;
  readonly retryable: boolean;

  constructor(code: SyntheticCognitoErrorCode) {
    super(code);
    this.name = "SyntheticCognitoError";
    this.code = code;
    this.retryable = code === "COGNITO_TIMEOUT";
  }
}

export interface SyntheticCognitoRequest {
  readonly requestId: string;
  readonly providerSubject: string;
}

interface SyntheticCognitoResultBase {
  readonly providerSubject: string;
  readonly errorCode: "COGNITO_AUTHENTICATION_DENIED" | "COGNITO_REVOKE_DENIED" | null;
  readonly retryable: boolean;
}

export interface SyntheticCognitoAuthenticationResult extends SyntheticCognitoResultBase {
  readonly operation: "authenticate";
  readonly status: "authenticated" | "denied";
}

export interface SyntheticCognitoRevokeResult extends SyntheticCognitoResultBase {
  readonly operation: "revoke";
  readonly status: "revoked" | "denied";
}

export type SyntheticCognitoResult = SyntheticCognitoAuthenticationResult | SyntheticCognitoRevokeResult;

export interface SyntheticCognitoCall {
  readonly operation: SyntheticCognitoOperation;
  readonly requestId: string;
  readonly providerSubject: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export class SyntheticCognitoFake {
  private readonly outcomeQueues: Record<
    SyntheticCognitoOperation,
    SyntheticCognitoOutcome[]
  > = {
    authenticate: [],
    revoke: [],
  };
  private readonly recordedCalls: SyntheticCognitoCall[] = [];

  constructor(
    outcomes: Partial<
      Record<SyntheticCognitoOperation, SyntheticCognitoOutcome | readonly SyntheticCognitoOutcome[]>
    > = {},
  ) {
    for (const operation of ["authenticate", "revoke"] as const) {
      const configured = outcomes[operation];
      if (configured === undefined) continue;
      this.enqueue(operation, ...(Array.isArray(configured) ? configured : [configured]));
    }
  }

  enqueue(operation: SyntheticCognitoOperation, ...outcomes: SyntheticCognitoOutcome[]): void {
    this.outcomeQueues[operation].push(...outcomes);
  }

  async authenticate(input: SyntheticCognitoRequest): Promise<SyntheticCognitoAuthenticationResult> {
    return this.execute("authenticate", input);
  }

  async revoke(input: SyntheticCognitoRequest): Promise<SyntheticCognitoRevokeResult> {
    return this.execute("revoke", input);
  }

  calls(): readonly SyntheticCognitoCall[] {
    return this.recordedCalls.slice();
  }

  private execute(
    operation: "authenticate",
    input: SyntheticCognitoRequest,
  ): Promise<SyntheticCognitoAuthenticationResult>;
  private execute(
    operation: "revoke",
    input: SyntheticCognitoRequest,
  ): Promise<SyntheticCognitoRevokeResult>;
  private async execute(
    operation: SyntheticCognitoOperation,
    input: SyntheticCognitoRequest,
  ): Promise<SyntheticCognitoResult> {
    assertSafeIdentifier(input.requestId, "requestId");
    assertSafeIdentifier(input.providerSubject, "providerSubject");
    this.recordedCalls.push({ operation, ...input });

    const outcome = this.outcomeQueues[operation].shift() ?? "success";
    if (outcome === "timeout") throw new SyntheticCognitoError("COGNITO_TIMEOUT");
    if (outcome === "provider_error") {
      throw new SyntheticCognitoError("COGNITO_PROVIDER_ERROR");
    }
    if (outcome === "denied") {
      return {
        operation,
        status: "denied",
        providerSubject: input.providerSubject,
        errorCode:
          operation === "authenticate"
            ? "COGNITO_AUTHENTICATION_DENIED"
            : "COGNITO_REVOKE_DENIED",
        retryable: false,
      };
    }

    if (operation === "authenticate") {
      return {
        operation,
        status: "authenticated",
        providerSubject: input.providerSubject,
        errorCode: null,
        retryable: false,
      };
    }
    return {
      operation,
      status: "revoked",
      providerSubject: input.providerSubject,
      errorCode: null,
      retryable: false,
    };
  }
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Synthetic Cognito ${field} is not a safe identifier.`);
  }
}
