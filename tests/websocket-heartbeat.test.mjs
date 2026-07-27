import assert from "node:assert/strict";
import test from "node:test";
import {
  closeFrame,
  controlFrame,
  decodeFrames,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  pingFrame,
  pongFrame,
  websocketFrame,
  WebSocketHeartbeat,
} from "../bridge/websocket.mjs";

/** Mask a client frame the way a browser does, so the decoder sees real input. */
function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 0x80 | body.length]),
    mask,
    masked,
  ]);
}

function heartbeatHarness(options = {}) {
  const pinged = [];
  const reaped = [];
  let clock = 0;
  const timers = [];
  const beat = new WebSocketHeartbeat({
    intervalMs: 1_000,
    timeoutMs: 3_000,
    now: () => clock,
    ping: (socket) => pinged.push(socket),
    reap: (socket, silentMs) => reaped.push({ socket, silentMs }),
    setIntervalFn: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      timer.cleared = true;
    },
    ...options,
  });
  return {
    beat,
    pinged,
    reaped,
    timers,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    get clock() {
      return clock;
    },
  };
}

test("control frames set FIN and use the single-byte length form", () => {
  assert.deepEqual([...pingFrame()], [0x89, 0x00]);
  assert.deepEqual([...pongFrame()], [0x8a, 0x00]);
  assert.deepEqual([...closeFrame()], [0x88, 0x00]);
  assert.deepEqual([...pongFrame(Buffer.from([0xab, 0xcd]))], [0x8a, 0x02, 0xab, 0xcd]);
});

test("a control frame payload cannot exceed the RFC 6455 limit", () => {
  assert.doesNotThrow(() => controlFrame(0x9, Buffer.alloc(125)));
  assert.throws(() => controlFrame(0x9, Buffer.alloc(126)), /cannot exceed 125 bytes/);
});

test("text frames are unmasked and carry JSON", () => {
  const frame = websocketFrame({ type: "status" });
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], JSON.stringify({ type: "status" }).length);
  assert.equal(frame.subarray(2).toString("utf8"), '{"type":"status"}');
});

test("decoding separates text, ping, pong and close", () => {
  const decoded = decodeFrames(Buffer.concat([
    clientFrame(0x1, Buffer.from('{"type":"verify"}')),
    clientFrame(0x9, Buffer.from([0x01, 0x02])),
    clientFrame(0xa),
    clientFrame(0x8),
  ]));
  assert.deepEqual(decoded.messages, ['{"type":"verify"}']);
  assert.equal(decoded.pings.length, 1);
  assert.deepEqual([...decoded.pings[0]], [0x01, 0x02]);
  assert.equal(decoded.pongs.length, 1);
  assert.equal(decoded.closeRequested, true);
  assert.equal(decoded.rest.length, 0);
});

test("a frame split across reads is retained, not dropped", () => {
  const frame = clientFrame(0x1, Buffer.from('{"type":"verify"}'));
  const first = decodeFrames(frame.subarray(0, 7));
  assert.deepEqual(first.messages, []);
  assert.equal(first.rest.length, 7);
  const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(7)]));
  assert.deepEqual(second.messages, ['{"type":"verify"}']);
  assert.equal(second.rest.length, 0);
});

test("the heartbeat pings a client that is still answering and never reaps it", () => {
  const harness = heartbeatHarness();
  const socket = { name: "client" };
  harness.beat.add(socket);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].milliseconds, 1_000);

  // Three rounds of ping, each answered before the 3,000ms timeout.
  for (let round = 0; round < 3; round += 1) {
    harness.advance(1_000);
    harness.beat.tick();
    harness.beat.touch(socket);
  }
  assert.equal(harness.pinged.length, 3);
  assert.deepEqual(harness.reaped, []);
  assert.equal(harness.beat.tracked, 1);
});

test("the heartbeat reaps a client that has gone silent past the timeout", () => {
  const harness = heartbeatHarness();
  const socket = { name: "dead" };
  harness.beat.add(socket);

  harness.advance(1_000);
  harness.beat.tick();
  harness.advance(1_000);
  harness.beat.tick();
  // Two pings sent, no answer, still inside the timeout.
  assert.equal(harness.pinged.length, 2);
  assert.deepEqual(harness.reaped, []);

  harness.advance(1_000);
  harness.beat.tick();
  assert.equal(harness.reaped.length, 1);
  assert.equal(harness.reaped[0].socket, socket);
  assert.equal(harness.reaped[0].silentMs, 3_000);
  // Reaped exactly once, and no further ping is sent to a dead socket.
  assert.equal(harness.pinged.length, 2);
  harness.advance(10_000);
  harness.beat.tick();
  assert.equal(harness.reaped.length, 1);
});

test("inbound activity other than a pong also counts as liveness", () => {
  const harness = heartbeatHarness();
  const socket = { name: "chatty" };
  harness.beat.add(socket);
  harness.advance(2_900);
  harness.beat.touch(socket);
  harness.advance(2_900);
  harness.beat.tick();
  assert.deepEqual(harness.reaped, []);
  assert.equal(harness.pinged.length, 1);
});

test("one silent client is reaped without disturbing a healthy one", () => {
  const harness = heartbeatHarness();
  const alive = { name: "alive" };
  const dead = { name: "dead" };
  harness.beat.add(alive);
  harness.beat.add(dead);
  harness.advance(3_000);
  harness.beat.touch(alive);
  harness.beat.tick();
  assert.deepEqual(harness.reaped.map((entry) => entry.socket), [dead]);
  assert.deepEqual(harness.pinged, [alive]);
  assert.equal(harness.beat.tracked, 1);
});

test("the timer runs only while clients are tracked", () => {
  const harness = heartbeatHarness();
  const first = { name: "first" };
  const second = { name: "second" };
  harness.beat.add(first);
  harness.beat.add(second);
  assert.equal(harness.timers.length, 1, "one shared timer, not one per client");
  harness.beat.remove(first);
  assert.equal(harness.timers[0].cleared, false);
  harness.beat.remove(second);
  assert.equal(harness.timers[0].cleared, true, "an idle bridge schedules no work");

  harness.beat.add(first);
  assert.equal(harness.timers.length, 2, "tracking resumes on the next client");
});

test("touching an untracked or already reaped socket does nothing", () => {
  const harness = heartbeatHarness();
  const socket = { name: "gone" };
  harness.beat.touch(socket);
  assert.equal(harness.beat.tracked, 0);
  harness.beat.add(socket);
  harness.beat.remove(socket);
  harness.beat.touch(socket);
  assert.equal(harness.beat.tracked, 0);
});

test("a timeout that does not exceed the ping interval is refused", () => {
  assert.throws(
    () => heartbeatHarness({ intervalMs: 5_000, timeoutMs: 5_000 }),
    /idle timeout must exceed the ping interval/,
  );
  assert.throws(() => heartbeatHarness({ intervalMs: 0 }), /positive ping interval/);
});

test("the shipped defaults leave room for at least two unanswered pings", () => {
  assert.ok(
    IDLE_TIMEOUT_MS >= PING_INTERVAL_MS * 2,
    "a single dropped pong must not disconnect a healthy client",
  );
});
