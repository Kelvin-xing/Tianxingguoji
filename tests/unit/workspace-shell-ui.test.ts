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
  assert.match(appFrame, /onCloseDesktop=\{\(\) => \{[\s\S]*setDesktopNavigationOpen\(false\)[\s\S]*setMobileNavigationOpen\(false\)/);
  assert.match(appFrame, /onCloseMobile=\{\(\) => setMobileNavigationOpen\(false\)\}/);
  assert.match(appFrame, /onOpenDesktopNavigation=\{\(\) => \{[\s\S]*setDesktopNavigationOpen\(true\)[\s\S]*setMobileNavigationOpen\(false\)/);
  assert.match(appFrame, /onOpenMobileNavigation=\{\(\) => setMobileNavigationOpen\(true\)\}/);
  const desktopOpenHandler = appFrame.match(/onOpenDesktopNavigation=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(desktopOpenHandler);
  assert.doesNotMatch(desktopOpenHandler, /setMobileNavigationOpen\(true\)/);
  assert.match(sidebar, /desktopOpen \? 'md:flex' : 'md:hidden'/);
  assert.match(sidebar, /title=\{t\('layout\.close_navigation'\)\}/);
  assert.match(sidebar, /<aside id="workspace-navigation"/);
  assert.match(sidebar, /aria-label=\{t\('layout\.close_navigation'\)\}/);
  assert.match(sidebar, /onNavigate=\{mobileOpen \? onCloseMobile : undefined\}/);
  assert.doesNotMatch(sidebar, /onNavigate=\{mobileOpen \? onCloseDesktop/);
  assert.equal(topBar.match(/name="menu"/g)?.length, 1);
  assert.match(topBar, /className="icon-button navigation-button desktop-navigation-button mobile-navigation-button"/);
  assert.match(topBar, /aria-label=\{t\('layout\.open_navigation'\)\} aria-controls="workspace-navigation"/);
  assert.match(topBar, /window\.matchMedia\('\(min-width: 768px\)'\)\.matches[\s\S]*onOpenDesktopNavigation\?\.\(\)[\s\S]*onOpenMobileNavigation\?\.\(\)/);
  assert.match(styles, /\.navigation-button \{ display: inline-flex; \}/);
  assert.match(styles, /@media \(min-width: 768px\)[\s\S]*\.navigation-button\[data-desktop-navigation-open="true"\] \{ display: none; \}/);
  assert.equal(openNavigation, "展開導航");
  assert.equal(
    browserHarness.includes(
      `getByRole("button", { name: ${JSON.stringify(openNavigation)}, exact: true })`,
    ),
    true,
  );
  assert.doesNotMatch(browserHarness, /name: "開啟導航"/);
});

test("workspace navigation is registry-backed, capability-only and fail-closed", async () => {
  const sidebar = await source("components/layout/Sidebar.tsx");

  assert.match(sidebar, /import \{ NAVIGATION_REGISTRY, type NavigationRegistryItem \}/);
  assert.match(sidebar, /getWorkspaceAccessSnapshot\(controller\.signal\)/);
  assert.match(sidebar, /accessState === 'ready' && accessSnapshot[\s\S]*NAVIGATION_REGISTRY\.filter\(\(item\) => accessSnapshot\.capabilities\.includes\(item\.requiredCapability\)\)[\s\S]*: \[\]/);
  assert.match(sidebar, /visibleNavigationItems\.filter\(\(item\) => item\.audience === 'workspace'\)/);
  assert.match(sidebar, /visibleNavigationItems\.filter\(\(item\) => item\.audience === 'administration'\)/);
  assert.match(sidebar, /workspaceItems\.length > 0 \?/);
  assert.match(sidebar, /administrationItems\.length > 0 \?/);
  assert.doesNotMatch(sidebar, /const (?:navItems|adminItems)/);
  assert.doesNotMatch(sidebar, /workspaceCapabilitiesForRole|BOOTSTRAP_WORKSPACE_CAPABILITIES_BY_ROLE/);
  assert.doesNotMatch(sidebar, /\/admin\/knowledge/);
  assert.doesNotMatch(sidebar, /\/api\/auth\/me/);
  assert.doesNotMatch(sidebar, /\.email\b|initials\(/);
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
