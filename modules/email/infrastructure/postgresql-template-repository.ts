import "server-only";
import { readEmailMutationReceipt } from './postgresql-email-receipt.ts';
import { hasCurrentEmailAccess } from './postgresql-email-access.ts';

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
  DEFAULT_INTERNAL_INVITATION_TEMPLATE,
  EmailTemplateError,
  type EmailTemplateMutationReceipt,
  type EmailTemplateRepository,
  type EmailTemplateStatus,
} from '../application/templates.ts'
import type { EmailTemplateKind } from '../domain/contract.ts'

interface TemplateRow {
  readonly template_kind: EmailTemplateKind
  readonly subject_template: string
  readonly body_text_template: string
  readonly record_version: number | string
  readonly updated_at: Date | string
}

export class PostgresqlEmailTemplateRepository implements EmailTemplateRepository {
  private readonly runner: TenantTransactionRunner

  constructor(runner: TenantTransactionRunner) { this.runner = runner }

  read(input: Parameters<EmailTemplateRepository['read']>[0]): Promise<EmailTemplateStatus> {
    return this.readAuthorized(input, 'manage')
  }

  readDeliveryTemplate(input: Parameters<EmailTemplateRepository['readDeliveryTemplate']>[0]): Promise<EmailTemplateStatus> {
    return this.readAuthorized(input, 'delivery')
  }

  private async readAuthorized(input: Readonly<{ organizationId: string; actorUserId: string; kind: EmailTemplateKind }>, purpose: 'manage' | 'delivery'): Promise<EmailTemplateStatus> {
    try {
      return await this.runner.run(
        { organizationId: input.organizationId, actorUserId: input.actorUserId },
        async (transaction) => {
          if (!await hasCurrentEmailAccess(transaction, input.organizationId, input.actorUserId, purpose)) throw new EmailTemplateError('FORBIDDEN')
          const row = await readTemplateRow(transaction, input.organizationId, input.kind)
          return row === null ? defaultStatus() : statusFromRow(row)
        },
      )
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }

  async save(input: Parameters<EmailTemplateRepository['save']>[0]): Promise<EmailTemplateMutationReceipt> {
    let replay: Awaited<ReturnType<typeof readEmailMutationReceipt>> = null
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: { organizationId: input.organizationId, actorUserId: input.actorUserId, requestId: input.requestId },
        claim: {
          id: input.idempotencyId,
          organizationId: input.organizationId,
          actorKind: 'user',
          actorOpaqueId: input.actorUserId,
          operation: 'email.update_template',
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          createdAt: input.occurredAt,
        },
        revalidate: async (transaction) => {
          if (!await hasCurrentEmailAccess(transaction, input.organizationId, input.actorUserId, 'manage')) throw new EmailTemplateError('FORBIDDEN')
          replay = await readEmailMutationReceipt(transaction, input, 'email.update_template')
        },
        execute: async (transaction) => {
          const current = await transaction.query<{ record_version: number | string }>({
            text: `SELECT record_version FROM email_templates
                    WHERE organization_id=$1 AND template_kind=$2 FOR UPDATE`,
            values: [input.organizationId, input.kind],
          })
          const currentVersion = current.rows[0] === undefined ? null : positiveInteger(current.rows[0].record_version)
          if (currentVersion !== input.expectedRecordVersion) throw new EmailTemplateError('STALE_VERSION')

          if (currentVersion === null) {
            await transaction.query({
              text: `INSERT INTO email_templates
                (organization_id,template_kind,subject_template,body_text_template,
                 record_version,created_by_user_id,updated_by_user_id,created_at,updated_at)
               VALUES ($1,$2,$3,$4,1,$5,$5,$6,$6)`,
              values: [input.organizationId, input.kind, input.subject, input.bodyText, input.actorUserId, input.occurredAt],
            })
          } else {
            const updated = await transaction.query<{ organization_id: string }>({
              text: `UPDATE email_templates
                        SET subject_template=$3,body_text_template=$4,
                            record_version=record_version+1,updated_by_user_id=$5,updated_at=$6
                      WHERE organization_id=$1 AND template_kind=$2 AND record_version=$7
                  RETURNING organization_id`,
              values: [input.organizationId, input.kind, input.subject, input.bodyText, input.actorUserId, input.occurredAt, currentVersion],
            })
            if (updated.rows.length !== 1) throw new EmailTemplateError('STALE_VERSION')
          }

          await appendEffects(transaction, input.effects)
          const receipt = receiptValue(input, false)
          return {
            state: 'completed' as const,
            resultReference: input.effects.audit.id,
            responseHash: hashRequestPayload({ record_version: receipt.recordVersion, replayed: receipt.replayed, template_kind: receipt.templateKind }),
            updatedAt: input.occurredAt,
            value: receipt,
          }
        },
      })
      if (result.status !== 'replayed') return result.value
      const stored = replay as Awaited<ReturnType<typeof readEmailMutationReceipt>>
      if (!stored || stored.auditId !== result.resultReference) throw new EmailTemplateError('UNAVAILABLE')
      const receipt = { ...receiptValue(input, false), recordVersion: stored.recordVersion, updatedAt: stored.updatedAt }
      const hash = hashRequestPayload({ record_version: receipt.recordVersion, replayed: false, template_kind: receipt.templateKind })
      if (hash !== result.responseHash) throw new EmailTemplateError('UNAVAILABLE')
      return Object.freeze({ ...receipt, replayed: true })
    } catch (error) {
      throw mapRepositoryError(error)
    }
  }
}

async function readTemplateRow(transaction: TenantTransaction, organizationId: string, kind: EmailTemplateKind): Promise<TemplateRow | null> {
  const result = await transaction.query<TemplateRow>({
    text: `SELECT template_kind,subject_template,body_text_template,record_version,updated_at
             FROM email_templates WHERE organization_id=$1 AND template_kind=$2`,
    values: [organizationId, kind],
  })
  return result.rows[0] ?? null
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

function defaultStatus(): EmailTemplateStatus {
  return Object.freeze({ ...DEFAULT_INTERNAL_INVITATION_TEMPLATE, customized: false, recordVersion: null, updatedAt: null })
}

function statusFromRow(row: TemplateRow): EmailTemplateStatus {
  return Object.freeze({
    kind: row.template_kind,
    subject: row.subject_template,
    bodyText: row.body_text_template,
    customized: true,
    recordVersion: positiveInteger(row.record_version),
    updatedAt: timestamp(row.updated_at),
  })
}

function receiptValue(input: Parameters<EmailTemplateRepository['save']>[0], replayed: boolean): EmailTemplateMutationReceipt {
  return Object.freeze({ templateKind: input.kind, recordVersion: input.nextRecordVersion, updatedAt: input.occurredAt, replayed })
}

function positiveInteger(value: number | string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new EmailTemplateError('UNAVAILABLE')
  return parsed
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new EmailTemplateError('UNAVAILABLE')
  return date.toISOString()
}

function mapRepositoryError(error: unknown): EmailTemplateError {
  if (error instanceof EmailTemplateError) return error
  if (error instanceof IdempotencyExecutionError) return new EmailTemplateError('IDEMPOTENCY_CONFLICT')
  return new EmailTemplateError('UNAVAILABLE')
}
