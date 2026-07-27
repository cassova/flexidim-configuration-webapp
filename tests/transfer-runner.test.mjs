import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FINAL_STATUS_TIMEOUT_TICKS,
} from "../bridge/config-transfer.mjs";
import {
  ConfigurationTransferRunner,
  TRANSFER_RUNNER_TIMING,
} from "../bridge/transfer-runner.mjs";
import { TransferPrefixEmulator } from "../tools/oracle/transfer-prefix-emulator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "tools", "oracle", "fixtures");
const image = fs.readFileSync(
  path.join(fixtures, "transfer-oracle-image.bin"),
);
const wire = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "transfer-oracle-wire.json"),
    "utf8",
  ),
).map((hex) => Buffer.from(hex, "hex"));
const userPayloads = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "transfer-oracle-user-payloads.json"),
    "utf8",
  ),
).map((value) => Buffer.from(value, "base64"));

function unescapeCapturedFrame(bytes) {
  const output = [bytes[0]];
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] === 0x1b) index += 1;
    output.push(bytes[index]);
  }
  return Buffer.from(output);
}

const fromBcd = (value) => ((value >>> 4) & 0x0f) * 10 + (value & 0x0f);
const capturedTime = unescapeCapturedFrame(wire[0]);
const capturedDate = unescapeCapturedFrame(wire[1]);
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

function normalStatusRecord(index) {
  const channel = index & 0x7f;
  const level = (index * 7) % 101;
  const body = Buffer.from([0xf2, channel, level]);
  const check = body.reduce((sum, byte) => (sum + byte) & 0x7f, 0);
  return Buffer.concat([body, Buffer.from([check])]);
}

function normalF4Record(index) {
  const body = Buffer.from([0xf4, index & 0x7f, (index * 3) & 0x7f, 0]);
  const check = body.reduce((sum, byte) => (sum + byte) & 0x7f, 0);
  return Buffer.concat([body, Buffer.from([check])]);
}

function harness({ emulator, replyTransform, reconnect } = {}) {
  const expected = emulator ?? new TransferPrefixEmulator({ expectedFrames: wire });
  const intervals = [];
  const timeouts = [];
  const results = [];
  const progress = [];
  let closed = 0;
  let runner;
  const write = (bytes, frame) => {
    const reply = expected.receive(bytes);
    if (!reply) return;
    const pieces = replyTransform?.(reply, frame) ?? [reply];
    for (const piece of pieces) runner.receive(piece);
  };
  runner = new ConfigurationTransferRunner({
    sessionOptions: { image, clock, userPayloads },
    write,
    reconnect: reconnect ?? (({ connected }) => connected()),
    close: () => { closed += 1; },
    progress: (value) => progress.push(value),
    result: (value) => results.push(value),
    setIntervalFn: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    clearIntervalFn: () => undefined,
    setTimeoutFn: (callback, milliseconds) => {
      const item = { callback, milliseconds, cleared: false };
      timeouts.push(item);
      return item;
    },
    clearTimeoutFn: (item) => { item.cleared = true; },
  });
  return {
    runner,
    emulator: expected,
    results,
    progress,
    intervals,
    timeouts,
    get closed() { return closed; },
  };
}

function reachFinalStatus(value) {
  value.runner.start();
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (value.runner.session.state === "final-status") return;
    assert.equal(value.runner.active, true, "runner stopped before final status");
    value.runner.tick();
  }
  assert.fail("runner did not reach final status");
}

test("the runner drives the complete oracle transcript, reconnect and normal-status gate", () => {
  const value = harness();
  reachFinalStatus(value);
  assert.equal(value.runner.frames.length, 295);
  assert.equal(value.emulator.cursor, wire.length);
  assert.equal(value.intervals[0].milliseconds, 100);

  value.runner.disconnected();
  assert.equal(value.timeouts.length, 1);
  assert.equal(
    value.timeouts[0].milliseconds,
    TRANSFER_RUNNER_TIMING.reconnectDelayMs,
  );
  value.timeouts[0].callback();
  assert.equal(value.runner.connected, true);

  for (let index = 0; index < 10; index += 1) {
    value.emulator.status();
    // Both validated f2 and f4 branches increment the original app's
    // F3MsgCount. Split them at every possible kind of TCP boundary.
    const record =
      index % 2 === 0 ? normalStatusRecord(index) : normalF4Record(index);
    value.runner.receive(record.subarray(0, index % 4));
    value.runner.receive(record.subarray(index % 4));
  }
  value.runner.tick();

  assert.equal(value.results.length, 1);
  assert.equal(value.results[0].outcome, "completed");
  assert.equal(value.emulator.complete, true);
  assert.match(
    value.progress.at(-1).message,
    /Scene controller running normally/,
  );
  assert.equal(value.closed, 0);
});

test("fragmented post-image and permanence replies follow the same state order", () => {
  const value = harness({
    replyTransform: (reply, frame) => {
      if (frame.name === "commit-image")
        return [reply.subarray(0, 3), reply.subarray(3, 7), reply.subarray(7)];
      if (frame.name === "post-image-query")
        return [reply.subarray(0, 1), reply.subarray(1)];
      return [reply];
    },
  });
  reachFinalStatus(value);
  assert.equal(value.runner.session.state, "final-status");
  assert.equal(value.runner.frames.length, wire.length);
});

test("a setup-FC reply is cleared before the actual transfer handshake", () => {
  const expected = new TransferPrefixEmulator({ expectedFrames: wire });
  const emulator = {
    receive(bytes) {
      const reply = expected.receive(bytes);
      return expected.fcCount === 1 ? Buffer.from([0x06]) : reply;
    },
    get cursor() { return expected.cursor; },
  };
  const value = harness({ emulator });
  reachFinalStatus(value);
  assert.equal(value.runner.session.state, "final-status");
  assert.equal(value.emulator.cursor, wire.length);
});

test("five block retries are bounded and the sixth NAK runs the iOS F8 abort", () => {
  const value = harness({
    emulator: new TransferPrefixEmulator({
      expectedFrames: wire,
      nakByBlock: new Map([[0, 6]]),
    }),
  });
  value.runner.start();
  for (let guard = 0; guard < 500; guard += 1) {
    if (!value.runner.active) break;
    value.runner.tick();
  }
  assert.equal(value.results[0].outcome, "aborted");
  assert.equal(value.runner.frames.at(-1).name, "abort");
  assert.equal(
    value.progress.filter(({ message }) => /^Retrying block 1/.test(message))
      .length,
    5,
  );
});

test("an unexpected disconnect before reset wait is terminal and closes transport", () => {
  const value = harness();
  value.runner.start();
  while (value.runner.session.state !== "block-ack") value.runner.tick();
  value.runner.disconnected();
  assert.equal(value.results[0].outcome, "unexpected-disconnect");
  assert.equal(value.closed, 1);
  assert.equal(value.runner.session.state, "disconnected");
});

test("reset wait cannot succeed without ten validated f2/f4 status records", () => {
  const value = harness();
  reachFinalStatus(value);
  for (let index = 0; index < 9; index += 1)
    value.runner.receive(normalStatusRecord(index));
  value.runner.tick();
  assert.equal(value.runner.active, true);
  assert.equal(value.runner.session.state, "final-status");

  // A malformed status has the right shape but the wrong additive check.
  value.runner.receive(Buffer.from([0xf2, 0, 0, 0]));
  for (let index = 1; index < FINAL_STATUS_TIMEOUT_TICKS; index += 1)
    value.runner.tick();
  assert.equal(value.results[0].outcome, "final-status-timeout");
  assert.equal(value.closed, 0);
  assert.match(
    value.progress.at(-1).message,
    /reset automatically in a few minutes/,
  );
});

test("ambiguous extra bytes in a one-byte ACK fail closed", () => {
  const expected = new TransferPrefixEmulator({ expectedFrames: wire });
  const value = harness({
    emulator: expected,
    replyTransform: (reply, frame) =>
      frame.name === "prepare-user-data" && expected.fcCount === 2
        ? [Buffer.concat([reply, Buffer.from([0])])]
        : [reply],
  });
  value.runner.start();
  value.runner.tick();
  value.runner.tick();
  assert.equal(value.results[0].outcome, "invalid-controller-reply");
  assert.equal(value.closed, 1);
});

test("failed reset reconnects repeat the original three-second cycle", () => {
  let attempts = 0;
  const value = harness({
    reconnect: ({ connected, failed }) => {
      attempts += 1;
      if (attempts < 3) failed();
      else connected();
    },
  });
  reachFinalStatus(value);
  value.runner.disconnected();
  value.timeouts[0].callback();
  value.timeouts[1].callback();
  value.timeouts[2].callback();
  assert.equal(attempts, 3);
  assert.equal(value.runner.connected, true);
  assert.equal(value.runner.active, true);
  assert.ok(value.timeouts.every(({ milliseconds }) =>
    milliseconds === TRANSFER_RUNNER_TIMING.reconnectDelayMs));
});

test("operator cancellation closes transport and leaves no background runner", () => {
  const value = harness();
  value.runner.start();
  const frameCount = value.runner.frames.length;
  assert.equal(value.runner.cancel("test operator"), true);
  assert.equal(value.results[0].outcome, "cancelled");
  assert.equal(value.closed, 1);
  assert.equal(value.runner.active, false);
  value.runner.tick();
  assert.equal(value.runner.frames.length, frameCount);
});

test("an opening socket write failure is terminal and closes transport", () => {
  const results = [];
  let closed = 0;
  const runner = new ConfigurationTransferRunner({
    sessionOptions: { image, clock, userPayloads },
    write: () => { throw new Error("synthetic socket failure"); },
    reconnect: () => undefined,
    close: () => { closed += 1; },
    result: (value) => results.push(value),
    setIntervalFn: () => 1,
    clearIntervalFn: () => undefined,
  });
  assert.equal(runner.start(), true);
  assert.equal(runner.active, false);
  assert.equal(results[0].outcome, "transport-write-failed");
  assert.equal(closed, 1);
});
