import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NAVIGATION_REGISTRY } from "../../../components/layout/navigation-registry.ts";
import { isWorkspaceCapability } from "../../../modules/access/public.ts";
import { RELEASE_ONE_NAVIGATION_PLACEHOLDERS } from "../../../modules/future/public.ts";

const EXPECTED_NAVIGATION = Object.freeze([
  ["/today", "today.read", "workspace"],
  ["/cases", "cases.read", "workspace"],
  ["/students", "students.read", "workspace"],
  ["/schools", "schools.read", "workspace"],
  ["/tasks", "tasks.read", "workspace"],
  ["/documents", "documents.read", "workspace"],
  ["/admin/access", "access.manage", "administration"],
  ["/admin/schools", "schools.manage", "administration"],
  ["/admin/crawler", "crawler.manage", "administration"],
] as const);

test("registers exactly the nine approved capability-backed navigation routes", () => {
  assert.deepEqual(
    NAVIGATION_REGISTRY.map(({ route, requiredCapability, audience }) => [
      route,
      requiredCapability,
      audience,
    ]),
    EXPECTED_NAVIGATION,
  );
  assert.equal(new Set(NAVIGATION_REGISTRY.map(({ route }) => route)).size, 9);
  assert.equal(NAVIGATION_REGISTRY.every(({ requiredCapability }) => (
    isWorkspaceCapability(requiredCapability)
  )), true);
});

test("keeps every registry entry runtime-neutral and free of role policy", () => {
  const expectedFields = [
    "activeMatch",
    "audience",
    "iconKey",
    "labelKey",
    "requiredCapability",
    "route",
  ];
  for (const item of NAVIGATION_REGISTRY) {
    assert.deepEqual(Object.keys(item).sort(), expectedFields);
    assert.equal("role" in item, false);
    assert.equal("roles" in item, false);
    assert.equal(Object.isFrozen(item), true);
  }
  assert.equal(Object.isFrozen(NAVIGATION_REGISTRY), true);
});

test("excludes forbidden, platform, portal, contractor-detail, and Future routes", () => {
  const routes = new Set<string>(NAVIGATION_REGISTRY.map(({ route }) => route));
  for (const excluded of [
    "/admin/knowledge",
    "/platform/billing",
    "/portal/access",
    "/portal/workspace",
    "/contractor/tasks/[taskId]",
  ]) {
    assert.equal(routes.has(excluded), false, excluded);
  }
  for (const placeholder of RELEASE_ONE_NAVIGATION_PLACEHOLDERS) {
    assert.equal("route" in placeholder, false);
    assert.equal("requiredCapability" in placeholder, false);
  }
});

test("provides every registry label key in matching Chinese and English resources", async () => {
  const [chinese, english] = await Promise.all([
    readJson(new URL("../../../i18n/zh-TW.json", import.meta.url)),
    readJson(new URL("../../../i18n/en.json", import.meta.url)),
  ]);
  assert.deepEqual(Object.keys(expectRecord(chinese.nav)).sort(), Object.keys(expectRecord(english.nav)).sort());

  for (const { labelKey } of NAVIGATION_REGISTRY) {
    for (const resource of [chinese, english]) {
      const value = resolveKey(resource, labelKey);
      assert.equal(typeof value, "string", labelKey);
      assert.notEqual((value as string).trim(), "", labelKey);
    }
  }
});

async function readJson(url: URL): Promise<Readonly<Record<string, unknown>>> {
  return expectRecord(JSON.parse(await readFile(url, "utf8")) as unknown);
}

function resolveKey(resource: Readonly<Record<string, unknown>>, key: string): unknown {
  return key.split(".").reduce<unknown>((value, segment) => expectRecord(value)[segment], resource);
}

function expectRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}
