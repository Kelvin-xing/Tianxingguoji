import { expectArray, expectRecord, expectString, requestApi } from '@/lib/api/client'

export type PortalStatus = 'active' | 'paused' | 'closed' | 'expired' | 'revoked' | 'unavailable'
export interface PortalWorkspaceDto { readonly status: PortalStatus; readonly student: { readonly display_name: string } | null; readonly stage: string; readonly schools: readonly { readonly name: string; readonly status: string }[]; readonly applications: readonly { readonly school_name: string; readonly status: string }[]; readonly documents: readonly { readonly name: string; readonly published_at: string }[]; readonly allowed_actions: readonly string[] }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function decodeWorkspace(value: unknown): PortalWorkspaceDto {
  const row = expectRecord(value)
  const student = row.student == null ? null : (() => { const x = expectRecord(row.student); return { display_name: expectString(x.display_name) } })()
  const schools = expectArray(row.schools ?? row.school_targets, (item) => { const x = expectRecord(item); return { name: expectString(x.name), status: expectString(x.status) } })
  const applications = expectArray(row.applications, (item) => { const x = expectRecord(item); return { school_name: expectString(x.school_name), status: expectString(x.status) } })
  const documents = expectArray(row.documents, (item) => { const x = expectRecord(item); return { name: expectString(x.name), published_at: expectString(x.published_at) } })
  return { status: (typeof row.status === 'string' ? row.status : 'active') as PortalStatus, student, stage: expectString(row.stage ?? row.customer_facing_stage), schools, applications, documents, allowed_actions: strings(row.allowed_actions) }
}
export function redeemPortalAccess(accessKey: string) { return requestApi({ path: '/api/v1/portal/sessions', method: 'POST', body: { access_key: accessKey }, idempotencyKey: crypto.randomUUID(), responseMode: 'raw' }, (value) => expectRecord(value)) }
export function getPortalWorkspace() { return requestApi({ path: '/api/v1/portal/workspace', responseMode: 'raw' }, decodeWorkspace) }
export function logoutPortal() { return requestApi({ path: '/api/v1/portal/sessions', method: 'DELETE', responseMode: 'raw' }, (value) => expectRecord(value)) }
