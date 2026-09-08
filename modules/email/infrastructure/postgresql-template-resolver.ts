import "server-only";

import type { EmailTemplateResolver } from '../domain/contract.ts'
import type { EmailTemplateRepository } from '../application/templates.ts'

export class PostgresqlEmailTemplateResolver implements EmailTemplateResolver {
  private readonly repository: EmailTemplateRepository

  constructor(repository: EmailTemplateRepository) { this.repository = repository }

  async resolve(input: Parameters<EmailTemplateResolver['resolve']>[0]) {
    const template = await this.repository.read(input)
    return Object.freeze({ kind: template.kind, subject: template.subject, bodyText: template.bodyText })
  }
}
