import "server-only";

import { neon } from '@neondatabase/serverless'
import type { CrawlerConfig, CrawlerReviewDecision, CrawlerTicket } from '@/types/index'

const DEFAULT_CONFIG: CrawlerConfig = {
  enabled: false,
  frequency: 'weekly',
  school_levels: ['Primary', 'Secondary', 'Post Secondary'],
  max_parallel: 3,
  llm_enabled: true,
  updated_at: new Date().toISOString(),
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not configured')
  return url
}

function sql() {
  return neon(databaseUrl())
}

let schemaPromise: Promise<void> | null = null

export function defaultCrawlerConfig(): CrawlerConfig {
  return { ...DEFAULT_CONFIG, updated_at: new Date().toISOString() }
}

export async function ensureCrawlerSchema() {
  if (!schemaPromise) {
    const query = sql()
    schemaPromise = (async () => {
      await query`
        CREATE TABLE IF NOT EXISTS crawler_tickets (
          id text PRIMARY KEY,
          school_key text NOT NULL,
          school_name_zh text NOT NULL DEFAULT '',
          field text NOT NULL DEFAULT 'general',
          description text NOT NULL,
          reporter text NOT NULL DEFAULT '',
          status text NOT NULL DEFAULT 'open',
          admin_note text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `
      await query`
        CREATE TABLE IF NOT EXISTS crawler_review_decisions (
          school_key text PRIMARY KEY,
          status text NOT NULL,
          suggestion text NOT NULL DEFAULT '',
          reviewer text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `
      await query`
        CREATE TABLE IF NOT EXISTS crawler_config (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `
      await query`
        CREATE TABLE IF NOT EXISTS crawler_runs (
          id text PRIMARY KEY,
          scope jsonb NOT NULL DEFAULT '{}'::jsonb,
          status text NOT NULL DEFAULT 'scheduled',
          note text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `
    })()
  }
  await schemaPromise
}

function rowToTicket(row: Record<string, any>): CrawlerTicket {
  return {
    id: String(row.id),
    school_key: String(row.school_key),
    school_name_zh: String(row.school_name_zh || ''),
    field: String(row.field || 'general'),
    description: String(row.description || ''),
    reporter: String(row.reporter || ''),
    status: row.status || 'open',
    admin_note: String(row.admin_note || ''),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }
}

function rowToDecision(row: Record<string, any>): CrawlerReviewDecision {
  return {
    school_key: String(row.school_key),
    status: row.status || 'needs_changes',
    suggestion: String(row.suggestion || ''),
    reviewer: String(row.reviewer || ''),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }
}

export async function listTickets(): Promise<CrawlerTicket[]> {
  await ensureCrawlerSchema()
  const rows = await sql()`SELECT * FROM crawler_tickets ORDER BY created_at DESC`
  return rows.map(rowToTicket)
}

export async function createTicket(input: {
  school_key: string
  school_name_zh: string
  field: string
  description: string
  reporter: string
}): Promise<CrawlerTicket> {
  await ensureCrawlerSchema()
  const id = `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const [row] = await sql()`
    INSERT INTO crawler_tickets (id, school_key, school_name_zh, field, description, reporter)
    VALUES (${id}, ${input.school_key}, ${input.school_name_zh}, ${input.field || 'general'}, ${input.description}, ${input.reporter || ''})
    RETURNING *
  `
  return rowToTicket(row)
}

export async function updateTicket(input: {
  id: string
  status?: CrawlerTicket['status']
  admin_note?: string
}): Promise<CrawlerTicket | null> {
  await ensureCrawlerSchema()
  const [row] = await sql()`
    UPDATE crawler_tickets
    SET
      status = COALESCE(${input.status || null}, status),
      admin_note = COALESCE(${input.admin_note ?? null}, admin_note),
      updated_at = now()
    WHERE id = ${input.id}
    RETURNING *
  `
  return row ? rowToTicket(row) : null
}

export async function listReviewDecisions(): Promise<CrawlerReviewDecision[]> {
  await ensureCrawlerSchema()
  const rows = await sql()`SELECT * FROM crawler_review_decisions ORDER BY updated_at DESC`
  return rows.map(rowToDecision)
}

export async function upsertReviewDecision(input: {
  school_key: string
  status: CrawlerReviewDecision['status']
  suggestion: string
  reviewer: string
}): Promise<CrawlerReviewDecision> {
  await ensureCrawlerSchema()
  const [row] = await sql()`
    INSERT INTO crawler_review_decisions (school_key, status, suggestion, reviewer)
    VALUES (${input.school_key}, ${input.status}, ${input.suggestion || ''}, ${input.reviewer || ''})
    ON CONFLICT (school_key) DO UPDATE SET
      status = EXCLUDED.status,
      suggestion = EXCLUDED.suggestion,
      reviewer = EXCLUDED.reviewer,
      updated_at = now()
    RETURNING *
  `
  return rowToDecision(row)
}

export async function getCrawlerConfig(): Promise<CrawlerConfig> {
  await ensureCrawlerSchema()
  const [row] = await sql()`SELECT value FROM crawler_config WHERE key = 'default'`
  if (row?.value) return row.value as CrawlerConfig
  const config = defaultCrawlerConfig()
  await saveCrawlerConfig(config)
  return config
}

export async function saveCrawlerConfig(input: Partial<CrawlerConfig>): Promise<CrawlerConfig> {
  await ensureCrawlerSchema()
  const config: CrawlerConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    enabled: Boolean(input.enabled),
    school_levels: Array.isArray(input.school_levels) ? input.school_levels : DEFAULT_CONFIG.school_levels,
    max_parallel: Math.max(1, Math.min(8, Number(input.max_parallel || DEFAULT_CONFIG.max_parallel))),
    llm_enabled: Boolean(input.llm_enabled),
    updated_at: new Date().toISOString(),
  }
  const [row] = await sql()`
    INSERT INTO crawler_config (key, value, updated_at)
    VALUES ('default', ${JSON.stringify(config)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    RETURNING value
  `
  return row.value as CrawlerConfig
}
