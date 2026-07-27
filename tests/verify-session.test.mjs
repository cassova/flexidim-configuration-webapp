import assert from "node:assert/strict";
import test from "node:test";
import { parseVerifyReply, VerifySession } from "../bridge/verify-session.mjs";

function selector(frame) {
  return frame[1] === 0x1b ? frame[2] : frame[1];
}

test("the 10-byte verification reply is decoded like the iOS app", () => {
  const reply = parseVerifyReply(
    Buffer.from([0x06, 0x34, 0x12, 11, 2, 3, 0x02, 0, 4, 0]),
  );
  assert.equal(reply.verified, true);
  assert.equal(reply.controllerChecksum, "1234");
  assert.equal(reply.day, "Monday");
  assert.equal(reply.time, "03:02:11");
  assert.equal(reply.version, "4.0");
});

test("verification follows fc, acknowledgement, f5, result, fe", () => {
  const sent = [];
  const results = [];
  const session = new VerifySession({
    send: (frame) => sent.push(frame),
    result: (value) => results.push(value),
    setIntervalFn: () => 1,
    clearIntervalFn: () => undefined,
  });

  assert.equal(session.start("abcd"), true);
  assert.deepEqual(sent.map(selector), [0xfc]);
  session.receive(Buffer.from([0x06]));
  session.tick();
  session.tick();
  assert.deepEqual(sent.map(selector), [0xfc, 0xf5]);
  session.receive(
    Buffer.from([0x06, 0x34, 0x12, 11, 2, 3, 0x02, 0, 4, 0]),
  );
  session.tick();
  assert.deepEqual(sent.map(selector), [0xfc, 0xf5, 0xfe]);
  assert.equal(results[0].state, "match");
  assert.match(results[0].message, /abcd/);
  assert.match(results[0].message, /1234/);
  assert.match(results[0].message, /Monday 03:02:11/);
  assert.match(results[0].message, /Version = 4\.0/);
});

test("passive channel records are passed through during verification", () => {
  const session = new VerifySession({
    send: () => undefined,
    result: () => undefined,
    setIntervalFn: () => 1,
    clearIntervalFn: () => undefined,
  });
  session.start("0000");
  const status = Buffer.from([0xf2, 0x03, 0x00, 0x75]);
  assert.deepEqual(session.receive(status), status);
  assert.equal(session.buffer.length, 0);
});
