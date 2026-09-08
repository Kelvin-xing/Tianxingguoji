import "server-only";

import { EmailService } from '../application/service.ts'
import type { EmailSecretBox, EmailSenderConfiguration, EmailSenderResolver, EncryptedEmailSecret } from '../domain/contract.ts'
import { getApplicationTenantRunner } from '../../shared/server.ts'
import { DeterministicFakeEmailTransport } from './deterministic-fake-transport.ts'
import { PostgresqlEmailSettingsRepository } from './postgresql-settings-repository.ts'
import { PostgresqlEmailSenderResolver } from './postgresql-sender-resolver.ts'
import { PostgresqlEmailTemplateRepository } from './postgresql-template-repository.ts'
import { PostgresqlEmailTemplateResolver } from './postgresql-template-resolver.ts'
import { loadEmailSecretBox } from './secret-box.ts'

export class EmailRuntimeUnavailable extends Error {
  constructor() { super('Email runtime is not configured.'); this.name = 'EmailRuntimeUnavailable' }
}

export interface EmailRuntime { readonly service: EmailService }

let runtime: EmailRuntime | null = null

export function getEmailRuntime(environment: Readonly<Record<string, string | undefined>> = process.env): EmailRuntime {
  if (runtime) return runtime
  const transportMode = environment.EMAIL_TRANSPORT?.trim() || (environment.APP_ENV === 'production' ? '' : 'deterministic-fake')
  const baseUrl = environment.APP_BASE_URL?.trim()
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new EmailRuntimeUnavailable()
  const runner = getApplicationTenantRunner()
  let senderResolver: EmailSenderResolver
  if (transportMode === 'deterministic-fake') {
    const from = environment.EMAIL_FROM?.trim()
    if (!from) throw new EmailRuntimeUnavailable()
    senderResolver = new StaticEmailSenderResolver(Object.freeze({ from, transport: new DeterministicFakeEmailTransport() }))
  } else if (transportMode === 'resend') {
    senderResolver = new PostgresqlEmailSenderResolver(
      new PostgresqlEmailSettingsRepository(runner),
      new LazyEnvironmentEmailSecretBox(),
    )
  } else throw new EmailRuntimeUnavailable()
  const templateResolver = new PostgresqlEmailTemplateResolver(new PostgresqlEmailTemplateRepository(runner))
  runtime = Object.freeze({ service: new EmailService(senderResolver, baseUrl, templateResolver) })
  return runtime
}

class StaticEmailSenderResolver implements EmailSenderResolver {
  private readonly configuration: EmailSenderConfiguration
  constructor(configuration: EmailSenderConfiguration) { this.configuration = configuration }
  async resolve(): Promise<EmailSenderConfiguration> { return this.configuration }
}

class LazyEnvironmentEmailSecretBox implements EmailSecretBox {
  seal(input: Readonly<{ organizationId: string; plaintext: string }>): EncryptedEmailSecret { return loadEmailSecretBox().seal(input) }
  open(input: Readonly<{ organizationId: string; secret: EncryptedEmailSecret }>): string { return loadEmailSecretBox().open(input) }
}
