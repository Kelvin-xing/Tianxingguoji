import { Pool } from '@neondatabase/serverless'
import { Pool as NodePool } from 'pg'
import { getDatabaseUrl } from './auth-config.ts'
import { loadRuntimeEnvironment, type RuntimeEnvironment } from '../../../lib/runtime/runtime-environment.ts'
import { loadTestDatabaseConfiguration } from '../../../lib/runtime/test-database-config.ts'

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
    const config = resolveAuthPoolConfiguration(process.env)
    globalForAuth.__txAuthPool = config.kind === 'node-pg'
      ? new NodePool(config.options) as unknown as AuthPool
      : new Pool(config.options) as unknown as AuthPool
  }
  return globalForAuth.__txAuthPool
}

export function resolveAuthPoolConfiguration(environment: RuntimeEnvironment):
  | { readonly kind: 'node-pg'; readonly options: ConstructorParameters<typeof NodePool>[0] }
  | { readonly kind: 'neon'; readonly options: ConstructorParameters<typeof Pool>[0] } {
  const runtime = loadRuntimeEnvironment(environment)
  if (runtime.authMode === 'database-test') {
    const test = loadTestDatabaseConfiguration(environment)
    return Object.freeze({ kind: 'node-pg' as const, options: Object.freeze({
      connectionString: test.database.connectionString,
      connectionTimeoutMillis: test.connectionTimeoutMs,
      statement_timeout: test.statementTimeoutMs,
      max: 1,
      ssl: test.ssl,
    }) })
  }
  return Object.freeze({ kind: 'neon' as const, options: Object.freeze({
    connectionString: getDatabaseUrl(environment),
  }) })
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
