import "server-only";

import type { MutationEffectBundle } from '../../audit/public.ts'
import { appendAtomicMutationEffects, type AtomicMutationTransaction } from '../../audit/server.ts'
import { hashRequestPayload } from '../../shared/public.ts'
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
  type TenantTransaction,
  type TenantTransactionRunner,
} from '../../shared/server.ts'
import {
  EmailSettingsError,
  type EmailSettingsMutationReceipt,
  type EmailSettingsRepository,
  type EmailSettingsStatus,
  type StoredEmailProviderSettings,
} from '../application/settings.ts'

interface SettingsRow {
  readonly provider: 'resend'
  readonly from_email: string
  readonly from_name: string | null
  readonly api_key_ciphertext: Buffer
  readonly api_key_iv: Buffer
  readonly api_key_auth_tag: Buffer
  readonly encryption_key_version: string
  readonly record_version: number | string
  readonly updated_at: Date | string
}

export class PostgresqlEmailSettingsRepository implements EmailSettingsRepository {
  private readonly runner: TenantTransactionRunner

  constructor(runner: TenantTransactionRunner) { this.runner = runner }

  async readStatus(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<EmailSettingsStatus> {
    try {
      return await this.runner.run(
        { organizationId: input.organizationId, actorUserId: input.actorUserId },
        async (transaction) => {
          const row = await readSettingsRow(transaction, input.organizationId)
          return row === null ? emptyStatus() : statusFromRow(row)
        },
      )
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }

  async readDeliverySettings(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<StoredEmailProviderSettings | null> {
    try {
      return await this.runner.run(
        { organizationId: input.organizationId, actorUserId: input.actorUserId },
        async (transaction) => {
          const row = await readSettingsRow(transaction, input.organizationId)
          if (row === null) return null
          return Object.freeze({
            provider: row.provider,
            fromEmail: row.from_email,
            fromName: row.from_name,
            secret: Object.freeze({
              ciphertext: Buffer.from(row.api_key_ciphertext),
              iv: Buffer.from(row.api_key_iv),
              authTag: Buffer.from(row.api_key_auth_tag),
              keyVersion: row.encryption_key_version,
            }),
            recordVersion: positiveInteger(row.record_version),
            updatedAt: timestamp(row.updated_at),
          })
        },
      )
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }

  async save(input: Parameters<EmailSettingsRepository['save']>[0]): Promise<EmailSettingsMutationReceipt> {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: { organizationId: input.organizationId, actorUserId: input.actorUserId, requestId: input.requestId },
        claim: {
          id: input.idempotencyId,
          organizationId: input.organizationId,
          actorKind: 'user',
          actorOpaqueId: input.actorUserId,
          operation: 'email.update_provider_settings',
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          createdAt: input.occurredAt,
        },
        revalidate: async (transaction) => requireActiveAdmin(transaction, input.organizationId, input.actorUserId),
        execute: async (transaction) => {
          const current = await transaction.query<{ record_version: number | string }>({
            text: `SELECT record_version FROM email_provider_settings
                    WHERE organization_id=$1 FOR UPDATE`,
            values: [input.organizationId],
          })
          const currentVersion = current.rows[0] === undefined ? null : positiveInteger(current.rows[0].record_version)
          if (currentVersion !== input.expectedRecordVersion) throw new EmailSettingsError('STALE_VERSION')

          if (currentVersion === null) {
            await transaction.query({
              text: `INSERT INTO email_provider_settings
                (organization_id,provider,from_email,from_name,api_key_ciphertext,
                 api_key_iv,api_key_auth_tag,encryption_key_version,record_version,
                 created_by_user_id,updated_by_user_id,created_at,updated_at)
               VALUES ($1,'resend',$2,$3,$4,$5,$6,$7,1,$8,$8,$9,$9)`,
              values: [input.organizationId, input.fromEmail, input.fromName,
                Buffer.from(input.secret.ciphertext), Buffer.from(input.secret.iv),
                Buffer.from(input.secret.authTag), input.secret.keyVersion,
                input.actorUserId, input.occurredAt],
            })
          } else {
            const updated = await transaction.query<{ organization_id: string }>({
              text: `UPDATE email_provider_settings
                        SET from_email=$2,from_name=$3,api_key_ciphertext=$4,
                            api_key_iv=$5,api_key_auth_tag=$6,encryption_key_version=$7,
                            record_version=record_version+1,updated_by_user_id=$8,updated_at=$9
                      WHERE organization_id=$1 AND record_version=$10
                  RETURNING organization_id`,
              values: [input.organizationId, input.fromEmail, input.fromName,
                Buffer.from(input.secret.ciphertext), Buffer.from(input.secret.iv),
                Buffer.from(input.secret.authTag), input.secret.keyVersion,
                input.actorUserId, input.occurredAt, currentVersion],
            })
            if (updated.rows.length !== 1) throw new EmailSettingsError('STALE_VERSION')
          }

          await appendEffects(transaction, input.effects)
          const receipt = receiptValue(input, false)
          return {
            state: 'completed' as const,
            resultReference: input.effects.audit.id,
            responseHash: hashRequestPayload({
              record_version: receipt.recordVersion,
              replayed: receipt.replayed,
              settings_id: receipt.settingsId,
              updated_at: receipt.updatedAt,
            }),
            updatedAt: input.occurredAt,
            value: receipt,
          }
        },
      })
      return result.status === 'replayed' ? receiptValue(input, true) : result.value
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }
}

async function readSettingsRow(transaction: TenantTransaction, organizationId: string): Promise<SettingsRow | null> {
  const result = await transaction.query<SettingsRow>({
    text: `SELECT provider,from_email,from_name,api_key_ciphertext,api_key_iv,
                  api_key_auth_tag,encryption_key_version,record_version,updated_at
             FROM email_provider_settings WHERE organization_id=$1`,
    values: [organizationId],
  })
  return result.rows[0] ?? null
}

async function requireActiveAdmin(transaction: TenantTransaction, organizationId: string, actorUserId: string): Promise<void> {
  const result = await transaction.query<{ id: string }>({
    text: `SELECT role_binding.id
             FROM access_organization_memberships AS membership
             JOIN identity_users AS identity_user ON identity_user.id=membership.user_id
             JOIN access_role_bindings AS role_binding
               ON role_binding.organization_id=membership.organization_id
              AND role_binding.membership_id=membership.id
              AND role_binding.user_id=membership.user_id
            WHERE membership.organization_id=$1 AND membership.user_id=$2
              AND membership.status='active' AND identity_user.status='active'
              AND role_binding.status='active' AND role_binding.role='admin'
            LIMIT 1 FOR SHARE OF membership,identity_user,role_binding`,
    values: [organizationId, actorUserId],
  })
  if (result.rows.length !== 1) throw new EmailSettingsError('FORBIDDEN')
}

async function appendEffects(transaction: TenantTransaction, effects: MutationEffectBundle): Promise<void> {
  const adapter: AtomicMutationTransaction = {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await transaction.query<Row>({ text, values })
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
    },
  }
  await appendAtomicMutationEffects(adapter, effects)
}

function emptyStatus(): EmailSettingsStatus {
  return Object.freeze({ configured: false, provider: null, fromEmail: null, fromName: null, recordVersion: null, updatedAt: null })
}

function statusFromRow(row: SettingsRow): EmailSettingsStatus {
  return Object.freeze({ configured: true, provider: row.provider, fromEmail: row.from_email, fromName: row.from_name, recordVersion: positiveInteger(row.record_version), updatedAt: timestamp(row.updated_at) })
}

function receiptValue(input: Parameters<EmailSettingsRepository['save']>[0], replayed: boolean): EmailSettingsMutationReceipt {
  return Object.freeze({ settingsId: input.organizationId, recordVersion: input.nextRecordVersion, updatedAt: input.occurredAt, replayed })
}

function positiveInteger(value: number | string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new EmailSettingsError('UNAVAILABLE')
  return parsed
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new EmailSettingsError('UNAVAILABLE')
  return date.toISOString()
}

function mapRepositoryError(error: unknown): EmailSettingsError {
  if (error instanceof EmailSettingsError) return error
  if (error instanceof IdempotencyExecutionError) return new EmailSettingsError('IDEMPOTENCY_CONFLICT')
  return new EmailSettingsError('UNAVAILABLE')
}
