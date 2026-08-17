import "server-only";

import { INVITE_POLICY } from "./contract.ts";

export interface CognitoAdminCreateUserRequest {
  readonly userPoolId: string;
  readonly username: string;
  readonly temporaryPassword: string;
  readonly messageAction: "SUPPRESS";
  readonly userAttributes: Readonly<{
    email: string;
    "custom:organization_id": string;
    "custom:internal_user_id": string;
  }>;
}

export interface CognitoAdminClient {
  adminCreateUser(
    request: CognitoAdminCreateUserRequest,
  ): Promise<{ readonly providerSubject: string }>;
}

export interface CognitoInviteAdapterOptions {
  readonly userPoolId: string;
  readonly client: CognitoAdminClient;
}

export interface ProvisionCognitoInviteInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly normalizedEmail: string;
  readonly activationSecret: string;
}

export interface CognitoManagedIdentity {
  readonly providerSubject: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly totpVerified: boolean;
}

export interface CognitoManagedLoginVerifier {
  completeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<CognitoManagedIdentity>;
}

export class CognitoAdapterError extends Error {
  readonly code: "COGNITO_SUBJECT_INVALID";

  constructor(code: "COGNITO_SUBJECT_INVALID") {
    super("Cognito returned an invalid provider identity.");
    this.name = "CognitoAdapterError";
    this.code = code;
  }
}

export class CognitoInviteAdapter {
  private readonly userPoolId: string;
  private readonly client: CognitoAdminClient;

  constructor(options: CognitoInviteAdapterOptions) {
    if (!/^[\w-]+_[A-Za-z0-9]+$/.test(options.userPoolId)) {
      throw new TypeError("Cognito invite adapter requires a valid User Pool ID.");
    }
    this.userPoolId = options.userPoolId;
    this.client = options.client;
  }

  async provisionInvite(input: ProvisionCognitoInviteInput): Promise<{ readonly providerSubject: string }> {
    assertUuid(input.userId, "userId");
    assertUuid(input.organizationId, "organizationId");
    assertEmail(input.normalizedEmail);
    assertActivationSecret(input.activationSecret);

    const result = await this.client.adminCreateUser({
      userPoolId: this.userPoolId,
      username: input.userId,
      temporaryPassword: input.activationSecret,
      messageAction: "SUPPRESS",
      userAttributes: {
        email: input.normalizedEmail,
        "custom:organization_id": input.organizationId,
        "custom:internal_user_id": input.userId,
      },
    });
    if (!SAFE_PROVIDER_SUBJECT.test(result.providerSubject)) {
      throw new CognitoAdapterError("COGNITO_SUBJECT_INVALID");
    }
    return Object.freeze({ providerSubject: result.providerSubject });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PROVIDER_SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new TypeError(`Cognito ${field} must be a canonical UUID.`);
  }
}

function assertEmail(value: string): void {
  if (value.length === 0 || value.length > 320 || value !== value.trim().toLowerCase()) {
    throw new TypeError("Cognito invite email must be normalized.");
  }
}

function assertActivationSecret(value: string): void {
  if (Buffer.from(value, "base64url").length !== INVITE_POLICY.activationSecretBytes) {
    throw new TypeError("Cognito temporary password must be a 32-byte invite secret.");
  }
}
