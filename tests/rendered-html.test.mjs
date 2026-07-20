import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders FlexiDim Web", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>FlexiDim Web — Lighting Configuration<\/title>/i);
  assert.match(html, /FlexiDim/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("configuration picker accepts original iOS backups", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /accept="[^"]*\.fd4cfg/i);
  assert.match(source, /parseLegacyFd4Config\(await file\.arrayBuffer\(\)\)/);
  assert.doesNotMatch(
    source,
    /className="config-import"\s+disabled=/,
    "configuration import must remain available before installer unlock",
  );
});

test("retains the iOS navigation order and drill-down configuration hierarchy", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const importer = await readFile(new URL("../app/fd4cfg.ts", import.meta.url), "utf8");
  const orderedTabs = [
    '"Configurations"',
    '"Basic Assignments"',
    '"Scenes"',
    '"Scene to Button"',
    '"Users"',
    '"Periods"',
    '"Equipment"',
    '"Trace"',
  ];
  const positions = orderedTabs.map((tab) => page.indexOf(tab, page.indexOf("const tabs")));
  assert.ok(positions.every((position) => position >= 0), "all iOS navigation items should be present");
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "navigation items should retain the iOS order");
  assert.match(page, /className="area-tier area-drilldown"/);
  assert.match(page, /setAreaMenuParent\(null\)/);
  assert.match(page, /‹ Floors/);
  assert.match(page, /restoreAreaHierarchy\(value\)/);
  assert.match(page, /visibleSceneGroups/);
  assert.match(page, /setSceneGroupId\(group\.id\)/);
  assert.match(page, /className="scene-info-button"/);
  assert.match(importer, /parentId:/);
  assert.match(importer, /folderPath:/);
  assert.match(importer, /sceneGroups/);
  assert.match(importer, /parentKey === -4/);
  assert.match(importer, /deletedScenes/);
});

test("provides recovered iOS scene and channel editing controls", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const panel = page.slice(page.indexOf("const scenesPanel"), page.indexOf("const currentSceneButtonSwitch"));
  for (const label of [
    "Preview changes",
    "Scene name",
    "Short name",
    "Channels affected by scene",
    "Brightness:",
    "Fade time",
    "Auto start",
    "Relative %",
    "100% time",
    "Rules",
    "Only when last scene was",
    "Any scene",
    "Periods",
    "State flags",
    "Additional process",
    "Additionally run scene",
  ]) assert.match(panel, new RegExp(label, "i"));
  for (const label of [
    "After delay of:",
    "At time:",
    "Before sunrise, offset:",
    "After sunrise, offset:",
    "Before sunset, offset:",
    "After sunset, offset:",
    "Cancel sequence",
    "Reset cycle",
    "Any day",
    "Mon - Fri",
  ]) assert.match(page, new RegExp(label, "i"));
  assert.match(panel, /On day\(s\)/i);
  assert.match(panel, /currentSceneTimerHour << 8/);
  assert.match(panel, /currentSceneDelayMinutes \* 30/);
  // The fabricated per-channel "Change brightness" conditions were removed;
  // the Rules/Periods/State flags control now hosts the sequence and linked
  // scene, matching the iOS app.
  assert.doesNotMatch(panel, /Change brightness/i);
  assert.doesNotMatch(panel, /▶ Run scene/);
  assert.match(panel, /currentSceneGroup\?\.name \?\? "Scenes"/);
  assert.match(panel, /Deleted scenes/);
  assert.match(panel, /restoreDeletedScene/);
  assert.doesNotMatch(panel, /currentSceneGroup\?\.name \?\? "Floors"/);
});

test("uses the iOS-style site list and header changes switch", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const sitesPanel = page.slice(page.indexOf("const sitesPanel"), page.indexOf("const configPanel"));
  assert.match(sitesPanel, /My FlexiDim sites/);
  assert.match(sitesPanel, /＋ Create site/);
  assert.doesNotMatch(sitesPanel, /<small>AREAS<\/small>|room-strip/);
  assert.match(page, /role="switch"/);
  assert.match(page, /Allow configuration changes/);
  assert.doesNotMatch(page, /className="more-button"/);
});

test("retains installer assignment, sequence, switch-button, and equipment utilities", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const label of [
    "Assign for on",
    "Assign for dimming",
    "Assign for channel dimming",
    "On fade time",
    "Off fade time",
    "Off priority",
    "Create extractor sequence",
    "Create security sequence",
    "Create simple sequence",
    "First press",
    "Second press",
    "＋ Light",
  ]) assert.match(page, new RegExp(label));
  assert.match(page, /setBasicFloor/);
  assert.match(page, /setBasicRoom/);
  assert.match(page, /setBasicSwitchId/);
  assert.match(page, /setSceneButtonFloor/);
  assert.match(page, /setSceneButtonRoom/);
  assert.match(page, /aria-label="Add floor"/);
});

test("provides the recovered equipment browser and hardware editors", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const label of [
    "Modules",
    "Switch overview",
    "Deleted items",
    "Room icon",
    "Names for Remote Control app",
    "Channel type explanation",
    "Accessory module",
    "Test dimming",
    "Detect by button press",
    "Detect switch types",
    "LED brightness",
    "Default brightness",
    "Resend all configuration information",
    "Export configuration details",
  ]) assert.match(page, new RegExp(label));
  assert.match(page, /Edit \$\{area\.name\} information/);
  assert.match(page, /moveToDeleted/);
  assert.match(page, /restoreDeleted/);
});

test("provides per-channel basic assignment controls and help", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const basicPanel = page.slice(page.indexOf("const assignmentsPanel"), page.indexOf("const scenesPanel"));
  for (const label of [
    "Add channels",
    "Adjust order",
    "Select all",
    "Deselect all",
    "Assign for on",
    "Assign for off",
    "Assign for dimming",
    "Assign for channel dimming",
    "On priority",
    "Off priority",
    "On fade time",
    "Off fade time",
  ]) assert.match(basicPanel, new RegExp(label));
  assert.match(basicPanel, /type="checkbox"/);
  assert.match(basicPanel, /help="How long this light takes/);
  assert.match(basicPanel, /value=\{selectedBasicChannelSettings\.onFade\}/);
  assert.doesNotMatch(basicPanel, /<Field label="Off priority">\s*<select/);
});

test("converted IPA artwork is present", async () => {
  for (const asset of ["sites.png", "configurations.png", "scenes.png", "switches.png", "rooms/0.png", "rooms/103.png"]) {
    const info = await stat(new URL(`../public/flexidim/${asset}`, import.meta.url));
    assert.ok(info.size > 100, `${asset} should contain converted artwork`);
  }
});
