import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("workspace navigation can collapse and reopen on desktop and mobile", async () => {
  const appFrame = await source("components/layout/AppFrame.tsx");
  const sidebar = await source("components/layout/Sidebar.tsx");
  const topBar = await source("components/layout/TopBar.tsx");
  const styles = await source("app/globals.css");
  const browserHarness = await source("tests/integration/crm-student-create-dev-browser.test.ts");
  const zh = JSON.parse(await source("i18n/zh-TW.json")) as Record<string, unknown>;
  const openNavigation = requiredRecord(zh.layout).open_navigation;

  assert.match(appFrame, /desktopNavigationOpen, setDesktopNavigationOpen/);
  assert.match(appFrame, /function closeNavigation\(\)/);
  assert.match(appFrame, /setDesktopNavigationOpen\(false\)/);
  assert.match(appFrame, /setMobileNavigationOpen\(false\)/);
  assert.match(appFrame, /onClose=\{closeNavigation\}/);
  assert.match(appFrame, /onCloseMobile=\{\(\) => setMobileNavigationOpen\(false\)\}/);
  assert.match(appFrame, /onOpenNavigation=\{\(\) => \{[\s\S]*setDesktopNavigationOpen\(true\)[\s\S]*setMobileNavigationOpen\(true\)/);
  assert.match(sidebar, /desktopOpen \? 'md:flex' : 'md:hidden'/);
  assert.match(sidebar, /title=\{t\('layout\.close_navigation'\)\}/);
  assert.match(sidebar, /<aside id="workspace-navigation"/);
  assert.match(sidebar, /aria-label=\{t\('layout\.close_navigation'\)\}/);
  assert.match(sidebar, /onNavigate=\{mobileOpen \? \(onCloseMobile \?\? onClose\) : undefined\}/);
  assert.equal(topBar.match(/name="menu"/g)?.length, 1);
  assert.match(topBar, /className="icon-button"/);
  assert.match(topBar, /aria-controls="workspace-navigation" aria-expanded=\{desktopNavigationOpen\}[\s\S]*aria-label=\{t\('layout\.open_navigation'\)\}/);
  assert.doesNotMatch(styles, /\.navigation-button/);
  assert.equal(openNavigation, "開啟導航");
  assert.equal(
    browserHarness.includes(
      `getByRole("button", { name: ${JSON.stringify(openNavigation)}, exact: true })`,
    ),
    true,
  );
  assert.doesNotMatch(browserHarness, /name: "展開導航"/);
});

test("workspace navigation is registry-backed, capability-only and fail-closed", async () => {
  const sidebar = await source("components/layout/Sidebar.tsx");

  assert.match(sidebar, /visibleWorkspaceNavigation\(effectiveAuth\?\.capabilities \?\? \[\]\)/);
  assert.match(sidebar, /navItems\.filter\(\(item\) => item\.href !== '\/admin\/access'\)/);
  assert.match(sidebar, /navItems\.some\(\(item\) => item\.href === '\/admin\/access'\)/);
  assert.match(sidebar, /requestApi\(\{ path: '\/api\/v1\/auth\/me'/);
  assert.doesNotMatch(sidebar, /workspaceCapabilitiesForRole|BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE|NAVIGATION_REGISTRY/);
  assert.doesNotMatch(sidebar, /\/admin\/knowledge/);
  assert.doesNotMatch(sidebar, /\/api\/auth\/me/);
  assert.doesNotMatch(sidebar, /\.email\b|initials\(/);
});

test("notification and account controls expose bounded real actions", async () => {
  const sourceText = await source("components/layout/TopBar.tsx");

  assert.match(sourceText, /href="\/notifications"/);
  assert.match(sourceText, /aria-label="通知"/);
  assert.match(sourceText, /unreadCount\(\)/);
  assert.match(sourceText, /href="\/profile"/);
  assert.match(sourceText, /nicknameInitial\(effectiveAuth\.nickname\)/);
  assert.doesNotMatch(sourceText, /openMenu|帳戶選單|workspace-notifications|role="menuitem"/);
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
  assert.match(topBar, /titleKey \? t\(titleKey\) : t\('layout\.erp_title'\)/);
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
