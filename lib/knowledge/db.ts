import { neon } from '@neondatabase/serverless'

function sql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not configured')
  return neon(url)
}

let schemaReady: Promise<void> | null = null

async function ensureSchema() {
  if (!schemaReady) {
    const q = sql()
    schemaReady = q`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        key text PRIMARY KEY,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        school_names jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.then(() => undefined)
  }
  await schemaReady
}

export type KBPayload = {
  data: Record<string, unknown>
  schoolNames: Record<string, string>
}

export async function getKnowledgeBase(): Promise<(KBPayload & { updatedAt: string }) | null> {
  await ensureSchema()
  const [row] = await sql()`SELECT data, school_names, updated_at FROM knowledge_base WHERE key = 'default'`
  if (!row) return null
  return {
    data: row.data as Record<string, unknown>,
    schoolNames: row.school_names as Record<string, string>,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function saveKnowledgeBase(payload: KBPayload): Promise<string> {
  await ensureSchema()
  const [row] = await sql()`
    INSERT INTO knowledge_base (key, data, school_names, updated_at)
    VALUES ('default', ${JSON.stringify(payload.data)}::jsonb, ${JSON.stringify(payload.schoolNames)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      data = EXCLUDED.data,
      school_names = EXCLUDED.school_names,
      updated_at = now()
    RETURNING updated_at
  `
  return new Date(row.updated_at).toISOString()
}
