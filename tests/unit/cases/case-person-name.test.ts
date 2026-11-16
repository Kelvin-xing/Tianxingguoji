import assert from 'node:assert/strict';
import test from 'node:test';
import { casePersonName } from '../../../components/cases/case-person-name.ts';

test('person presentation hides contact only when an existing name is present', () => {
  assert.equal(casePersonName('Synthetic Advisor · advisor@local.invalid'), 'Synthetic Advisor');
  assert.equal(casePersonName('Synthetic · Advisor · advisor@local.invalid'), 'Synthetic · Advisor');
  assert.equal(casePersonName('未设置昵称 · advisor@local.invalid'), 'advisor@local.invalid');
  assert.equal(casePersonName(' · advisor@local.invalid'), 'advisor@local.invalid');
  assert.equal(casePersonName('advisor@local.invalid'), 'advisor@local.invalid');
  assert.equal(casePersonName('Synthetic Advisor · 未提供邮箱'), 'Synthetic Advisor');
  assert.equal(casePersonName('L3 · 00000314'), 'L3 · 00000314');
});
