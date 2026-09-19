import "server-only";

import { InternalEmailService } from '../application/internal-email.ts'
import { getEmailRuntime } from '../../email/server.ts'
import { PostgresqlInternalEmailRepository } from './postgresql-internal-email-repository.ts'

export interface InternalEmailIdentityRuntime {
  readonly service: InternalEmailService
}

// Keep service instances in their module graph so route error constructors match.
// PostgreSQL connection pooling remains shared by the database adapter.
let runtime: InternalEmailIdentityRuntime | null = null

export function getInternalEmailRuntime(): InternalEmailIdentityRuntime {
  if (!runtime) {
    try {
      runtime = Object.freeze({
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
  return runtime
}
