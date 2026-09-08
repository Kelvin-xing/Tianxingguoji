import "server-only";

import { getApplicationTenantRunner } from '../../shared/server.ts'
import { EmailTemplateService } from '../application/templates.ts'
import { PostgresqlEmailTemplateRepository } from './postgresql-template-repository.ts'

export class EmailTemplateRuntimeUnavailable extends Error {
  constructor() { super('Email template runtime is unavailable.'); this.name = 'EmailTemplateRuntimeUnavailable' }
}

export interface EmailTemplateRuntime { readonly service: EmailTemplateService }

let runtime: EmailTemplateRuntime | null = null

export function getEmailTemplateRuntime(): EmailTemplateRuntime {
  if (!runtime) {
    try {
      runtime = Object.freeze({ service: new EmailTemplateService({ repository: new PostgresqlEmailTemplateRepository(getApplicationTenantRunner()) }) })
    } catch {
      throw new EmailTemplateRuntimeUnavailable()
    }
  }
  return runtime
}
