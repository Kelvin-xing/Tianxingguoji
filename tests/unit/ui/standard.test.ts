import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Node 22 exposes synchronous hooks; the repository's existing Node types predate them.
type LoadResult = { format: string; source: string; shortCircuit?: boolean };
type LoadContext = { format?: string };
type NextLoad = (url: string, context: LoadContext) => LoadResult;
const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: { load(url: string, context: LoadContext, nextLoad: NextLoad): LoadResult }): { deregister(): void };
};
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/ui/standard.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    if (url.endsWith('/components/ui/standard.tsx')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const ui = await import('../../../components/ui/standard.tsx');
hooks.deregister();

test('shared inputs retain labels, unknown values and arbitrary existing choices', () => {
  const input = renderToStaticMarkup(createElement(ui.Input, { label: '電郵', type: 'email', name: 'email', required: true }));
  assert.match(input, /<label[^>]*><span>電郵<\/span><input/);
  assert.match(input, /type="email"/);
  assert.match(input, /required=""/);
  const select = renderToStaticMarkup(createElement(ui.Select, { label: '學段', defaultValue: '既有值' }, [
    createElement('option', { key: 'unknown', value: '' }, '未知'),
    createElement('option', { key: 'old', value: '既有值' }, '既有值'),
  ]));
  assert.match(select, /value="既有值" selected=""/);
  assert.match(select, /value=""/);
});

test('shared controls communicate status and preserve native disabled behavior', () => {
  assert.match(renderToStaticMarkup(createElement(ui.Button, { disabled: true, variant: 'primary' }, '儲存')), /disabled=""/);
  assert.match(renderToStaticMarkup(createElement(ui.Notice, { warning: true }, '保留輸入')), /role="alert"/);
  assert.match(renderToStaticMarkup(createElement(ui.Notice, {}, '載入中')), /role="status"/);
  const table = renderToStaticMarkup(createElement(ui.Table, { headings: ['學校'] }, createElement('tr', {}, createElement('td', {}, '合成'))));
  assert.match(table, /tabindex="0"/);
  assert.match(table, /scope="col"/);
});

test('standard text/background pairs meet 4.5 to 1 contrast', () => {
  const luminance = (hex: string) => {
    const c = hex.match(/../g)!.map(x => parseInt(x, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722;
  };
  for (const [fg, bg] of [['FFFFFF', '0F766E'], ['1F2937', 'F1F5F4'], ['4B5563', 'FFFFFF'], ['0B5A54', 'D5EFEB'], ['6B4100', 'FBE8C8'], ['374151', 'E5E9E8'], ['4B5563', 'E8EDEC']]) {
    const a = luminance(fg!), b = luminance(bg!);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${fg}/${bg}`);
  }
});

test('read-only information omits missing fields but retains false and zero values', () => {
  const html = renderToStaticMarkup(createElement(ui.FilledData, {
    items: [
      { label: '空資料', value: '未知', filled: false },
      { label: '住宿', value: '否', filled: true },
      { label: '數量', value: 0, filled: true },
    ],
    missingLabel: count => `尚有 ${count} 項未填寫`,
  }));
  assert.doesNotMatch(html, /空資料|未知/);
  assert.match(html, /住宿/);
  assert.match(html, /<dd>否<\/dd>/);
  assert.match(html, /<dd>0<\/dd>/);
  assert.match(html, /尚有 1 項未填寫/);
  const complete = renderToStaticMarkup(createElement(ui.FilledData, { items: [{ label: '名稱', value: '合成', filled: true }], missingLabel: count => `尚有 ${count} 項未填寫` }));
  assert.match(complete, /尚有 0 項未填寫/);
});

test('card edit action is grouped with its heading and uses the text button variant', () => {
  const html = renderToStaticMarkup(createElement(ui.Card, {
    title: '名稱', action: createElement(ui.Button, { variant: 'text' }, '編輯資料'),
  }, '資料'));
  assert.match(html, /ui-card-heading.*<h2>名稱<\/h2><button[^>]*ui-text/);
  assert.doesNotMatch(html, /ui-primary/);
});


test('case form controls preserve native validation, field identity and disabled state', () => {
  const input = renderToStaticMarkup(createElement(ui.FieldInput, { type: 'datetime-local', name: 'due_local', required: true, disabled: true, 'aria-label': '到期時間' }));
  for (const attribute of ['type="datetime-local"', 'name="due_local"', 'required=""', 'disabled=""', 'aria-label="到期時間"']) assert.ok(input.includes(attribute));
  const area = renderToStaticMarkup(createElement(ui.TextArea, { name: 'reason', required: true, maxLength: 1000, rows: 4 }));
  assert.match(area, /maxLength="1000"/i);
  assert.match(area, /name="reason"/);
  const select = renderToStaticMarkup(createElement(ui.FieldSelect, { name: 'status', defaultValue: 'active' }, createElement('option', { value: 'active' }, '進行中')));
  assert.match(select, /value="active" selected=""/);
});
