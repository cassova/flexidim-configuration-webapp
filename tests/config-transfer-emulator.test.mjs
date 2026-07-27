import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCK_TIMEOUT_TICKS,
  ConfigurationTransferSession,
  FINAL_STATUS_COUNT,
  SETTLE_TICKS,
} from "../bridge/config-transfer.mjs";
import {
  TransferPrefixEmulator,
  unescapeFrame,
} from "../tools/oracle/transfer-prefix-emulator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "tools", "oracle", "fixtures");
const image = fs.readFileSync(path.join(fixtures, "transfer-oracle-image.bin"));
const wire = JSON.parse(
  fs.readFileSync(path.join(fixtures, "transfer-oracle-wire.json"), "utf8"),
).map((hex) => Buffer.from(hex, "hex"));
const fromBcd = (value) => ((value >>> 4) & 0x0f) * 10 + (value & 0x0f);
const capturedTime = unescapeFrame(wire[0]);
const capturedDate = unescapeFrame(wire[1]);
const clock = {
  year: 2000 + fromBcd(capturedDate[2]),
  month: fromBcd(capturedDate[4]),
  day: fromBcd(capturedDate[5]),
  weekday: capturedDate[3],
  hour: fromBcd(capturedTime[5] & ~0x40),
  minute: fromBcd(capturedTime[4]),
  second: fromBcd(capturedTime[3]),
  dst: Boolean(capturedTime[5] & 0x40),
};
const userPayloads = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "transfer-oracle-user-payloads.json"),
    "utf8",
  ),
).map((value) => Buffer.from(value, "base64"));

function deliver(emulator, result) {
  let reply = null;
  for (const frame of result.frames) {
    const candidate = emulator.receive(frame.bytes);
    if (candidate) reply = candidate;
  }
  return reply;
}

function open(session, emulator) {
  deliver(emulator, session.start());
  const handshake = deliver(emulator, session.step({ type: "tick" }));
  assert.deepEqual(handshake, Buffer.from([0x06]));
  session.step({ type: "reply", bytes: handshake });
  let result;
  for (let index = 0; index < SETTLE_TICKS; index += 1)
    result = session.step({ type: "tick" });
  return result;
}

test("the emulator accepts the complete oracle transcript and ACKs every block", () => {
  const session = new ConfigurationTransferSession({ image, clock, userPayloads });
  const emulator = new TransferPrefixEmulator({ expectedFrames: wire });
  let result = open(session, emulator);
  while (session.state === "block-ack") {
    const ack = deliver(emulator, result);
    assert.deepEqual(ack, Buffer.from([0x06]));
    result = session.step({ type: "reply", bytes: ack });
    if (session.state === "block-gap")
      result = session.step({ type: "tick" });
  }
  assert.equal(session.state, "post-image");
  const postImage = deliver(emulator, session.step({ type: "tick" }));
  assert.equal(session.state, "post-image-status");
  const f9 = session.step({ type: "reply", bytes: postImage });
  const f9Ack = deliver(emulator, f9);
  const f8 = session.step({ type: "reply", bytes: f9Ack });
  deliver(emulator, f8);
  while (session.state === "user-transfer")
    deliver(emulator, session.step({ type: "tick" }));
  assert.equal(session.state, "final-status");
  for (let index = 0; index < FINAL_STATUS_COUNT; index += 1)
    session.step(emulator.status());
  session.step({ type: "tick" });
  assert.equal(session.state, "completed");
  assert.equal(emulator.complete, true);
  assert.equal(emulator.resetRequested, true);
});

test("one emulator NAK makes the sender retry the exact same block", () => {
  const session = new ConfigurationTransferSession({ image, clock });
  const emulator = new TransferPrefixEmulator({
    expectedFrames: wire,
    nakByBlock: new Map([[0, 1]]),
  });
  const first = open(session, emulator);
  const nak = deliver(emulator, first);
  assert.deepEqual(nak, Buffer.from([0x15]));
  const retry = session.step({ type: "reply", bytes: nak });
  const ack = deliver(emulator, retry);
  assert.deepEqual(ack, Buffer.from([0x06]));
  assert.deepEqual(
    retry.frames.map(({ bytes }) => bytes),
    first.frames.map(({ bytes }) => bytes),
  );
});

test("one emulator timeout makes the sender retry after exactly 101 ticks", () => {
  const session = new ConfigurationTransferSession({ image, clock });
  const emulator = new TransferPrefixEmulator({
    expectedFrames: wire,
    timeoutByBlock: new Map([[0, 1]]),
  });
  const first = open(session, emulator);
  assert.equal(deliver(emulator, first), null);
  let retry;
  for (let index = 0; index < BLOCK_TIMEOUT_TICKS; index += 1)
    retry = session.step({ type: "tick" });
  const ack = deliver(emulator, retry);
  assert.deepEqual(ack, Buffer.from([0x06]));
  assert.deepEqual(
    retry.frames.map(({ bytes }) => bytes),
    first.frames.map(({ bytes }) => bytes),
  );
});

test("out-of-order, mutated and corrupt frames are rejected permanently", () => {
  const outOfOrder = new TransferPrefixEmulator({ expectedFrames: wire });
  assert.throws(() => outOfOrder.receive(wire[1]), /unexpected transfer frame/);
  assert.throws(() => outOfOrder.receive(wire[0]), /rejected an earlier frame/);

  const mutated = new TransferPrefixEmulator({ expectedFrames: wire });
  const changed = Buffer.from(wire[0]);
  changed[3] ^= 1;
  assert.throws(() => mutated.receive(changed), /unexpected transfer frame/);
});
