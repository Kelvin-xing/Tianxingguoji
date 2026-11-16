import { requestApi, ApiClientError } from '../../../lib/api/client.ts';
import type { DirectoryCommand, DirectoryDetail, DirectoryListResult, DirectoryListQuery } from '../domain/manual-directory.ts';
export { ApiClientError };
export const listManualDirectory = (query: DirectoryListQuery) => requestApi({ path: `/api/v1/school-directory?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` }, v => v as DirectoryListResult);
export const readManualDirectory = (id: string) => requestApi({ path: `/api/v1/school-directory?id=${encodeURIComponent(id)}` }, v => v as DirectoryDetail);
export const maintainManualDirectory = (body: DirectoryCommand, idempotencyKey: string) => requestApi({ path: '/api/v1/school-directory', method: 'POST', body, idempotencyKey }, v => (v as { id: string }).id);
