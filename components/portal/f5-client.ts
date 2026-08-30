import { expectArray, expectRecord, expectString, requestApi } from '@/lib/api/client'

export type PortalStatus = 'active' | 'paused' | 'closed' | 'expired' | 'revoked' | 'unavailable'
export interface PortalWorkspaceDto {
  readonly capability_set_version: 'portal_case_read_v1'
  readonly stage: string
  readonly updated_at: string
  readonly schools: readonly { readonly name: string; readonly status: string }[]
  readonly action_items: readonly { readonly title: string; readonly deadline: string | null; readonly completed: boolean }[]
  readonly messages: readonly { readonly body: string; readonly published_at: string }[]
}
function decodeWorkspace(value: unknown): PortalWorkspaceDto {
  const row = expectRecord(value)
  const schools = expectArray(row.schools ?? row.school_targets, (item) => { const x = expectRecord(item); return { name: expectString(x.name), status: expectString(x.status) } })
  const actionItems = expectArray(row.action_items, (item) => { const x = expectRecord(item); return { title: expectString(x.title), deadline: x.deadline === null ? null : expectString(x.deadline), completed: x.completed === true } })
  const messages = expectArray(row.messages, (item) => { const x = expectRecord(item); return { body: expectString(x.body), published_at: expectString(x.published_at) } })
  const capabilitySetVersion = expectString(row.capability_set_version)
  if (capabilitySetVersion !== 'portal_case_read_v1') throw new TypeError('Unsupported Portal capability set.')
  return { capability_set_version: capabilitySetVersion, stage: expectString(row.customer_facing_stage), updated_at: expectString(row.last_customer_visible_update_at), schools, action_items: actionItems, messages }
}
export function redeemPortalAccess(accessKey: string) { return requestApi({ path: '/api/v1/portal/sessions', method: 'POST', body: { access_key: accessKey }, idempotencyKey: crypto.randomUUID(), responseMode: 'raw' }, (value) => expectRecord(value)) }
export function getPortalWorkspace() { return requestApi({ path: '/api/v1/portal/workspace', responseMode: 'raw' }, decodeWorkspace) }
export function logoutPortal() { return requestApi({ path: '/api/v1/portal/sessions', method: 'DELETE', responseMode: 'raw' }, (value) => expectRecord(value)) }
