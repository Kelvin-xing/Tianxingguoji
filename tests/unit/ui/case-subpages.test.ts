import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import ts from 'typescript';

const root = new URL('../../../', import.meta.url);
type NextResolve = (specifier: string, context: { parentURL?: string }) => { url: string; shortCircuit?: boolean };
type NextLoad = (url: string, context: { format?: string }) => { format: string; source: string; shortCircuit?: boolean };
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: {
  resolve: (specifier: string, context: { parentURL?: string }, next: NextResolve) => ReturnType<NextResolve>;
  load: (url: string, context: { format?: string }, next: NextLoad) => ReturnType<NextLoad>;
}): { deregister(): void } };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') return next('next/link.js', context);
    if (specifier.startsWith('@/') || specifier.startsWith('./')) {
      const url = specifier.startsWith('@/') ? new URL(specifier.slice(2), root) : new URL(specifier, context.parentURL);
      for (const extension of ['', '.tsx', '.ts']) {
        const candidate = new URL(url.href + extension);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
    };
    return next(url, context);
  },
});
const { CasePageTabs } = await import('../../../components/cases/CasePageTabs.tsx');
const { documentVersionTone } = await import('../../../components/documents/document-ui.tsx');
const { CaseHeader } = await import('../../../components/cases/CaseHeader.tsx');
const translation = i18next.createInstance();
await translation.init({ lng: 'zh-TW', resources: { 'zh-TW': { translation: JSON.parse(readFileSync(new URL('i18n/zh-TW.json', root), 'utf8')) } } });

for (const current of ['overview', 'assessment', 'applications', 'interviews', 'documents'] as const) {
  test(`case tabs highlight only ${current} and preserve all five routes`, () => {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: translation }, createElement(CasePageTabs, { caseId: 'synthetic', current })));
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    const target = current === 'overview' ? '/cases/synthetic' : `/cases/synthetic/${current}`;
    assert.ok(html.includes(`href="${target}" class="ui-route-tab selected" aria-current="page"`));
    for (const suffix of ['', '/assessment', '/applications', '/interviews', '/documents']) assert.ok(html.includes(`href="/cases/synthetic${suffix}"`));
  });
}
test('shared case header retains facts, suppresses email when named, and renders no technical IDs', () => {
  const record = { studentName: '合成學生', caseNumber: 'SYNTHETIC-01', intakeYear: 2026, admissionType: 'entry', primaryBindingLabel: '合成顧問 · synthetic@local.invalid', stage: 'background_collection' };
  const html = renderToStaticMarkup(createElement(CaseHeader, { record }));
  for (const text of ['合成學生', 'SYNTHETIC-01', '2026', '首次入學', '合成顧問', '背景資料']) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /@local.invalid|record_version|版本/);
  const fallback = renderToStaticMarkup(createElement(CaseHeader, { record: { ...record, primaryBindingLabel: '未設置暱稱 · synthetic@local.invalid' } }));
  assert.match(fallback, /synthetic@local.invalid/);
});
test('document attention colors do not change labels or lifecycle values', () => {
  for (const state of [null, 'pending_upload', 'pending_delete', 'rejected', 'scan_failed', 'abandoned'] as const) assert.equal(documentVersionTone(state), 'warning');
  assert.equal(documentVersionTone('available'), 'primary');
  for (const state of ['quarantined', 'scanning', 'superseded', 'deleted'] as const) assert.equal(documentVersionTone(state), 'neutral');
});
test.after(() => hooks.deregister());
