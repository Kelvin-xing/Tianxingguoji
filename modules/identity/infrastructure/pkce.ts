import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface PkcePair {
  state: string
  codeVerifier: string
  codeChallenge: string
}

export function createPkcePair(): PkcePair {
  const codeVerifier = base64Url(randomBytes(32))
  return {
    state: base64Url(randomBytes(32)),
    codeVerifier,
    codeChallenge: base64Url(createHash('sha256').update(codeVerifier).digest()),
  }
}

export function equalsSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

