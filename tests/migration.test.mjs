import assert from "node:assert/strict";
import test from "node:test";
import { parseDstRuleFile, dstTransition, isDstActive } from "../app/dst-rules.ts";
import { solarTimes } from "../app/solar.ts";
import {
  convertLegacyArchive,
  mergeImportedSite,
  normalizeSiteTimeZone,
  stringifyConfiguration,
  isStarterSite,
  upsertImportedConfiguration,
  siteImportDetailsEqual,
} from "../app/fd4cfg.ts";

test("parses recovered FlexiDim DST table semantics", () => {
  const parsed = parseDstRuleFile([
    "UK-Europe", "2100-2116 and 2017-2099", "comment", "comment",
    "4,4,2", "87,176,0", ...Array.from({ length: 16 }, () => "87,176,0"),
    "85,174,0",
  ].join("\n"));
  assert.equal(parsed.rules[0].year, 2100);
  assert.equal(parsed.rules[17].year, 2017);
  assert.equal(parsed.rules[17].endDay, 302);
  assert.equal(parsed.rules[17].offsetMinutes, 60);
  const rule = parsed.rules[17];
  assert.equal(isDstActive(rule, new Date((dstTransition(rule, "start").getTime() + dstTransition(rule, "end").getTime()) / 2)), true);
});

test("calculates plausible sunrise and sunset", () => {
  const result = solarTimes(new Date("2026-07-19T12:00:00Z"), 51.5074, -0.1278);
  assert.ok(result.sunrise);
  assert.ok(result.sunset);
  assert.ok(result.sunrise < result.sunset);
});

test("imports controller-significant hardware, period and user fields", () => {
  const objects = [
    "$null",
    { $classname: "JCLFDHardware" },
    { $class: { CF$UID: 1 }, ky: 100, ty: 0, nm: "Ground", sn: "G", dr: 3, hw: 0, ix: 1, ri: 0 },
    { $class: { CF$UID: 1 }, ky: 200, pr: 100, ty: 2, nm: "Lamp", sn: "L", dr: 4, hw: 12, ix: 2, md: 7000, mn: 5, mx: 90, mp: 95, df: 60, at: 1, am: "7001", dm: 1, hc: 1 },
    { $classname: "JCLFDPeriod" },
    { $class: { CF$UID: 4 }, ix: 2, nm: "Night", st: 60, et: 120, sm: 1, em: 4 },
    { $classname: "JCLFDUser" },
    { $class: { CF$UID: 6 }, ky: 9, nm: "Owner", sc: "0123456789abcdef", rm0: 100, ud: "profile", ve: 3 },
  ];
  const archive = {
    $archiver: "NSKeyedArchiver",
    $objects: objects,
    $top: {
      room: { CF$UID: 2 }, channel: { CF$UID: 3 }, period: { CF$UID: 5 }, user: { CF$UID: 7 },
      $1: "Test", $9: "FD4-TEST", $10: "0123456789abcdef", $11: "192.168.1.2",
      $12: 1, $17: "0.0", $18: 15273, $19: "UK-Europe", modc: 1, $30: "7000",
    },
  };
  const data = convertLegacyArchive(archive);
  assert.equal(data.site.securityCode, "0123456789abcdef");
  assert.equal(data.site.timezone, "Europe/London");
  assert.equal(data.channels[0].minimum, 5);
  assert.equal(data.channels[0].maximum, 90);
  assert.equal(data.channels[0].maximumPermissible, 95);
  assert.equal(data.channels[0].controllerChannel, 2);
  assert.equal(data.periods[0].start, "01:00");
  assert.equal(data.periods[0].startMode, 1);
  assert.equal(data.users[0].key, "0123456789abcdef");
  assert.deepEqual(data.users[0].roomIds, [1]);
});

test("normalizes legacy timezone stepper values to safe IANA zones", () => {
  assert.equal(normalizeSiteTimeZone("0.0", "UK / Europe", "UTC"), "Europe/London");
  assert.equal(normalizeSiteTimeZone("0.0", "No daylight saving", "Europe/Paris"), "UTC");
  assert.equal(normalizeSiteTimeZone("America/New_York", "USA", "UTC"), "America/New_York");
  const normalized = normalizeSiteTimeZone("not/a-zone", "USA", "UTC");
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en-GB", { timeZone: normalized }));
});

test("serializes BigInts retained from binary plist legacy data", () => {
  const serialized = stringifyConfiguration({
    safeInteger: 42n,
    largeInteger: 9_007_199_254_740_993n,
    nested: { value: 7n },
  });
  assert.deepEqual(JSON.parse(serialized), {
    safeInteger: 42,
    largeInteger: "9007199254740993",
    nested: { value: 7 },
  });
});

test("recognizes only the untouched starter site", () => {
  const starter = {
    name: "Home", id: "FD4-0001", ip: "192.168.1.50", port: 15273,
    description: "FlexiDim lighting system", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, securityCode: "",
  };
  const configurations = [{
    id: 1, siteId: "FD4-0001", name: "Home",
    description: "FlexiDim lighting system", lastUpdated: "",
  }];
  assert.equal(isStarterSite(starter, configurations), true);
  assert.equal(isStarterSite({ ...starter, securityCode: "0123456789abcdef" }, configurations), false);
});

test("re-import replaces and collapses matching configurations", () => {
  const configurations = [
    { id: 2, siteId: "07140002", name: "Kitchen", description: "old", lastUpdated: "old" },
    { id: 3, siteId: "07140002", name: "Kitchen", description: "duplicate", lastUpdated: "old" },
    { id: 4, siteId: "07140002", name: "Alternative", description: "keep", lastUpdated: "old" },
  ];
  const result = upsertImportedConfiguration(configurations, {
    id: 0, siteId: "07140002", name: "Kitchen", description: "fresh", lastUpdated: "new",
  }, 3);
  assert.equal(result.configurationId, 3);
  assert.deepEqual(result.configurations.map(({ id, name }) => ({ id, name })), [
    { id: 4, name: "Alternative" },
    { id: 3, name: "Kitchen" },
  ]);
  assert.equal(result.configurations[1].description, "fresh");
});

test("unchanged site imports ignore timestamps and browser-local bridge settings", () => {
  const imported = {
    name: "Kitchen", id: "07140002", ip: "192.168.1.2", port: 15273,
    description: "Controller", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, securityCode: "0123456789abcdef",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  const saved = {
    ...imported,
    updatedAt: "2030-01-01T00:00:00.000Z",
    bridgeUrl: "ws://127.0.0.1:9000",
    bridgeToken: "local-only",
    legacy: { value: 1n },
  };
  assert.equal(siteImportDetailsEqual(saved, imported), true);
  assert.equal(siteImportDetailsEqual({ ...saved, ip: "192.168.1.3" }, imported), false);
});

test("restores an imported controller key while retaining local bridge settings", () => {
  const current = {
    name: "Saved site", id: "FD4-TEST", ip: "192.168.1.2", port: 15273,
    description: "Saved", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, securityCode: "",
    bridgeUrl: "ws://127.0.0.1:9000", bridgeToken: "paired-locally",
  };
  const imported = {
    ...current, name: "Imported site", description: "Imported",
    securityCode: "0123456789abcdef", bridgeUrl: "ws://127.0.0.1:8765",
    bridgeToken: "",
  };

  const keptLocal = mergeImportedSite(current, imported, false);
  assert.equal(keptLocal.name, "Saved site");
  assert.equal(keptLocal.securityCode, "0123456789abcdef");
  assert.equal(keptLocal.bridgeUrl, "ws://127.0.0.1:9000");
  assert.equal(keptLocal.bridgeToken, "paired-locally");

  const usedImport = mergeImportedSite(current, imported, true);
  assert.equal(usedImport.name, "Imported site");
  assert.equal(usedImport.securityCode, "0123456789abcdef");
  assert.equal(usedImport.bridgeUrl, "ws://127.0.0.1:9000");
});
