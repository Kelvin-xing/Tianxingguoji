import { requestApi, ApiClientError } from '../../../lib/api/client.ts';
import type { DirectoryCommand, DirectoryDetail, ManualDirectorySchool } from '../domain/manual-directory.ts';
export { ApiClientError };
export const listManualDirectory = () => requestApi({ path: '/api/v1/school-directory' }, v => (v as { items: ManualDirectorySchool[] }).items);
export const readManualDirectory = (id: string) => requestApi({ path: `/api/v1/school-directory?id=${encodeURIComponent(id)}` }, v => v as DirectoryDetail);
export const maintainManualDirectory = (body: DirectoryCommand, idempotencyKey: string) => requestApi({ path: '/api/v1/school-directory', method: 'POST', body, idempotencyKey }, v => (v as { id: string }).id);
