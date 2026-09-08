const ALLOWED_FIELDS = new Set(['api_key', 'from_email', 'from_name', 'expected_record_version'])
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const EMAIL_SETTINGS_BODY_MAX_BYTES = 4 * 1024

export interface SaveEmailSettingsRequest {
  readonly apiKey: string
  readonly fromEmail: string
  readonly fromName: string | null
  readonly expectedRecordVersion: number | null
  readonly idempotencyKey: string
}

export class EmailSettingsRequestError extends Error {
  constructor() { super('Email settings request is invalid.'); this.name = 'EmailSettingsRequestError' }
}

export async function readSaveEmailSettingsRequest(request: Request): Promise<SaveEmailSettingsRequest> {
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new EmailSettingsRequestError()
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  const [mediaType, ...parameters] = contentType.split(';').map((value) => value.trim())
  if (mediaType !== 'application/json' || parameters.some((value) => value !== 'charset=utf-8')) throw new EmailSettingsRequestError()
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request)) } catch (error) {
    if (error instanceof EmailSettingsRequestError) throw error
    throw new EmailSettingsRequestError()
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new EmailSettingsRequestError() }
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) throw new EmailSettingsRequestError()
  if (typeof value.api_key !== 'string' || typeof value.from_email !== 'string') throw new EmailSettingsRequestError()
  if (value.from_name !== null && typeof value.from_name !== 'string') throw new EmailSettingsRequestError()
  if (value.expected_record_version !== null && (!Number.isSafeInteger(value.expected_record_version) || Number(value.expected_record_version) < 1)) throw new EmailSettingsRequestError()
  return Object.freeze({
    apiKey: value.api_key,
    fromEmail: value.from_email,
    fromName: value.from_name,
    expectedRecordVersion: value.expected_record_version as number | null,
    idempotencyKey,
  })
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new EmailSettingsRequestError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > EMAIL_SETTINGS_BODY_MAX_BYTES) throw new EmailSettingsRequestError()
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
