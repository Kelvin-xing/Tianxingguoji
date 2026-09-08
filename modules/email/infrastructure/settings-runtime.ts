import "server-only";

import { getApplicationTenantRunner } from '../../shared/server.ts'
import { EmailSettingsService } from '../application/settings.ts'
import type { EmailSecretBox, EncryptedEmailSecret } from '../domain/contract.ts'
import { PostgresqlEmailSettingsRepository } from './postgresql-settings-repository.ts'
import { loadEmailSecretBox } from './secret-box.ts'

export class EmailSettingsRuntimeUnavailable extends Error {
  constructor() { super('Email settings runtime is unavailable.'); this.name = 'EmailSettingsRuntimeUnavailable' }
}

export interface EmailSettingsRuntime { readonly service: EmailSettingsService }

let runtime: EmailSettingsRuntime | null = null

export function getEmailSettingsRuntime(): EmailSettingsRuntime {
  if (runtime) return runtime
  try {
    runtime = Object.freeze({
      service: new EmailSettingsService({
        repository: new PostgresqlEmailSettingsRepository(getApplicationTenantRunner()),
        secretBox: new LazyEnvironmentEmailSecretBox(),
      }),
    })
    return runtime
  } catch {
    throw new EmailSettingsRuntimeUnavailable()
  }
}

class LazyEnvironmentEmailSecretBox implements EmailSecretBox {
  seal(input: Readonly<{ organizationId: string; plaintext: string }>): EncryptedEmailSecret { return loadEmailSecretBox().seal(input) }
  open(input: Readonly<{ organizationId: string; secret: EncryptedEmailSecret }>): string { return loadEmailSecretBox().open(input) }
}
