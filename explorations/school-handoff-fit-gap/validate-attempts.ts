/** Exploratory bridge only. Calls the unchanged v2 validator; never repairs input. */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { validateText } from '../../scripts/validate-school-handoff-v2.ts';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node validate-attempts.ts attempts.jsonl.gz output.jsonl');
const lines = gunzipSync(readFileSync(input)).toString('utf8').trim().split('\n');
const results = lines.map(line => {
  const row = JSON.parse(line) as { school_key: string; package: unknown };
  return JSON.stringify({ school_key: row.school_key, ...validateText(JSON.stringify(row.package)) });
});
writeFileSync(output, results.join('\n') + '\n');
console.log(`TypeScript actual validator: ${results.length} packages evaluated`);
