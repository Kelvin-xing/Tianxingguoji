import "server-only";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { PostgresqlCleanTaskEvidencePort } from "../../documents/server.ts";
import { InterviewInvitationService } from "../application/interview-invitation-service.ts";
import { PostgresqlInterviewInvitationRepository } from "./postgresql-interview-invitation-repository.ts";
export function getInterviewInvitationService() {
  return new InterviewInvitationService(new PostgresqlInterviewInvitationRepository(
    getApplicationTenantRunner(),new PostgresqlCleanTaskEvidencePort()));
}
