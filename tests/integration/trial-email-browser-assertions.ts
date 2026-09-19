import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page, APIRequestContext } from 'playwright-core';

export async function assertTrialEmailBrowser(input: {
  page: Page; l1Page: Page; l2: APIRequestContext; baseUrl: string;
}): Promise<void> {
  const { page, l1Page, l2, baseUrl } = input;
  const scenarios = [
    { pagePath: '/admin/email', api: '/api/v1/email/settings', field: '發件名稱',
      value: 'Synthetic sender', save: '儲存設定', retry: '重試原設定',
      success: 'Resend 設定已安全儲存。API 密鑰不會再次顯示。', denied: '無法查看郵件設定',
      data: { api_key: 're_synthetic_browser_email', from_email: 'browser@example.test.invalid', from_name: 'Synthetic sender', expected_record_version: null } },
    { pagePath: '/admin/email/templates', api: '/api/v1/email/templates/internal-user-invitation', field: '郵件主旨',
      value: 'Synthetic browser invitation', save: '儲存範本', retry: '重試原範本',
      success: '郵件範本已儲存。', denied: '無法查看郵件範本',
      data: { subject: 'Synthetic browser invitation', body_text: 'Synthetic browser instructions.', expected_record_version: null } },
  ] as const;
  for (const scenario of scenarios) {
    const url = baseUrl + scenario.api;
    for (const request of [l1Page.request, l2]) {
      assert.equal((await request.get(url)).status(), 403);
      assert.equal((await request.put(url, { headers: { 'idempotency-key': randomUUID() }, data: scenario.data })).status(), 403);
    }
    await l1Page.goto(baseUrl + scenario.pagePath);
    await l1Page.getByText('目前帳號無法查看此工作區', { exact: true }).waitFor();
    assert.equal(await l1Page.getByLabel(scenario.field, { exact: true }).count(), 0);
    await page.goto(baseUrl + scenario.pagePath);
    await page.getByLabel(scenario.field, { exact: true }).fill(scenario.value);
    if (scenario.pagePath === '/admin/email') {
      await page.getByLabel('Resend API 密鑰', { exact: true }).fill('re_synthetic_browser_email');
      await page.getByLabel('發件電郵', { exact: true }).fill('browser@example.test.invalid');
    } else {
      await page.getByLabel('正文說明', { exact: true }).fill('Synthetic browser instructions.');
    }
    const keys: string[] = [];
    await page.route(url, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      keys.push(route.request().headers()['idempotency-key']!);
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      if (keys.length === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic lost acknowledgement', request_id: 'synthetic-email' },
        }) });
      } else { await route.fulfill({ response }); }
    });
    await page.getByRole('button', { name: scenario.save, exact: true }).click();
    await page.getByRole('button', { name: scenario.retry, exact: true }).waitFor();
    assert.equal(await page.getByLabel(scenario.field, { exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: scenario.retry, exact: true }).click();
    await page.getByText(scenario.success, { exact: true }).waitFor();
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    await page.unroute(url);
    await page.reload();
    await page.getByLabel(scenario.field, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(scenario.field, { exact: true }).inputValue(), scenario.value);
    const response = await page.request.get(url);
    assert.equal(response.status(), 200);
    const payload = await response.json();
    assert.equal(payload.data.record_version, 1);
    assert.doesNotMatch(JSON.stringify(payload), /re_synthetic|ciphertext|auth_tag/);
    if (scenario.pagePath === '/admin/email') assert.equal(await page.getByLabel('Resend API 密鑰', { exact: true }).inputValue(), '');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `/tmp/access-trial-email-${scenario.pagePath.endsWith('templates') ? 'template' : 'settings'}-mobile.png`, fullPage: true });
    // A colleague's newer version makes this open form stale; reload clears the old attempt.
    const concurrent = await page.request.put(url, {
      headers: { 'idempotency-key': randomUUID() }, data: { ...scenario.data, expected_record_version: 1 },
    });
    assert.equal(concurrent.status(), 200);
    await page.getByLabel(scenario.field, { exact: true }).fill('Stale form must not overwrite');
    if (scenario.pagePath === '/admin/email') await page.getByLabel('Resend API 密鑰', { exact: true }).fill('re_synthetic_stale_value');
    const stale = page.waitForResponse(response => response.url() === url && response.request().method() === 'PUT');
    await page.getByRole('button', { name: scenario.pagePath === '/admin/email' ? '輪換並儲存' : scenario.save, exact: true }).click();
    assert.equal((await stale).status(), 409);
    await page.getByText(scenario.pagePath === '/admin/email' ? '設定已變更，請重新載入後再核對。' : '範本已變更，請重新載入後再核對。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新載入', exact: true }).click();
    await page.getByLabel(scenario.field, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(scenario.field, { exact: true }).inputValue(), scenario.value);
    assert.equal(await page.getByLabel(scenario.field, { exact: true }).isEnabled(), true);
    if (scenario.pagePath === '/admin/email') assert.equal(await page.getByLabel('Resend API 密鑰', { exact: true }).inputValue(), '');
    // A lost permission during save must remove both the editor and its preview/secret.
    await page.getByLabel(scenario.field, { exact: true }).fill('Must disappear');
    if (scenario.pagePath === '/admin/email') await page.getByLabel('Resend API 密鑰', { exact: true }).fill('re_synthetic_denied_value');
    await page.route(url, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Synthetic revoked access', request_id: 'synthetic-email-denied' } }) });
    });
    await page.getByRole('button', { name: scenario.pagePath === '/admin/email' ? '輪換並儲存' : scenario.save, exact: true }).click();
    await page.getByText(scenario.denied, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(scenario.field, { exact: true }).count(), 0);
    assert.equal(await page.getByText('Must disappear', { exact: true }).count(), 0);
    await page.unroute(url);
  }
  process.stdout.write(JSON.stringify({ trial_email_browser: 'pass', founder: 'save_reload', l1_l2: 'get_put_denied', lost_ack: 'original_key_single_version', denied: 'editor_cleared', viewport: 390 }) + '\n');
}
