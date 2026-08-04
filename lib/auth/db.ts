import { Pool } from '@neondatabase/serverless'
import { getDatabaseUrl } from './config'

export interface DatabaseResult<Row> {
  rows: Row[]
}

export interface DatabaseClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<DatabaseResult<Row>>
  release(): void
}

interface AuthPool {
  connect(): Promise<DatabaseClient>
}

const globalForAuth = globalThis as typeof globalThis & {
  __txAuthPool?: AuthPool
}

export function getAuthPool(): AuthPool {
  if (!globalForAuth.__txAuthPool) {
    globalForAuth.__txAuthPool = new Pool({ connectionString: getDatabaseUrl() }) as unknown as AuthPool
  }
  return globalForAuth.__txAuthPool
}

export async function withAuthTransaction<T>(
  operation: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await getAuthPool().connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original database error; rollback failure has no safe public detail.
    }
    throw error
  } finally {
    client.release()
  }
}
