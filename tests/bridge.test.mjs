import assert from "node:assert/strict";
import test from "node:test";
import { crc16X25, packet } from "../bridge/protocol.mjs";
import { FLEXIDIM_DISCOVERY_MESSAGE, FLEXIDIM_DISCOVERY_PORT, FLEXIDIM_DISCOVERY_REPLY_PORT, isPrivateIpv4, lanCandidates } from "../bridge/discovery.mjs";

test("uses the recovered CRC-16/X25 algorithm", () => {
  assert.equal(crc16X25(Buffer.from("123456789")), 0x906e);
});

test("builds a dim command with escaped reserved bytes", () => {
  const value = packet(0x04, [1, 100, 2]);
  assert.deepEqual([...value.subarray(0, 6)], [0xff, 0xf3, 0x04, 1, 100, 2]);
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
