import {isK12BusinessCategory,type K12BusinessCategory} from '../../../../../modules/access/public.ts'
export const INTERNAL_EMAIL_INVITE_BODY_MAX_BYTES = 8 * 1024

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INVITABLE_ROLES = new Set<InvitableRole>(['founder', 'admin', 'advisor', 'contractor', 'l1', 'l2', 'l3'])
const ALLOWED_FIELDS = new Set(['normalized_email', 'role', 'employment_type', 'display_name', 'trial_categories'])

export type InvitableRole = 'founder' | 'admin' | 'advisor' | 'contractor' | 'l1' | 'l2' | 'l3'
export type InviteEmploymentType = 'FULL_TIME' | 'PART_TIME'

export class InternalEmailInviteRequestError extends Error {
  readonly code: 'INVALID_REQUEST' | 'VALIDATION_FAILED'

  constructor(code: 'INVALID_REQUEST' | 'VALIDATION_FAILED') {
    super(`Internal email invite request rejected ${code}.`)
    this.name = 'InternalEmailInviteRequestError'
    this.code = code
  }
}

export async function readInternalEmailInviteRequest(request: Request): Promise<Readonly<{
  normalizedEmail: string
  role: InvitableRole
  trialCategories?: readonly K12BusinessCategory[]
  employmentType?: InviteEmploymentType
  displayName?: string
  idempotencyKey: string
}>> {
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  const [mediaType, ...parameters] = contentType.split(';').map((value) => value.trim())
  if (mediaType !== 'application/json' || parameters.some((value) => value !== 'charset=utf-8')) {
    throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request))
  } catch (error) {
    if (error instanceof InternalEmailInviteRequestError) throw error
    throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  }
  if (!isRecord(body) || Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  }
  const normalizedEmail = body.normalized_email
  const role = body.role
  const employmentType = body.employment_type
  const displayName = body.display_name
  const categories = body.trial_categories
  if (
    typeof normalizedEmail !== 'string' || normalizedEmail.length === 0 || normalizedEmail.length > 320 ||
    normalizedEmail !== normalizedEmail.trim().toLowerCase() || typeof role !== 'string' || !INVITABLE_ROLES.has(role as InvitableRole) ||
    (categories !== undefined && (!Array.isArray(categories) || !categories.every(isK12BusinessCategory) || new Set(categories).size !== categories.length
      || !['founder','l1','l2','l3'].includes(role as string) || (role !== 'l2' && categories.length !== 0))) ||
    (['l1','l2','l3'].includes(role as string) && categories === undefined) ||
    (employmentType !== undefined && employmentType !== 'FULL_TIME' && employmentType !== 'PART_TIME') ||
    (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 100))
  ) throw new InternalEmailInviteRequestError('VALIDATION_FAILED')

  return Object.freeze({
    normalizedEmail,
    role: role as InvitableRole,
    ...(categories === undefined ? {} : {trialCategories: Object.freeze([...categories as K12BusinessCategory[]].sort())}),
    employmentType: employmentType as InviteEmploymentType | undefined,
    displayName: displayName as string | undefined,
    idempotencyKey,
  })
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new InternalEmailInviteRequestError('INVALID_REQUEST')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > INTERNAL_EMAIL_INVITE_BODY_MAX_BYTES) throw new InternalEmailInviteRequestError('INVALID_REQUEST')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
