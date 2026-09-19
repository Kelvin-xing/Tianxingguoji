import { expectArray, expectRecord, expectString, requestApi } from '@/lib/api/client'

export type AuditScope = 'business' | 'security'
export type AuditOutcome = 'succeeded' | 'denied' | 'failed'
export type AuditMetadataValue = string | number | boolean | null

export interface AuditEventDto {
  readonly id: string
  readonly event_type: string
  readonly action: string
  readonly resource_type: string
  readonly resource_id: string
  readonly outcome: AuditOutcome
  readonly request_id: string
  readonly occurred_at: string
  readonly actor_user_id: string | null
  readonly metadata: Readonly<Record<string, AuditMetadataValue>>
}

export function listAuditEvents(scope: AuditScope, before: string | null = null) {
  const params = new URLSearchParams({ scope, limit: '50' })
  if (before) params.set('before', before)
  return requestApi({ path: `/api/v1/audit/events?${params.toString()}` }, (value) => {
    const root = expectRecord(value)
    const items = expectArray(root.items, decodeAuditEvent)
    return Object.freeze({ items: Object.freeze(items) })
  })
}

function decodeAuditEvent(value: unknown): AuditEventDto {
  const row = expectRecord(value)
  const outcome = row.outcome
  if (outcome !== 'succeeded' && outcome !== 'denied' && outcome !== 'failed') throw new TypeError('Invalid audit outcome.')
  const actor = row.actor_user_id
  return Object.freeze({
    id: expectString(row.id),
    event_type: expectString(row.event_type),
    action: expectString(row.action),
    resource_type: expectString(row.resource_type),
    resource_id: expectString(row.resource_id),
    outcome,
    request_id: expectString(row.request_id),
    occurred_at: expectString(row.occurred_at),
    actor_user_id: actor === null ? null : expectString(actor),
    metadata: decodeMetadata(row.metadata),
  })
}

function decodeMetadata(value: unknown): Readonly<Record<string, AuditMetadataValue>> {
  const source = expectRecord(value)
  const entries = Object.entries(source).map(([key, item]) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      return [key, item] as const
    }
    throw new TypeError('Invalid audit metadata.')
  })
  return Object.freeze(Object.fromEntries(entries))
}
