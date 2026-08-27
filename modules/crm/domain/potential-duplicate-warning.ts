export {};

export type PotentialDuplicateKind = "student" | "guardian";
export interface PotentialDuplicateTokenPayload { readonly org: string; readonly actor: string; readonly kind: PotentialDuplicateKind; readonly fieldsHash: string; readonly candidateVersion: string; readonly expiresAt: number }
