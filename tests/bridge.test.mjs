import assert from "node:assert/strict";
import test from "node:test";
import { crc16X25, packet } from "../bridge/protocol.mjs";

test("uses the recovered CRC-16/X25 algorithm", () => {
  assert.equal(crc16X25(Buffer.from("123456789")), 0x906e);
});

test("builds a dim command with escaped reserved bytes", () => {
  const value = packet(0x04, [1, 100, 2]);
  assert.deepEqual([...value.subarray(0, 6)], [0xff, 0xf3, 0x04, 1, 100, 2]);
});
