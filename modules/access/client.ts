import {
  expectArray,
  expectRecord,
  expectString,
  requestApi,
} from "../../lib/api/client.ts";
import {
  isOrganizationRole,
  isWorkspaceCapability,
  type OrganizationRole,
  type WorkspaceCapability,
} from "./public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SNAPSHOT_KEYS = Object.freeze([
  "user_id",
  "organization_id",
  "nickname",
  "role",
  "policy_version",
  "capabilities",
] as const);

export interface WorkspaceAccessSnapshot {
  readonly user_id: string;
  readonly organization_id: string;
  readonly nickname: string | null;
  readonly role: OrganizationRole;
  readonly policy_version: string;
  readonly capabilities: readonly WorkspaceCapability[];
}

export function getWorkspaceAccessSnapshot(signal?: AbortSignal): Promise<WorkspaceAccessSnapshot> {
  return requestApi(
    { path: "/api/v1/auth/me", signal },
    decodeWorkspaceAccessSnapshot,
  );
}

function decodeWorkspaceAccessSnapshot(value: unknown): WorkspaceAccessSnapshot {
  const record = expectRecord(value);
  assertExactKeys(record, SNAPSHOT_KEYS);

  const userId = expectString(record.user_id);
  const organizationId = expectString(record.organization_id);
  const nickname = record.nickname === null ? null : expectString(record.nickname);
  const role = expectString(record.role);
  const policyVersion = expectString(record.policy_version);
  if (!UUID.test(userId) || !UUID.test(organizationId)) {
    throw new TypeError("Invalid access snapshot identity.");
  }
  if (!isOrganizationRole(role)) {
    throw new TypeError("Invalid access snapshot role.");
  }
  if (!POLICY_VERSION.test(policyVersion)) {
    throw new TypeError("Invalid access policy version.");
  }

  const capabilities = expectArray(record.capabilities, (capability) => {
    if (!isWorkspaceCapability(capability)) {
      throw new TypeError("Invalid workspace capability.");
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("Duplicate workspace capability.");
  }

  return Object.freeze({
    user_id: userId,
    organization_id: organizationId,
    nickname,
    role,
    policy_version: policyVersion,
    capabilities: Object.freeze([...capabilities]),
  });
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError("Invalid access snapshot shape.");
  }
}
