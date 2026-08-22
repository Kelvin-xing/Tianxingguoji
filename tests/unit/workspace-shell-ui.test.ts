import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("workspace navigation can collapse and reopen on desktop and mobile", async () => {
  const appFrame = await source("components/layout/AppFrame.tsx");
  const sidebar = await source("components/layout/Sidebar.tsx");
  const topBar = await source("components/layout/TopBar.tsx");
  const styles = await source("app/globals.css");

  assert.match(appFrame, /desktopNavigationOpen, setDesktopNavigationOpen/);
  assert.match(appFrame, /setDesktopNavigationOpen\(false\)[\s\S]*setMobileNavigationOpen\(false\)/);
  assert.match(appFrame, /setDesktopNavigationOpen\(true\)[\s\S]*setMobileNavigationOpen\(true\)/);
  assert.match(sidebar, /desktopOpen \? 'md:flex' : 'md:hidden'/);
  assert.match(sidebar, /title=\{t\('layout\.close_navigation'\)\}/);
  assert.match(topBar, /mobile-navigation-button/);
  assert.match(topBar, /!desktopNavigationOpen[\s\S]*desktop-navigation-button/);
  assert.match(styles, /\.mobile-navigation-button \{ display: inline-flex; \}/);
  assert.match(styles, /@media \(min-width: 768px\)[\s\S]*\.mobile-navigation-button \{ display: none; \}[\s\S]*\.desktop-navigation-button \{ display: inline-flex; \}/);
});

test("notification and account controls expose bounded real actions", async () => {
  const sourceText = await source("components/layout/TopBar.tsx");

  assert.match(sourceText, /aria-expanded=\{openMenu === 'notifications'\}/);
  assert.match(sourceText, /layout\.notifications_unavailable/);
  assert.doesNotMatch(sourceText, /notification[s]?[\s\S]*\.map\(/i);
  assert.match(sourceText, /aria-expanded=\{openMenu === 'account'\}/);
  assert.match(sourceText, /href="\/api\/auth\/logout"/);
  assert.match(sourceText, /role="menuitem"/);
  assert.match(sourceText, /event\.key !== 'Escape'/);
  assert.match(sourceText, /requestAnimationFrame\(\(\) => trigger\?\.focus\(\)\)/);
  assert.match(sourceText, /document\.addEventListener\('pointerdown', closeMenus\)/);
  assert.match(sourceText, /notificationPanelRef\.current\?\.focus\(\)/);
  assert.match(sourceText, /logoutLinkRef\.current\?\.focus\(\)/);
});

test("language toggle updates the translated shell and document language", async () => {
  const provider = await source("lib/i18n-provider.tsx");
  const sidebar = await source("components/layout/Sidebar.tsx");
  const topBar = await source("components/layout/TopBar.tsx");
  const zh = JSON.parse(await source("i18n/zh-TW.json")) as Record<string, unknown>;
  const en = JSON.parse(await source("i18n/en.json")) as Record<string, unknown>;

  assert.match(provider, /document\.documentElement\.lang/);
  assert.match(provider, /catch \{[\s\S]*Language switching remains available/);
  assert.match(sidebar, /t\(item\.labelKey\)/);
  assert.match(topBar, /const title = titleKey \? t\(titleKey\) : t\('layout\.erp_title'\)/);
  assert.deepEqual(Object.keys(requiredRecord(zh.layout)).sort(), Object.keys(requiredRecord(en.layout)).sort());
  assert.deepEqual(Object.keys(requiredRecord(zh.nav)).sort(), Object.keys(requiredRecord(en.nav)).sort());
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

function requiredRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
