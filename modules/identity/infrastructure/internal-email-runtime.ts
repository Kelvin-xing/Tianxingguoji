import "server-only";

import { InternalEmailService } from '../application/internal-email.ts'
import { getEmailRuntime } from '../../email/server.ts'
import { PostgresqlInternalEmailRepository } from './postgresql-internal-email-repository.ts'

export interface InternalEmailIdentityRuntime {
  readonly service: InternalEmailService
}

const globalForInternalEmail = globalThis as typeof globalThis & {
  __txInternalEmailIdentityRuntime?: InternalEmailIdentityRuntime
}

export function getInternalEmailRuntime(): InternalEmailIdentityRuntime {
  if (!globalForInternalEmail.__txInternalEmailIdentityRuntime) {
    try {
      globalForInternalEmail.__txInternalEmailIdentityRuntime = Object.freeze({
        service: new InternalEmailService({
          repository: new PostgresqlInternalEmailRepository(),
          email: getEmailRuntime().service,
        }),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'EmailRuntimeUnavailable') throw error
      throw new Error('Internal email identity runtime is unavailable.')
    }
  }
  return globalForInternalEmail.__txInternalEmailIdentityRuntime
}
