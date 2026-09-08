import "server-only";

import type { EmailSettingsRepository } from '../application/settings.ts'
import type { EmailSecretBox, EmailSenderConfiguration, EmailSenderResolver } from '../domain/contract.ts'
import { ResendEmailTransport } from './resend-transport.ts'

const API_KEY = /^re_[A-Za-z0-9_-]{8,252}$/

export class PostgresqlEmailSenderResolver implements EmailSenderResolver {
  private readonly repository: EmailSettingsRepository
  private readonly secretBox: EmailSecretBox

  constructor(repository: EmailSettingsRepository, secretBox: EmailSecretBox) {
    this.repository = repository
    this.secretBox = secretBox
  }

  async resolve(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<EmailSenderConfiguration> {
    const settings = await this.repository.readDeliverySettings(input)
    if (!settings || settings.provider !== 'resend') throw new Error('Email provider is not configured.')
    const apiKey = this.secretBox.open({ organizationId: input.organizationId, secret: settings.secret })
    if (!API_KEY.test(apiKey)) throw new Error('Email provider configuration is invalid.')
    const from = settings.fromName ? `${settings.fromName} <${settings.fromEmail}>` : settings.fromEmail
    return Object.freeze({ from, transport: new ResendEmailTransport(apiKey) })
  }
}
