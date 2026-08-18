import type { OrganizationRole } from "../../access/public.ts";

export const LOCAL_SYNTHETIC_ORGANIZATION = Object.freeze({
  id: "10000000-0000-4000-8000-000000000001",
  displayName: "Tianxing Local Synthetic",
});

export interface LocalSyntheticPrincipal {
  readonly role: OrganizationRole;
  readonly userId: string;
  readonly membershipId: string;
  readonly roleBindingId: string;
  readonly normalizedEmail: string;
}

export const LOCAL_SYNTHETIC_PRINCIPALS = Object.freeze([
  principal("founder", "101", "201", "301"),
  principal("admin", "102", "202", "302"),
  principal("advisor", "103", "203", "303"),
  principal("data_reviewer", "104", "204", "304"),
  principal("contractor", "105", "205", "305"),
] as const satisfies readonly LocalSyntheticPrincipal[]);

const PRINCIPALS_BY_ROLE = new Map(
  LOCAL_SYNTHETIC_PRINCIPALS.map((entry) => [entry.role, entry]),
);

export function getLocalSyntheticPrincipal(role: OrganizationRole): LocalSyntheticPrincipal {
  const principal = PRINCIPALS_BY_ROLE.get(role);
  if (!principal) throw new TypeError("Local synthetic role is not configured.");
  return principal;
}

function principal(
  role: OrganizationRole,
  userSuffix: string,
  membershipSuffix: string,
  roleBindingSuffix: string,
): LocalSyntheticPrincipal {
  return Object.freeze({
    role,
    userId: localUuid(userSuffix),
    membershipId: localUuid(membershipSuffix),
    roleBindingId: localUuid(roleBindingSuffix),
    normalizedEmail: `${role.replaceAll("_", "-")}@local.invalid`,
  });
}

function localUuid(suffix: string): string {
  return `10000000-0000-4000-8000-000000000${suffix}`;
}
