import assert from "node:assert/strict";
import test from "node:test";
import { parseDstRuleFile, dstTransition, isDstActive } from "../app/dst-rules.ts";
import { solarTimes } from "../app/solar.ts";
import {
  buildUserProfileData,
  canonicalizeAppData,
  controllerConnectionRequest,
  convertLegacyArchive,
  deleteConfigEntity,
  isFlexiDimWorkspace,
  materializeAppData,
  mergeLegacyBrowserConnectionState,
  migrateWorkspaceControllerCode,
  migrateWorkspaceChannelProfileOrder,
  migrateWorkspaceImportedUserAccess,
  normalizePeriodTables,
  orderUserAccess,
  mergeImportedSite,
  normalizeSiteTimeZone,
  stringifyConfiguration,
  isStarterSite,
  upsertImportedConfiguration,
  updateUserProfile,
  siteImportDetailsEqual,
  siteImportDifferences,
  validateConfigContent,
} from "../app/fd4cfg.ts";

test("migrates the old web 35-period table into iOS periods and state flags", () => {
  const oldRows = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1,
    name: index < 10 ? `Period ${index + 1}` : `Flag ${index - 9}`,
    start: "01:00",
    end: "02:00",
    days: ["Mon"],
    enabled: true,
    startMode: 4,
    endMode: 4,
    legacyIndex: index,
  }));

  const migrated = normalizePeriodTables(oldRows);
  assert.equal(migrated.periods.length, 10);
  assert.equal(migrated.periods[9].name, "Period 10");
  assert.equal(migrated.stateFlags.length, 25);
  assert.equal(migrated.stateFlags[0].name, "Flag 1");
  assert.equal(migrated.stateFlags[24].name, "Flag 25");
});

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
  // Archive keys here are the real iOS coder keys recovered from the binary and
  // validated against a genuine `.fd4cfg` (see PROTOCOL.md): hardware limits
  // mi/mx/mp/df, accessory ac, dimmable di, changed ch, rank ra; user security
  // key sk, access count rc, access entries rm0..rmN, profile version ve.
  const objects = [
    "$null",
    { $classname: "JCLFDHardware" },
    { $class: { CF$UID: 1 }, ky: 100, ty: 0, nm: "Ground", sn: "G", ra: 3, hw: 0, ix: 1, ri: 0 },
    { $class: { CF$UID: 1 }, ky: 200, pr: 100, ty: 2, nm: "Lamp", sn: "L", ra: 4, hw: 12, ix: 2, md: 7000, mi: 5, mx: 90, mp: 95, df: 60, ac: 1, di: 1, ch: 1 },
    { $classname: "JCLFDPeriod" },
    { $class: { CF$UID: 4 }, ix: 2, nm: "Night", st: 60, et: 120, sm: 1, em: 4 },
    { $classname: "JCLFDUser" },
    { $class: { CF$UID: 6 }, ky: 9, nm: "Owner", sk: "0123456789abcdef", rc: 2, rm0: "access-entry-a", rm1: "access-entry-b", ve: 3 },
    { $classname: "JCLFDScene" },
    { ky: 200, br: 72, t1: 6, de: 4, fl: 0x90 },
    { $class: { CF$UID: 8 }, ky: 300, nm: "Evening", sn: "Eve", dr: 7, fl: 0xa0, lk: 1, ty: 4, ch0: { CF$UID: 9 } },
  ];
  const archive = {
    $archiver: "NSKeyedArchiver",
    $objects: objects,
    $top: {
      room: { CF$UID: 2 }, channel: { CF$UID: 3 }, period: { CF$UID: 5 }, user: { CF$UID: 7 }, scene: { CF$UID: 10 },
      // Recovered encode order: $13 modules-changed, $18 router-inbound flag,
      // $19 router-inbound port, $20 DST rule, $21-$24 gateway addresses,
      // $25-$28 gateway counts. The site type comes from the site ID's fifth
      // character, not a stored slot.
      $1: "Test", $9: "FD4-2EST", $10: "0123456789abcdef", $11: "192.168.1.2",
      $2: "Line one", $3: "Line two", $4: "Line three", $5: "Line four",
      $12: 1, $13: "1", $14: "2026-07-24T10:30:00.000Z", $17: "0.0",
      $18: "1", $19: 16000, $20: "UK-Europe", $21: "42", $25: 3,
      $28: "10", $29: "controller.example.test",
      modc: 1, modcB: 0, $30: "7000",
    },
  };
  const data = convertLegacyArchive(archive);
  assert.equal(data.site.securityCode, "0123456789abcdef");
  assert.equal(data.site.timezone, "Europe/London");
  assert.deepEqual(data.site.addressLines, [
    "Line one", "Line two", "Line three", "Line four",
  ]);
  assert.equal(data.site.siteType, 2);
  assert.equal(data.site.modulesChanged, true);
  assert.equal(data.site.routerInbound, true);
  assert.equal(data.site.routerPort, 16000);
  assert.equal(data.site.remote, true);
  assert.equal(data.site.remoteServer, "controller.example.test");
  assert.deepEqual(controllerConnectionRequest({
    ...data.site,
    siteType: 0,
    autoDetect: false,
  }), {
    type: "connect",
    host: "192.168.1.2",
    port: 15273,
    securityCode: "0123456789abcdef",
  });
  assert.deepEqual(data.site.wirelessGateways, [{ address: "42", count: 3 }]);
  assert.deepEqual(data.site.moduleOrderA, [7000]);
  assert.deepEqual(data.site.moduleOrderB, []);
  assert.equal(data.site.updatedAt, "2026-07-24T10:30:00.000Z");
  const lamp = data.channels[0];
  assert.equal(lamp.minimum, 5);
  assert.equal(lamp.maximum, 90);
  assert.equal(lamp.maximumPermissible, 95);
  assert.equal(lamp.defaultLevel, 60);
  assert.equal(lamp.accessoryType, 1);
  assert.equal(lamp.dimmable, true);
  assert.equal(lamp.hardwareChanged, true);
  assert.equal(lamp.displayRank, 4);
  assert.equal(lamp.controllerChannel, 2);
  assert.equal(data.periods[0].start, "01:00");
  assert.equal(data.periods[0].startMode, 1);
  const owner = data.users[0];
  assert.equal(owner.key, "0123456789abcdef");
  assert.equal(owner.securityCode, "0123456789abcdef");
  assert.equal(owner.profileVersion, 3);
  assert.equal(owner.accessCount, 2);
  assert.deepEqual(owner.roomAccess, ["access-entry-a", "access-entry-b"]);
  const evening = data.scenes[0];
  assert.equal(evening.shortName, "Eve");
  assert.equal(evening.flags, 0xa0);
  assert.equal(evening.locked, true);
  assert.equal(evening.sceneType, 4);
  assert.equal(evening.displayRank, 7);
  assert.deepEqual(evening.channelSettings[1], {
    brightness: 72,
    fadeTime: 3,
    relativePercent: true,
    use100PercentTime: true,
    delay: 2,
    flags: 0x90,
  });
});

test("does not interpret real archive router flags and gateway counts as a target", () => {
  const objects = [
    "$null",
    { $classname: "JCLFDHardware" },
    { $class: { CF$UID: 1 }, ky: 1, ty: 0, nm: "Area", ix: 0, ri: 0 },
  ];
  const data = convertLegacyArchive({
    $archiver: "NSKeyedArchiver",
    $objects: objects,
    $top: {
      room: { CF$UID: 2 },
      $1: "Remote site",
      $9: "FD4-REMOTE",
      $10: "0123456789abcdef",
      $11: "192.168.1.2",
      $12: 1,
      $13: 0,
      $18: "1",
      $19: "1",
      $28: "10",
      $29: "controller.example.test",
    },
  });
  assert.equal(data.site.routerInbound, true);
  assert.equal(data.site.routerPort, 15273);
  assert.equal(data.site.remoteServer, "controller.example.test");
  assert.equal(data.site.remote, false);
  assert.deepEqual(controllerConnectionRequest(data.site), {
    type: "discover",
    host: "192.168.1.2",
    port: 15273,
    securityCode: "0123456789abcdef",
  });
});

test("addresses channels by stored module order, not sorted module ID", () => {
  // Modules are stored in controller-address order and must not be re-sorted by
  // ID. Here module 7010 is stored before 7000; a channel on the first-stored
  // module (7010) must address as position 0, the second (7000) as position 1.
  const objects = [
    "$null",
    { $classname: "JCLFDHardware" },
    { $class: { CF$UID: 1 }, ky: 1, ty: 0, nm: "Area", ix: 0, ri: 0 },
    { $class: { CF$UID: 1 }, ky: 10, pr: 1, ty: 2, nm: "First", hw: 12, ix: 1, md: 7010 },
    { $class: { CF$UID: 1 }, ky: 20, pr: 1, ty: 2, nm: "Second", hw: 12, ix: 1, md: 7000 },
  ];
  const archive = {
    $archiver: "NSKeyedArchiver",
    $objects: objects,
    $top: {
      room: { CF$UID: 2 }, first: { CF$UID: 3 }, second: { CF$UID: 4 },
      $1: "Order", $9: "FD4-ORDER", $12: 1, $17: "0.0", $20: "UK-Europe",
      modc: 2, $30: "7010", $31: "7000",
    },
  };
  const data = convertLegacyArchive(archive);
  assert.deepEqual(data.site.moduleOrderA, [7010, 7000]);
  const first = data.channels.find((c) => c.name === "First");
  const second = data.channels.find((c) => c.name === "Second");
  // First-stored module → position 0 → address 0*8+1 = 1.
  assert.equal(first.controllerChannel, 1);
  // Second-stored module → position 1 → address 1*8+1 = 9 (would be 1 if sorted).
  assert.equal(second.controllerChannel, 9);
});

test("ranks switch hardware by `ra` and scenes by `dr`", () => {
  // JCLFDHardware (channels, switches) stores rank in `ra`; JCLFDScene stores
  // its rank/fade in `dr`. Reading the wrong key silently defaults the rank.
  const objects = [
    "$null",
    { $classname: "JCLFDHardware" },
    { $class: { CF$UID: 1 }, ky: 1, ty: 0, nm: "Area", ix: 0, ri: 0 },
    { $class: { CF$UID: 1 }, ky: 30, pr: 1, ty: 1, nm: "Plate", hw: 15, ix: 5, ra: 6 },
    { $classname: "JCLFDScene" },
    { $class: { CF$UID: 4 }, ky: 40, pr: 1, nm: "Evening", dr: 9 },
  ];
  const archive = {
    $archiver: "NSKeyedArchiver",
    $objects: objects,
    $top: {
      room: { CF$UID: 2 }, plate: { CF$UID: 3 }, scene: { CF$UID: 5 },
      $1: "Ranks", $9: "FD4-RANK", $12: 1, $17: "0.0", $20: "UK-Europe",
    },
  };
  const data = convertLegacyArchive(archive);
  assert.equal(data.switches[0].displayRank, 6);
  assert.equal(data.scenes[0].displayRank, 9);
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
    { id: 2, siteId: "TEST0002", name: "Kitchen", description: "old", lastUpdated: "old" },
    { id: 3, siteId: "TEST0002", name: "Kitchen", description: "duplicate", lastUpdated: "old" },
    { id: 4, siteId: "TEST0002", name: "Alternative", description: "keep", lastUpdated: "old" },
  ];
  const result = upsertImportedConfiguration(configurations, {
    id: 0, siteId: "TEST0002", name: "Kitchen", description: "fresh", lastUpdated: "new",
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
    name: "Kitchen", id: "TEST0002", ip: "192.168.1.2", port: 15273,
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
  // The live endpoint is NOT part of the comparison: discovery rewrites ip/port
  // after every connect, so including them made a working site permanently
  // unequal to its own backup and prompted on every re-import.
  assert.equal(siteImportDetailsEqual({ ...saved, ip: "192.168.1.3" }, imported), true);
  assert.equal(siteImportDetailsEqual({ ...saved, port: 15999 }, imported), true);
  // A real archive field still counts as a difference.
  assert.equal(siteImportDetailsEqual({ ...saved, name: "Renamed" }, imported), false);
});

test("import differences name the fields an installer can act on", () => {
  const base = {
    name: "Site", id: "FD4-0001", ip: "10.0.0.1", port: 15273,
    description: "", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false,
  };
  // No differences at all.
  assert.deepEqual(siteImportDifferences(base, { ...base }), []);
  // The endpoint is excluded, so it never appears as a difference.
  assert.deepEqual(
    siteImportDifferences(base, { ...base, ip: "10.0.0.9", port: 1234 }),
    [],
  );
  // Real fields are reported by their visible label, not their key.
  assert.deepEqual(
    siteImportDifferences(base, { ...base, name: "Other" }),
    ["Site name"],
  );
  assert.deepEqual(
    siteImportDifferences(base, { ...base, remoteServer: "host.example" }),
    ["Remote server"],
  );
  // The gateway corruption case that motivated this: a pre-fix workspace held
  // the DST rule string in a gateway address slot.
  assert.deepEqual(
    siteImportDifferences(
      { ...base, wirelessGateways: [{ address: "No Daylight Saving", count: 0 }] },
      { ...base, wirelessGateways: [] },
    ),
    ["Wireless gateways"],
  );
  // Several at once, in field order.
  assert.deepEqual(
    siteImportDifferences(base, { ...base, name: "Other", dst: "USA" }),
    ["Site name", "Daylight saving rule"],
  );
});

test("a differing security code is reported without exposing either value", () => {
  const base = {
    name: "Site", id: "FD4-0001", ip: "10.0.0.1", port: 15273,
    description: "", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, securityCode: "SAVEDKEY01234567",
  };
  const differences = siteImportDifferences(base, {
    ...base,
    securityCode: "IMPORTKEY0123456",
  });
  assert.deepEqual(differences, ["Controller security code"]);
  // The labels go straight into a dialog, so no key material may ride along.
  for (const label of differences) {
    assert.equal(label.includes("SAVEDKEY01234567"), false);
    assert.equal(label.includes("IMPORTKEY0123456"), false);
  }
});

test("re-importing the same archive twice never prompts", () => {
  // The reported symptom: importing one file repeatedly asked every time. After
  // the first import the stored site carries the discovered endpoint, which is
  // the only thing that legitimately drifts.
  const archive = {
    name: "Site", id: "TEST0002", ip: "203.0.113.9", port: 15273,
    description: "", address: "", timezone: "UTC",
    dst: "No daylight saving", remote: false, autoDetect: true,
  };
  // First import stores the archive verbatim, then discovery replaces the
  // endpoint with the live LAN address.
  const stored = { ...archive, ip: "192.168.77.41" };
  assert.equal(siteImportDetailsEqual(stored, archive), true);
  assert.deepEqual(siteImportDifferences(stored, archive), []);
});

test("restores an imported controller key while retaining local bridge settings", () => {
  const current = {
    name: "Saved site", id: "FD4-TEST", ip: "192.168.1.10", port: 16000,
    description: "Saved", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, autoDetect: false, securityCode: "",
    bridgeUrl: "ws://127.0.0.1:9000", bridgeToken: "paired-locally",
  };
  const imported = {
    ...current, name: "Imported site", description: "Imported",
    ip: "192.168.1.20", port: 15273, autoDetect: true,
    securityCode: "0123456789abcdef", bridgeUrl: "/bridge",
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
  assert.equal(usedImport.ip, "192.168.1.10");
  assert.equal(usedImport.port, 16000);
  assert.equal(usedImport.autoDetect, false);
  assert.equal(usedImport.bridgeUrl, "ws://127.0.0.1:9000");
});

function integrityFixture() {
  return {
    rooms: [
      { id: 1, name: "Floor", floor: "FlexiDim", icon: "" },
      { id: 2, name: "Room", floor: "Floor", icon: "", parentId: 1 },
      { id: 3, name: "Empty", floor: "FlexiDim", icon: "" },
    ],
    modules: [
      { id: 7000, name: "Module 7000", bus: "A", enabled: true, pending: false },
      { id: 7001, name: "Spare", bus: "A", enabled: true, pending: false },
    ],
    channels: [{
      id: 10, name: "Lamp", roomId: 2, module: "Module 7000 / Ch1",
      moduleId: 7000, kind: "Dimmer", level: 50,
    }],
    switches: [{
      id: 20, name: "Plate", roomId: 2, kind: "4 scene", buttons: 7,
      basic: {
        channelIds: [10], assignOn: true, assignOff: true,
        assignDimming: true, assignChannelDimming: false,
        onTime: 0, offTime: 0, offPriority: 0,
        channelSettings: {
          10: {
            assignOn: true, assignOff: true, assignDimming: true,
            assignChannelDimming: false, onPriority: false,
            offPriority: false, onFade: 0, offFade: 0,
          },
        },
      },
    }],
    sceneGroups: [],
    scenes: [
      {
        id: 30, name: "First", group: "Room", levels: { 10: 75 },
        channelSettings: {
          10: {
            brightness: 75, fadeTime: 2, relativePercent: false,
            use100PercentTime: false, delay: 0, flags: 0,
          },
        },
        fade: 2, enabled: true, days: [], time: "",
        nextSceneId: 31, period1: 40,
      },
      {
        id: 31, name: "Second", group: "Room", levels: {},
        fade: 2, enabled: true, days: [], time: "",
        previousSceneId: 30, extenderSceneId: 30, period2: 40,
      },
    ],
    deletedScenes: [],
    periods: [{
      id: 40, name: "Evening", start: "18:00", end: "23:00",
      days: [], enabled: true,
    }],
    users: [{
      id: 50, name: "Owner", remote: false, changes: true, key: "test",
      roomIds: [2, 3], switchIds: [20],
    }],
    assignments: [{
      switchId: 20, button: 1, sceneId: 30, secondSceneId: 31,
      channelId: 10,
    }],
    deletedItems: [],
  };
}

test("validates hierarchy and all cross-object configuration references", () => {
  const valid = integrityFixture();
  assert.deepEqual(validateConfigContent(valid), []);
  valid.scenes[0].period1 = 0;
  valid.scenes[1].period2 = 0;
  assert.deepEqual(
    validateConfigContent(valid),
    [],
    "legacy period value 0 means no condition, not a missing period",
  );

  const invalid = structuredClone(valid);
  invalid.rooms[0].parentId = 2;
  invalid.channels[0].roomId = 999;
  invalid.channels[0].moduleId = 999;
  invalid.switches[0].roomId = 999;
  invalid.scenes[0].levels[999] = 1;
  invalid.scenes[0].nextSceneId = 999;
  invalid.scenes[0].period1 = 999;
  invalid.assignments[0].switchId = 999;
  invalid.users[0].roomIds.push(999);
  invalid.users[0].switchIds.push(999);
  const issues = validateConfigContent(invalid);
  assert.ok(issues.some((issue) => issue.includes("cyclic parent hierarchy")));
  assert.ok(issues.some((issue) => issue.includes("missing room 999")));
  assert.ok(issues.some((issue) => issue.includes("missing module 999")));
  assert.ok(issues.some((issue) => issue.includes("missing channel 999")));
  assert.ok(issues.some((issue) => issue.includes("missing next scene 999")));
  assert.ok(issues.some((issue) => issue.includes("missing period 1 999")));
  assert.ok(issues.some((issue) => issue.includes("missing switch 999")));
});

test("deletion cascades channel, switch, scene, period, room and user references", () => {
  let content = deleteConfigEntity(integrityFixture(), "channel", 10);
  assert.deepEqual(content.scenes[0].levels, {});
  assert.deepEqual(content.switches[0].basic.channelIds, []);
  assert.deepEqual(content.switches[0].basic.channelSettings, {});
  assert.deepEqual(content.assignments, []);

  content = deleteConfigEntity(content, "switch", 20);
  assert.deepEqual(content.users[0].switchIds, []);
  content = deleteConfigEntity(content, "scene", 30);
  assert.equal(content.scenes[0].previousSceneId, undefined);
  assert.equal(content.scenes[0].extenderSceneId, undefined);
  content = deleteConfigEntity(content, "period", 40);
  assert.equal(content.scenes[0].period2, undefined);
  content = deleteConfigEntity(content, "room", 2);
  assert.deepEqual(content.users[0].roomIds, [3]);
  content = deleteConfigEntity(content, "user", 50);
  assert.deepEqual(content.users, []);
  assert.deepEqual(validateConfigContent(content), []);
});

test("refuses to delete rooms or modules that still own equipment", () => {
  const content = integrityFixture();
  assert.throws(
    () => deleteConfigEntity(content, "room", 2),
    /Move the child rooms, channels and switches/,
  );
  assert.throws(
    () => deleteConfigEntity(content, "module", 7000),
    /Move this module's channels/,
  );
  const withoutSpare = deleteConfigEntity(content, "module", 7001);
  assert.deepEqual(withoutSpare.modules.map((module) => module.id), [7000]);
});

function ownershipContent(label) {
  return {
    rooms: [{ id: 1, name: `${label} room`, floor: "FlexiDim", icon: "" }],
    channels: [],
    switches: [],
    sceneGroups: [],
    scenes: [],
    deletedScenes: [],
    periods: [],
    users: [],
    assignments: [],
    modules: [],
    deletedItems: [],
  };
}

test("canonical workspace nests configuration content beneath its owning site", () => {
  const firstSite = {
    name: "First", id: "SITE-1", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const secondSite = { ...firstSite, name: "Second", id: "SITE-2" };
  const activeContent = ownershipContent("first");
  const secondContent = ownershipContent("second");
  const legacyProjection = {
    site: firstSite,
    sites: [firstSite, secondSite],
    configurations: [
      {
        id: 1, siteId: firstSite.id, name: "First config",
        description: "", lastUpdated: "",
      },
      {
        id: 2, siteId: secondSite.id, name: "Second config",
        description: "", lastUpdated: "", content: secondContent,
      },
    ],
    activeConfigId: 1,
    ...activeContent,
  };

  const workspace = canonicalizeAppData(legacyProjection);
  assert.equal(isFlexiDimWorkspace(workspace), true);
  assert.equal(workspace.sites[0].configurations[0].content.rooms[0].name, "first room");
  assert.equal(workspace.sites[1].configurations[0].content.rooms[0].name, "second room");
  assert.equal("siteId" in workspace.sites[0].configurations[0], false);

  const secondView = materializeAppData({
    ...workspace, activeSiteId: "SITE-2", activeConfigId: 2,
  });
  assert.equal(secondView.site.id, "SITE-2");
  assert.equal(secondView.rooms[0].name, "second room");
});

test("editing one materialized configuration cannot leak into another site", () => {
  const site = {
    name: "First", id: "SITE-1", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const workspace = canonicalizeAppData({
    site,
    sites: [site, { ...site, name: "Second", id: "SITE-2" }],
    configurations: [
      {
        id: 1, siteId: "SITE-1", name: "First", description: "",
        lastUpdated: "",
      },
      {
        id: 2, siteId: "SITE-2", name: "Second", description: "",
        lastUpdated: "", content: ownershipContent("second"),
      },
    ],
    activeConfigId: 1,
    ...ownershipContent("first"),
  });
  const secondView = materializeAppData({
    ...workspace, activeSiteId: "SITE-2", activeConfigId: 2,
  });
  secondView.rooms = [{ ...secondView.rooms[0], name: "edited second room" }];
  const editedWorkspace = canonicalizeAppData(secondView);

  assert.equal(
    editedWorkspace.sites[0].configurations[0].content.rooms[0].name,
    "first room",
  );
  assert.equal(
    editedWorkspace.sites[1].configurations[0].content.rooms[0].name,
    "edited second room",
  );
});

test("legacy projections without inactive content migrate to an empty owner", () => {
  const site = {
    name: "First", id: "SITE-1", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const workspace = canonicalizeAppData({
    site,
    sites: [site, { ...site, name: "Second", id: "SITE-2" }],
    configurations: [
      { id: 1, siteId: "SITE-1", name: "First", description: "", lastUpdated: "" },
      { id: 2, siteId: "SITE-2", name: "Second", description: "", lastUpdated: "" },
    ],
    activeConfigId: 1,
    ...ownershipContent("first"),
  });
  assert.deepEqual(
    workspace.sites[1].configurations[0].content.rooms,
    [],
  );
});

test("canonical migration gives every site at least one owned configuration", () => {
  const site = {
    name: "First", id: "SITE-1", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const workspace = canonicalizeAppData({
    site,
    sites: [site, { ...site, name: "Second", id: "SITE-2" }],
    configurations: [
      { id: 1, siteId: "SITE-1", name: "First", description: "", lastUpdated: "" },
    ],
    activeConfigId: 1,
    ...ownershipContent("first"),
  });
  assert.equal(workspace.sites[1].configurations.length, 1);
  assert.deepEqual(workspace.sites[1].configurations[0].content.rooms, []);
  assert.notEqual(workspace.sites[1].configurations[0].id, 1);
});

test("server migration preserves the browser connection that previously worked", () => {
  const server = canonicalizeAppData({
    site: {
      name: "Home", id: "SITE-1", ip: "192.168.1.10", port: 15273,
      description: "Server metadata", address: "", timezone: "Europe/London",
      dst: "UK / Europe", remote: false, autoDetect: true,
      securityCode: "0123456789abcdef",
    },
    configurations: [{
      id: 1, siteId: "SITE-1", name: "Server configuration",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...ownershipContent("server"),
  });
  const browser = canonicalizeAppData({
    site: {
      ...materializeAppData(server).site,
      ip: "192.168.1.77",
      port: 15274,
      autoDetect: false,
      securityCode: "fedcba9876543210",
      description: "Stale browser metadata",
    },
    configurations: [{
      id: 1, siteId: "SITE-1", name: "Browser configuration",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...ownershipContent("browser"),
  });
  const merged = mergeLegacyBrowserConnectionState(server, browser);
  assert.equal(merged.sites[0].ip, "192.168.1.77");
  assert.equal(merged.sites[0].port, 15274);
  assert.equal(merged.sites[0].autoDetect, false);
  assert.equal(merged.sites[0].securityCode, "fedcba9876543210");
  assert.equal(merged.sites[0].description, "Server metadata");
  assert.equal(
    merged.sites[0].configurations[0].content.rooms[0].name,
    "server room",
  );
});

test("a retained archive restores a controller code omitted by an older workspace", () => {
  const site = {
    name: "Imported", id: "SITE0001", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
    moduleOrderA: [7000],
    moduleOrderB: [],
    legacy: {
      hardwareOrder: [101, 102],
      // extraBase = 30 + one bus-A module + two hardware records = 33;
      // the controller code is the third post-hardware slot, $35.
      top: { $35: "CTRL0007" },
    },
  };
  const workspace = canonicalizeAppData({
    site,
    configurations: [{
      id: 1, siteId: site.id, name: "Imported",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...ownershipContent("imported"),
  });
  const migrated = migrateWorkspaceControllerCode(workspace);
  assert.equal(
    migrated.sites[0].configurations[0].controllerCode,
    "CTRL0007",
  );
  assert.notEqual(
    migrated.sites[0].configurations[0].controllerCode,
    migrated.sites[0].id,
    "migration must read the retained archive field, not guess from site ID",
  );
  assert.equal(
    migrateWorkspaceControllerCode(migrated),
    migrated,
    "the migration should be stable after the field is restored",
  );
});

test("controller-code migration refuses a plausible value from the wrong slot", () => {
  const site = {
    name: "Imported", id: "SITE0001", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
    moduleOrderA: [],
    moduleOrderB: [],
    legacy: {
      hardwareOrder: [101],
      top: { $32: "WRONG001" }, // expected slot is $33
    },
  };
  const workspace = canonicalizeAppData({
    site,
    configurations: [{
      id: 1, siteId: site.id, name: "Imported",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...ownershipContent("imported"),
  });
  assert.equal(migrateWorkspaceControllerCode(workspace), workspace);
});

test("old imported users recover resolved access from retained legacy paths", () => {
  const site = {
    name: "Imported", id: "SITE0001", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const content = ownershipContent("imported");
  content.rooms = [
    { ...content.rooms[0], id: 10, legacyKey: 110 },
    { ...content.rooms[0], id: 20, legacyKey: 220 },
  ];
  content.switches = [
    { id: 30, name: "First", roomId: 10, type: 1, buttons: 1, number: 1, legacyKey: 330 },
    { id: 40, name: "Second", roomId: 20, type: 1, buttons: 1, number: 2, legacyKey: 440 },
  ];
  content.users = [{
    id: 1,
    name: "Imported user",
    remote: false,
    changes: true,
    key: "0123456789abcdef",
    securityCode: "0123456789abcdef",
    profileStatus: "imported",
    roomAccess: ["110|330", "220|440"],
    roomIds: [],
    switchIds: [],
  }];
  const workspace = canonicalizeAppData({
    site,
    configurations: [{
      id: 1, siteId: site.id, name: "Imported",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...content,
  });
  const migrated = migrateWorkspaceImportedUserAccess(workspace);
  assert.deepEqual(
    migrated.sites[0].configurations[0].content.users[0].roomIds,
    [10, 20],
  );
  assert.deepEqual(
    migrated.sites[0].configurations[0].content.users[0].switchIds,
    [30, 40],
  );
});

test("user-access migration never overwrites a deliberately edited profile", () => {
  const site = {
    name: "Imported", id: "SITE0001", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
  };
  const content = ownershipContent("edited");
  content.rooms = [{ ...content.rooms[0], id: 10, legacyKey: 110 }];
  content.switches = [];
  content.users = [{
    id: 1,
    name: "Edited user",
    remote: false,
    changes: true,
    key: "0123456789abcdef",
    profileStatus: "pending",
    roomAccess: ["110"],
    roomIds: [],
    switchIds: [],
  }];
  const workspace = canonicalizeAppData({
    site,
    configurations: [{
      id: 1, siteId: site.id, name: "Imported",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...content,
  });
  assert.equal(migrateWorkspaceImportedUserAccess(workspace), workspace);
});

test("old imported channels recover their retained dictionary profile order", () => {
  const site = {
    name: "Imported", id: "SITE0001", ip: "", port: 15273, description: "",
    address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false,
    legacy: { hardwareOrder: [101, 202, 303] },
  };
  const content = ownershipContent("imported");
  content.channels = [
    { ...content.channels[0], id: 1, legacyKey: 101, profileOrder: undefined },
    { ...content.channels[0], id: 2, legacyKey: 202, profileOrder: undefined },
    { ...content.channels[0], id: 3, legacyKey: 303, profileOrder: undefined },
  ];
  const workspace = canonicalizeAppData({
    site,
    configurations: [{
      id: 1, siteId: site.id, name: "Imported",
      description: "", lastUpdated: "",
    }],
    activeConfigId: 1,
    ...content,
  });
  const migrated = migrateWorkspaceChannelProfileOrder(workspace);
  const ranks = migrated.sites[0].configurations[0].content.channels.map(
    (channel) => channel.profileOrder,
  );
  assert.ok(ranks.every(Number.isInteger));
  assert.equal(new Set(ranks).size, 3);

  const authoritative = {
    ...migrated,
    sites: migrated.sites.map((ownedSite) => ({
      ...ownedSite,
      configurations: ownedSite.configurations.map((configuration) => ({
        ...configuration,
        content: {
          ...configuration.content,
          channels: configuration.content.channels.map((channel, index) => ({
            ...channel,
            profileOrder: index + 50,
          })),
        },
      })),
    })),
  };
  assert.equal(
    migrateWorkspaceChannelProfileOrder(authoritative),
    authoritative,
    "existing imported ranks must remain authoritative",
  );
});

test("user profile edits preserve explicit access order and version their data", () => {
  const user = {
    id: 7,
    name: "Operator",
    remote: true,
    changes: false,
    key: "0123456789abcdef",
    securityCode: "0123456789abcdef",
    roomIds: [3, 1],
    switchIds: [20, 10],
    profileVersion: 4,
    profileStatus: "current",
  };
  const updated = updateUserProfile(user, {
    roomIds: [1, 3],
    switchIds: [10, 20],
  });
  assert.equal(updated.profileVersion, 5);
  assert.equal(updated.profileStatus, "pending");
  assert.deepEqual(JSON.parse(updated.profileData).user.roomIds, [1, 3]);
  assert.deepEqual(JSON.parse(updated.profileData).user.switchIds, [10, 20]);
  assert.equal(updated.profileData, buildUserProfileData(updated));

  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(
    orderUserAccess(items, [3, 1]).map((item) => item.id),
    [3, 1, 2],
  );
});

test("resolves type-0 targets exactly as the committed local connection path", () => {
  const site = {
    name: "Test", id: "SITE", ip: "192.168.1.50", port: 15273,
    description: "", address: "", timezone: "Europe/London",
    dst: "UK / Europe", remote: false, autoDetect: true,
    securityCode: "0123456789abcdef",
  };
  assert.deepEqual(controllerConnectionRequest(site), {
    type: "discover",
    host: "192.168.1.50",
    port: 15273,
    securityCode: "0123456789abcdef",
  });
  assert.deepEqual(controllerConnectionRequest({ ...site, autoDetect: false }), {
    type: "connect",
    host: "192.168.1.50",
    port: 15273,
    securityCode: "0123456789abcdef",
  });
  assert.deepEqual(controllerConnectionRequest({
    ...site,
    remote: true,
    remoteServer: "10",
    routerPort: 1,
    autoDetect: false,
  }), {
    type: "connect",
    host: "192.168.1.50",
    port: 15273,
    securityCode: "0123456789abcdef",
  });
  assert.throws(
    () => controllerConnectionRequest({ ...site, siteType: 1 }),
    /encrypted controller sessions are not enabled/,
  );
});
