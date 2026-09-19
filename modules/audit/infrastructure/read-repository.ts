import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import { runSupportingModuleTransaction } from "./production-repository.ts";
import {
  assertAuditReadQuery,
  auditEventVisibleToTrialActor,
  type AuditReadRepository,
  type AuditReadRow,
  type AuditReadQuery,
} from "../application/read-service.ts";

type Row = Record<string, unknown>;

export class PostgreSqlAuditReadRepository implements AuditReadRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async list(input: AuditReadQuery): Promise<readonly AuditReadRow[]> {
    assertAuditReadQuery(input);
    return runSupportingModuleTransaction({
      runner: this.runner,
      module: "audit",
      context: { organizationId: input.organizationId, actorUserId: input.actor.userId },
      operation: async (tx) => {
        const rows = await tx.query<Row>({
          text: `SELECT id,event_type AS "eventType",action,resource_type AS "resourceType",
                         resource_id AS "resourceId",outcome,request_id AS "requestId",
                         occurred_at AS "occurredAt",actor_user_id AS "actorUserId",metadata
                    FROM audit_events
                   WHERE organization_id=$1
                     AND ($2::timestamptz IS NULL OR occurred_at < $2::timestamptz)
                     AND (($3::text='security' AND event_type ~ '^(identity|access|email)\\.')
                       OR ($3::text='business' AND event_type !~ '^(identity|access|email)\\.'))
                   ORDER BY occurred_at DESC,id DESC
                   LIMIT $4`,
          values: [input.organizationId, input.before, input.scope, input.limit],
        });
        const level = input.actor.trialPrincipal?.level;
        return rows.flatMap((row) => {
          if (level && !auditEventVisibleToTrialActor({
            level, actorUserId: input.actor.userId,
            eventActorUserId: row.actorUserId === null ? null : String(row.actorUserId),
            eventType: String(row.eventType), scope: input.scope,
          })) return [];
          return [mapRow(row)];
        });
      },
    });
  }
}

function mapRow(row: Row): AuditReadRow {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return Object.freeze({
    id: String(row.id), eventType: String(row.eventType), action: String(row.action),
    resourceType: String(row.resourceType), resourceId: String(row.resourceId),
    outcome: row.outcome as AuditReadRow["outcome"], requestId: String(row.requestId),
    occurredAt: new Date(String(row.occurredAt)).toISOString(),
    actorUserId: row.actorUserId === null ? null : String(row.actorUserId),
    metadata: Object.freeze({ ...(metadata as Record<string, string | number | boolean | null>) }),
  });
}
