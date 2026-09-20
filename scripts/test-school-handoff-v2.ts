/** Cross-repository conformance: identical bytes, independent expectations, two real CLIs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

type Issue = { path: string; code: string };
type Case = { file: string; valid: boolean; errors: Issue[] };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const producer = process.argv[2];
assert.ok(producer, 'Usage: node scripts/test-school-handoff-v2.ts /path/to/school-tracker/hk-school-platform');
const relative = 'contracts/school-crawl-handoff/v2';
const dir = resolve(root, relative);
const manifest = JSON.parse(readFileSync(resolve(dir, 'cases.json'), 'utf8')) as { cases: Case[] };
const files = manifest.cases.map(c => resolve(dir, c.file));
for (const filename of ['README.md', 'contract.schema.json', 'cases.json', ...manifest.cases.map(c => c.file)]) {
  assert.deepEqual(readFileSync(resolve(dir, filename)), readFileSync(resolve(producer, relative, filename)), `Artifact drift: ${filename}`);
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, `${command}: mixed suite must exit 1 because it contains invalid packages\n${result.stderr}`);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}
const py = run(process.env.PYTHON ?? 'python3', [resolve(producer, 'tools/validate_school_handoff_v2.py'), ...files]);
const ts = run(process.execPath, [resolve(root, 'scripts/validate-school-handoff-v2.ts'), ...files]);
const expected = manifest.cases.map(({ file, ...result }) => ({ sample: basename(file), ...result }));
assert.deepEqual(py, expected, 'Python differs from frozen expectations');
assert.deepEqual(ts, expected, 'TypeScript differs from frozen expectations');
assert.deepEqual(py, ts, 'Python/TypeScript differ');
console.log(`Artifact copies: ${files.length + 3} byte-identical files`);
for (const result of ts) console.log(`${result.valid ? 'ACCEPT' : 'REJECT'} ${result.sample}${result.errors.length ? ' ' + result.errors.map((e: Issue) => `${e.path}:${e.code}`).join(',') : ''}`);
console.log(`Python: ${py.filter(r => r.valid).length} accepted, ${py.filter(r => !r.valid).length} rejected`);
console.log(`TypeScript: ${ts.filter(r => r.valid).length} accepted, ${ts.filter(r => !r.valid).length} rejected`);
console.log(`PASS ${ts.length}/${ts.length} expected decisions; identical error codes and paths`);
