export const EMAIL_TEMPLATE_BODY_MAX_BYTES = 20 * 1024

const ALLOWED_FIELDS = new Set(['subject', 'body_text', 'expected_record_version'])
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface SaveEmailTemplateRequest {
  readonly subject: string
  readonly bodyText: string
  readonly expectedRecordVersion: number | null
  readonly idempotencyKey: string
}

export class EmailTemplateRequestError extends Error {
  constructor() { super('Email template request is invalid.'); this.name = 'EmailTemplateRequestError' }
}

export async function readSaveEmailTemplateRequest(request: Request): Promise<SaveEmailTemplateRequest> {
  const idempotencyKey = request.headers.get('idempotency-key')?.trim()
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new EmailTemplateRequestError()
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  const [mediaType, ...parameters] = contentType.split(';').map((value) => value.trim())
  if (mediaType !== 'application/json' || parameters.some((value) => value !== 'charset=utf-8')) throw new EmailTemplateRequestError()
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request)) } catch (error) {
    if (error instanceof EmailTemplateRequestError) throw error
    throw new EmailTemplateRequestError()
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new EmailTemplateRequestError() }
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) throw new EmailTemplateRequestError()
  if (typeof value.subject !== 'string' || typeof value.body_text !== 'string') throw new EmailTemplateRequestError()
  if (value.expected_record_version !== null && (!Number.isSafeInteger(value.expected_record_version) || Number(value.expected_record_version) < 1)) throw new EmailTemplateRequestError()
  return Object.freeze({
    subject: value.subject,
    bodyText: value.body_text,
    expectedRecordVersion: value.expected_record_version as number | null,
    idempotencyKey,
  })
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new EmailTemplateRequestError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > EMAIL_TEMPLATE_BODY_MAX_BYTES) throw new EmailTemplateRequestError()
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
