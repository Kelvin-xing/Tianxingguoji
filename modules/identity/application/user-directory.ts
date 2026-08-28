import {
  hasRequestCapability,
  type EmploymentType,
  type OrganizationRole,
  type RequestAccessActor,
  type RoleBindingStatus,
} from "../../access/public.ts";
import type {
  MembershipStatus,
  UserStatus,
} from "../domain/contract.ts";

export interface UserDirectoryRole {
  readonly role: OrganizationRole;
  readonly status: RoleBindingStatus;
}

export interface UserDirectoryEntry {
  readonly userId: string;
  readonly normalizedEmail: string;
  readonly userStatus: UserStatus;
  readonly membershipStatus: MembershipStatus;
  readonly displayName: string | null;
  readonly employmentType: EmploymentType | null;
  readonly roles: readonly UserDirectoryRole[];
  readonly updatedAt: string;
}

export interface UserDirectoryRepository {
  listUsers(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
  }>): Promise<readonly UserDirectoryEntry[]>;
}

export type UserDirectoryServiceErrorCode = "FORBIDDEN";

export class UserDirectoryServiceError extends Error {
  readonly code: UserDirectoryServiceErrorCode;

  constructor(code: UserDirectoryServiceErrorCode) {
    super(`User directory service rejected ${code}.`);
    this.name = "UserDirectoryServiceError";
    this.code = code;
  }
}

export function isUserDirectoryServiceError(
  error: unknown,
  code?: UserDirectoryServiceErrorCode,
): error is UserDirectoryServiceError {
  return error instanceof UserDirectoryServiceError &&
    (code === undefined || error.code === code);
}

export class UserDirectoryService {
  private readonly repository: UserDirectoryRepository;

  constructor(repository: UserDirectoryRepository) {
    this.repository = repository;
  }

  async listUsers(actor: RequestAccessActor): Promise<readonly UserDirectoryEntry[]> {
    if (!hasRequestCapability(actor, "access.manage")) {
      throw new UserDirectoryServiceError("FORBIDDEN");
    }
    return this.repository.listUsers({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
    });
  }
}
