export const INVITE_ACTIVATION_BODY_MAX_BYTES = 8 * 1024

export class InviteActivationRequestError extends Error {
  constructor() {
    super('Invite activation request is invalid.')
    this.name = 'InviteActivationRequestError'
  }
}

export async function readInviteActivationRequest(request: Request): Promise<Readonly<{
  activationCredential: string
  displayName: string
  password: string
  passwordConfirmation: string
}>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  const [mediaType, ...parameters] = contentType.split(';').map((value) => value.trim())
  if (mediaType !== 'application/x-www-form-urlencoded' || parameters.some((value) => value !== 'charset=utf-8')) {
    throw new InviteActivationRequestError()
  }

  const bytes = await readBoundedBody(request)
  let body: string
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new InviteActivationRequestError()
  }
  if (/%(?![0-9a-f]{2})/i.test(body)) throw new InviteActivationRequestError()
  const fields = new URLSearchParams(body)
  const expected = ['activation_credential', 'display_name', 'password', 'password_confirmation']
  const keys = [...fields.keys()]
  if (keys.length !== expected.length || expected.some((key) => keys.filter((candidate) => candidate === key).length !== 1)) {
    throw new InviteActivationRequestError()
  }
  return Object.freeze({
    activationCredential: fields.get('activation_credential') ?? '',
    displayName: fields.get('display_name') ?? '',
    password: fields.get('password') ?? '',
    passwordConfirmation: fields.get('password_confirmation') ?? '',
  })
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new InviteActivationRequestError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > INVITE_ACTIVATION_BODY_MAX_BYTES) throw new InviteActivationRequestError()
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}
