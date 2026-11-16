import { requireApiRequestAccessContext } from '@/app/api/v1/request-access';
import { hasRequestCapability } from '@/modules/access/public';
import { DirectoryError, parseDirectoryCommand } from '@/modules/schools/public';
import { ManualDirectoryRepository } from '@/modules/schools/server';
import { createApiError, handleApiRequest, type JsonValue } from '@/modules/shared/public';
import { getApplicationTenantRunner, IdempotencyExecutionError } from '@/modules/shared/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function actor() {
  const a = await requireApiRequestAccessContext();
  if (!hasRequestCapability(a,'school_directory.manage')) throw createApiError('FORBIDDEN');
  return { organizationId: a.organizationId, actorUserId: a.userId };
}
function mapError(e: unknown): never {
  if (e instanceof IdempotencyExecutionError) throw createApiError('CONFLICT');
  if (e instanceof DirectoryError) throw createApiError(e.message === 'forbidden' ? 'FORBIDDEN' : e.message === 'conflict' ? 'CONFLICT' : e.message === 'notFound' ? 'NOT_FOUND' : 'VALIDATION_FAILED');
  const code = e && typeof e === 'object' && 'code' in e ? e.code : null;
  if (code === '23514' || code === '22P02') throw createApiError('VALIDATION_FAILED');
  if (code === '40001' || code === '40P01') throw createApiError('CONFLICT');
  throw createApiError('SERVICE_UNAVAILABLE');
}
export async function GET(request: Request) {
  return handleApiRequest(request, async () => {
    const a = await actor(); const repo = new ManualDirectoryRepository(getApplicationTenantRunner());
    const id = new URL(request.url).searchParams.get('id');
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw createApiError('INVALID_REQUEST');
    try { return (id ? await repo.read(a,id) : { items: await repo.list(a) }) as unknown as JsonValue; } catch(e) { return mapError(e); }
  });
}
export async function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const a = await actor();
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw createApiError('INVALID_REQUEST');
    let body: unknown;
    try { body = await request.json(); } catch { throw createApiError('INVALID_REQUEST'); }
    try {
      const id = await new ManualDirectoryRepository(getApplicationTenantRunner()).mutate(a,parseDirectoryCommand(body),key);
      return { id };
    } catch(e) { return mapError(e); }
  });
}
