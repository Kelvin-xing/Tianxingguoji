import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Real interactions, retries, persistence and mobile layout are exercised by
// trial-crm-guardian-http-assertions.ts against Next, Chrome and PostgreSQL.
const panelPath=new URL('../../../components/crm/GuardianRelationshipPanel.tsx',import.meta.url);
test('guardian management does not bypass the module client or expose internal identifiers as input',async()=>{
  const source=await readFile(panelPath,'utf8');
  assert.doesNotMatch(source,/f2-contract|localStorage|sessionStorage|console\.|fetch\(/);
  assert.doesNotMatch(source,/<input[^>]+(?:guardian_id|record_version)/);
  assert.doesNotMatch(source,/access\.role|role === ['"](?:founder|advisor|admin)/);
});
test('relationship screen retains independently controlled duties and excludes primary from attachment input',async()=>{
  const source=await readFile(panelPath,'utf8');
  assert.doesNotMatch(source,/name=['"]is_primary_contact['"]|other_guardian|次要聯絡人/);
  for(const label of ['法定監護人','緊急聯絡人','帳單聯絡人','同意接收通知'])assert.ok(source.includes(label));
});
