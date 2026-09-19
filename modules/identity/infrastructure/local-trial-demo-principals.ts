import type { OrganizationRole } from "../../access/public.ts";

export const LOCAL_TRIAL_DEMO_ORGANIZATION = Object.freeze({
  id: "51000000-0000-4000-8000-000000000001",
  displayName: "Tianxing Local Synthetic",
});

export interface LocalTrialDemoPrincipal {
  readonly role: Extract<OrganizationRole, "l1" | "l2" | "l3">;
  readonly loginRole: "l1" | "l2_international" | "l2_local" | "l3";
  readonly userId: string;
  readonly membershipId: string;
  readonly roleBindingId: string;
  readonly normalizedEmail: string;
  readonly displayName: string;
  readonly employmentType: "FULL_TIME" | "PART_TIME";
  readonly categories: readonly ("international_school" | "local_school")[];
}

export const LOCAL_TRIAL_DEMO_FOUNDER = Object.freeze({
  userId: localUuid("101"),
  membershipId: localUuid("201"),
  roleBindingId: localUuid("301"),
});

export const LOCAL_TRIAL_DEMO_PRINCIPALS = Object.freeze([
  trialPrincipal("l1", "111", "211", "311", []),
  trialPrincipal("l2_international", "112", "212", "312", ["international_school"]),
  trialPrincipal("l2_local", "113", "213", "313", ["local_school"]),
  trialPrincipal("l3", "114", "214", "314", []),
] as const satisfies readonly LocalTrialDemoPrincipal[]);

export function getLocalTrialDemoPrincipal(
  loginRole: LocalTrialDemoPrincipal["loginRole"],
): LocalTrialDemoPrincipal {
  const principal = LOCAL_TRIAL_DEMO_PRINCIPALS.find((entry) => entry.loginRole === loginRole);
  if (!principal) throw new TypeError("Local trial demo role is not configured.");
  return principal;
}

function trialPrincipal(
  loginRole: LocalTrialDemoPrincipal["loginRole"],
  userSuffix: string,
  membershipSuffix: string,
  roleBindingSuffix: string,
  categories: readonly ("international_school" | "local_school")[],
): LocalTrialDemoPrincipal {
  return Object.freeze({
    loginRole,
    role: loginRole === "l2_international" || loginRole === "l2_local" ? "l2" : loginRole,
    userId: localUuid(userSuffix),
    membershipId: localUuid(membershipSuffix),
    roleBindingId: localUuid(roleBindingSuffix),
    normalizedEmail: `${loginRole.replaceAll("_", "-")}@local.invalid`,
    displayName: `Local trial ${loginRole.replaceAll("_", " ")}`,
    employmentType: loginRole === "l3" ? "PART_TIME" : "FULL_TIME",
    categories: Object.freeze([...categories]),
  });
}

function localUuid(suffix: string): string {
  return `51000000-0000-4000-8000-000000000${suffix}`;
}
