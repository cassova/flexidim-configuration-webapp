import assert from "node:assert/strict";
import test from "node:test";
import { crc16X25, packet } from "../bridge/protocol.mjs";
import { FLEXIDIM_DISCOVERY_MESSAGE, FLEXIDIM_DISCOVERY_PORT, FLEXIDIM_DISCOVERY_REPLY_PORT, isPrivateIpv4, lanCandidates } from "../bridge/discovery.mjs";
import { controllerChannelAddress } from "../app/flexidim-addressing.mjs";
import { defaultOnOffCommands, rawControllerButton } from "../app/live-switch.mjs";
import { authenticationRecord } from "../bridge/session.mjs";
import { parseControllerReplies } from "../bridge/controller-replies.mjs";
import { capabilityFor, SAFE_LOCAL_PROFILE } from "../bridge/controller-capabilities.mjs";

test("separates quiet f2 level synchronization from visible controller replies", () => {
  const mixed = Buffer.from([
    0xf2, 0x10, 0x64, 0x66,
    0xf5, 0x04, 0x10, 0x64, 0x6d,
    0xf2, 0x08, 0x32, 0x2c,
  ]);
  const parsed = parseControllerReplies(mixed);
  assert.deepEqual(parsed.statuses, [
    { channel: 17, level: 100 },
    { channel: 9, level: 50 },
  ]);
  assert.deepEqual([...parsed.visible[0]], [0xf5, 0x04, 0x10, 0x64, 0x6d]);
  assert.equal(parsed.rest.length, 0);
});

test("buffers an incomplete f2 status record across TCP chunks", () => {
  const parsed = parseControllerReplies(Buffer.from([0xf2, 0x10, 0x64]));
  assert.deepEqual(parsed.statuses, []);
  assert.deepEqual([...parsed.rest], [0xf2, 0x10, 0x64]);
});

test("rejects controller records whose additive integrity byte is wrong", () => {
  const parsed = parseControllerReplies(Buffer.from([0xf2, 0x10, 0x64, 0x00]));
  assert.deepEqual(parsed.statuses, []);
  assert.equal(parsed.invalid.length, 1);
  assert.deepEqual([...parsed.invalid[0]], [0xf2, 0x10, 0x64, 0x00]);
});

test("builds the site-type-0 authentication record used before iOS commands", () => {
  const value = authenticationRecord("1234567890abcdef", 42);
  assert.equal(value.length, 23);
  assert.equal(value.subarray(0, 22).toString("ascii"), "1234567890abcdef000042");
  assert.equal(value[22], 0xff);
  assert.throws(() => authenticationRecord("too-short", 42), /exactly 16/);
});

test("uses the recovered CRC-16/X25 algorithm", () => {
  assert.equal(crc16X25(Buffer.from("123456789")), 0x906e);
});

test("builds a dim command with escaped reserved bytes", () => {
  const value = packet(0x04, [1, 100, 2]);
  assert.deepEqual([...value.subarray(0, 6)], [0xff, 0xf3, 0x04, 1, 100, 2]);
});

test("uses the iOS module-position times eight channel addressing", () => {
  assert.equal(controllerChannelAddress(0, 1), 1);
  assert.equal(controllerChannelAddress(1, 1), 9);
  assert.equal(controllerChannelAddress(2, 8), 24);
  assert.equal(controllerChannelAddress(-1, 7), 7);
});

test("builds the six-byte plaintext switch body used by the iOS app", () => {
  const value = packet(0x00, [63, 4, 0]);
  assert.deepEqual([...value.subarray(0, 6)], [0xff, 0xf3, 0x00, 63, 4, 0]);
});

test("maps shifted built-in plate buttons to iOS wire button numbers", () => {
  assert.equal(rawControllerButton(11, 9), 9);
  assert.equal(rawControllerButton(11, 10), 10);
  assert.equal(rawControllerButton(11, 11), 12);
  assert.equal(rawControllerButton(7, 7), 8);
});

test("expands live Default on/off into basic-assignment dim commands", () => {
  const wallSwitch = {
    basic: {
      channelIds: [22, 20, 16, 2],
      assignOn: true,
      assignOff: true,
      onTime: 0.5,
      offTime: 0.5,
      channelSettings: {},
    },
  };
  const off = [22, 20, 16, 2].map((id) => ({ id, level: 0 }));
  assert.deepEqual(defaultOnOffCommands(wallSwitch, off), [
    { id: 22, level: 100, transition: 1 },
    { id: 20, level: 100, transition: 1 },
    { id: 16, level: 100, transition: 1 },
    { id: 2, level: 100, transition: 1 },
  ]);
  const on = off.map((channel) => ({ ...channel, level: 100 }));
  assert.deepEqual(
    defaultOnOffCommands(wallSwitch, on).map(({ level }) => level),
    [0, 0, 0, 0],
  );
});

test("builds a bounded controller scan from private LAN interfaces", () => {
  const interfaces = { en0: [{ address: "192.168.12.42", netmask: "255.255.255.0", family: "IPv4", internal: false }] };
  const candidates = lanCandidates("203.0.113.10", interfaces);
  assert.equal(candidates.length, 253);
  assert.ok(candidates.includes("192.168.12.1"));
  assert.ok(candidates.includes("192.168.12.254"));
  assert.ok(!candidates.includes("192.168.12.42"));
  assert.ok(!candidates.includes("203.0.113.10"));
  assert.equal(isPrivateIpv4("172.20.0.4"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
});

test("uses the discovery protocol recovered from the iOS binary", () => {
  assert.equal(FLEXIDIM_DISCOVERY_MESSAGE, "FLEX");
  assert.equal(FLEXIDIM_DISCOVERY_PORT, 15270);
  assert.equal(FLEXIDIM_DISCOVERY_REPLY_PORT, 15001);
});

test("keeps unverified commissioning writes denied by default", () => {
  assert.equal(capabilityFor("dim"), true);
  assert.equal(capabilityFor("switch"), true);
  assert.equal(capabilityFor("sync"), false);
  assert.equal(capabilityFor("moduleProfiles"), false);
  assert.equal(SAFE_LOCAL_PROFILE.fullTransfer, false);
});
