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

export interface CognitoInviteProvisioner {
  provisionInvite(
    input: ProvisionCognitoInviteInput,
  ): Promise<{ readonly providerSubject: string }>;
}

export interface CognitoManagedLoginVerifier {
  completeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<CognitoManagedIdentity>;
}
