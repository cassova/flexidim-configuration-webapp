import assert from "node:assert/strict";
import test from "node:test";
import { parseDstRuleFile, dstTransition, isDstActive } from "../app/dst-rules.ts";
import { solarTimes } from "../app/solar.ts";
import { convertLegacyArchive } from "../app/fd4cfg.ts";

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
      $12: 1, $17: "Europe/London", $18: 15273, $19: "UK-Europe", modc: 1, $30: "7000",
    },
  };
  const data = convertLegacyArchive(archive);
  assert.equal(data.channels[0].minimum, 5);
  assert.equal(data.channels[0].maximum, 90);
  assert.equal(data.channels[0].maximumPermissible, 95);
  assert.equal(data.channels[0].controllerChannel, 2);
  assert.equal(data.periods[0].start, "01:00");
  assert.equal(data.periods[0].startMode, 1);
  assert.equal(data.users[0].key, "0123456789abcdef");
  assert.deepEqual(data.users[0].roomIds, [1]);
});
