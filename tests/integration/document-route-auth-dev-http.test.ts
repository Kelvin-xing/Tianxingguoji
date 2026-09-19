import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createIsolatedAppDirectory,
  reserveLoopbackPort,
  startNextDev,
  waitForNextDev,
  stopNextDev,
} from './trial-member-browser-assertions.ts';

test('cold and concurrent document routes reject anonymous requests before any database access', { timeout: 90_000 }, async () => {
  const directory = await createIsolatedAppDirectory();
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Deliberately no database: reject before initializing the document runtime.
  const server = startNextDev(directory, port, 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic', baseUrl);
  const route = '/api/v1/tasks/[taskId]/documents/[documentId]/versions/[versionId]/upload-intents/route';
  try {
    await waitForNextDev(baseUrl, server);
    const paths = [
      `/api/v1/tasks/${randomUUID()}/documents/${randomUUID()}/versions/${randomUUID()}/upload-intents`,
      `/api/v1/cases/${randomUUID()}/documents/${randomUUID()}/versions/${randomUUID()}/upload-intents`,
      `/api/v1/tasks/${randomUUID()}/documents/${randomUUID()}/versions/${randomUUID()}/abandonments`,
      `/api/v1/tasks/${randomUUID()}/documents/${randomUUID()}/versions`,
    ];
    const results: { route: number; status: number; json: boolean; code: string | null }[] = [];
    // First hit the cold routes with a valid upload-intent body, then exercise
    // malformed input without credentials. Neither may reach resource services.
    for (const body of [JSON.stringify({ expected_record_version: 1 }), '{}']) {
      const responses = await Promise.all(paths.map(path => fetch(baseUrl + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(20_000),
      })));
      for (const [index, response] of responses.entries()) {
        const json = response.headers.get('content-type')?.includes('application/json') ?? false;
        const payload = json ? await response.json() : null;
        results.push({
          route: index, status: response.status, json,
          code: ['UNAUTHENTICATED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'NOT_FOUND'].includes(payload?.error?.code)
            ? payload.error.code : null,
        });
      }
    }
    if (results.some(row => row.status !== 401 || row.code !== 'UNAUTHENTICATED')) {
      const manifest = await readFile(join(directory, '.next/dev/server/app-paths-manifest.json'), 'utf8')
        .then(text => JSON.parse(text) as Record<string, string>)
        .catch(() => ({} as Record<string, string>));
      const compiled = manifest[route]
        ? await readFile(join(directory, '.next/dev/server', manifest[route])).then(() => true).catch(() => false)
        : false;
      process.stdout.write(JSON.stringify({
        document_route_auth_probe: results,
        uploadManifestPresent: Object.hasOwn(manifest, route), uploadCompiledPresent: compiled,
      }) + '\n');
    }
    assert.ok(results.every(row => row.status === 401 && row.json && row.code === 'UNAUTHENTICATED'),
      'every independent anonymous request must return the authentication envelope');
  } finally {
    await stopNextDev(server);
    await rm(directory, { recursive: true, force: true });
  }
});
