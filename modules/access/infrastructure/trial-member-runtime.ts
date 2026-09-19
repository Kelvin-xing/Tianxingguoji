import "server-only";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { TrialMemberManagementService } from "../application/trial-member-management.ts";
import { PostgresqlTrialMemberRepository } from "./postgresql-trial-member-repository.ts";

export function getTrialMemberManagementService(): TrialMemberManagementService {
  return new TrialMemberManagementService(new PostgresqlTrialMemberRepository(getApplicationTenantRunner()));
}
