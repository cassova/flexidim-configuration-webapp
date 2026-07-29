// The live user-profile send and the feedback it reports.
//
// The write half is fixed by the oracle (see tests/user-transfer.test.mjs).
// These tests cover the observable half: per-profile progress, the reset wait
// after `ff fe`, reconnect, the ten-record "running normally" rule, and the
// capture of anything the controller sends — including during the write phase,
// where the original app consults nothing.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLegacyFd4Config } from "../app/fd4cfg.ts";
import { compileUserProfiles } from "../app/compile-user-profiles.ts";
import {
  UserProfileSendRunner,
  USER_PROFILE_RUNNER_TIMING,
} from "../bridge/user-profile-runner.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function goldenPayloads(name = "user-transfer-three-users.fd4cfg") {
  const bytes = fs.readFileSync(
    path.join(root, "tools", "oracle", "fixtures", name),
  );
  const data = parseLegacyFd4Config(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const compiled = compileUserProfiles(data);
  assert.deepEqual(compiled.problems, []);
  return compiled.payloads;
}

/** A runner wired to fake timers and an in-memory controller. */
function harness(userPayloads, { failWriteOn } = {}) {
  const written = [];
  const progress = [];
  const results = [];
  const intervals = [];
  const timeouts = [];
  let reconnects = 0;
  const runner = new UserProfileSendRunner({
    userPayloads,
    write: (bytes, frame) => {
      if (failWriteOn && frame.name === failWriteOn)
        throw new Error(`Scene Controller disconnected before ${frame.name}`);
      written.push({ name: frame.name, bytes });
    },
    reconnect: ({ connected }) => {
      reconnects += 1;
      connected();
    },
    progress: (value) => progress.push(value),
    result: (value) => results.push(value),
    setIntervalFn: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearIntervalFn: () => undefined,
    setTimeoutFn: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeoutFn: () => undefined,
  });
  return {
    runner,
    written,
    progress,
    results,
    tick: (times = 1) => {
      for (let index = 0; index < times; index += 1) intervals[0]();
    },
    fireTimeouts: () => {
      const pending = timeouts.splice(0);
      for (const callback of pending) callback();
    },
    get reconnects() {
      return reconnects;
    },
  };
}

/**
 * A valid f2 channel-status record, the kind a controller emits when it is
 * running normally. The check byte is a seven-bit additive sum.
 */
function statusRecord(channel = 3, level = 0) {
  const body = [0xf2, channel, level];
  const check = body.reduce((total, byte) => (total + byte) & 0x7f, 0);
  return Buffer.from([...body, check]);
}

test("each profile is written on its own tick, with progress for each", () => {
  const payloads = goldenPayloads();
  const h = harness(payloads);
  h.runner.start();
  assert.equal(h.written.length, 0, "start writes nothing before the first tick");

  h.tick();
  assert.deepEqual(
    h.written.map((item) => item.name),
    ["prepare-user-data", "user-data"],
  );
  h.tick();
  h.tick();
  assert.equal(
    h.written.filter((item) => item.name === "user-data").length,
    payloads.length,
    "one profile per tick",
  );
  assert.deepEqual(
    h.progress
      .filter((item) => item.userIndex !== undefined)
      .map((item) => item.userIndex),
    [0, 1, 2, 3],
  );
});

test("after the last frame it reports making permanent and waits for the reset", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  assert.deepEqual(h.written.map((item) => item.name).slice(-2), [
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  const messages = h.progress.map((item) => item.message);
  assert.ok(messages.some((text) => /Making permanent/.test(text)));
  assert.ok(messages.some((text) => /resetting Scene Controller/.test(text)));
  assert.equal(h.results.length, 0, "the send is not finished at the last frame");
  assert.equal(h.runner.phase, "reset-wait");
});

test("the reset, reconnect and ten status records complete the send", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);

  // The controller drops the link while it resets, exactly as it does at the
  // end of a full transfer.
  h.runner.disconnected();
  assert.ok(
    h.progress.some((item) => /reconnecting in 3 seconds/.test(item.message)),
  );
  h.fireTimeouts();
  assert.equal(h.reconnects, 1);
  assert.ok(h.progress.some((item) => /waiting for normal/.test(item.message)));

  for (let index = 0; index < USER_PROFILE_RUNNER_TIMING.normalStatusCount; index += 1)
    h.runner.receive(statusRecord(index + 1, 0));

  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "completed");
  assert.match(h.results[0].message, /running normally/i);
  assert.equal(
    h.results[0].normalStatusCount,
    USER_PROFILE_RUNNER_TIMING.normalStatusCount,
  );
});

test("a reset that never completes still reports the profiles as sent", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  h.tick(USER_PROFILE_RUNNER_TIMING.resetTimeoutTicks);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "reset-not-detected");
  assert.match(h.results[0].message, /profiles were sent/);
  assert.match(h.results[0].message, /reset automatically/);
});

test("bytes the controller sends during the send are captured, not obeyed", () => {
  // The original app consults nothing here, so an unexpected reply must not
  // change what is written — but it is the missing evidence, so it is recorded.
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick();
  h.runner.receive(Buffer.from([0x06]));
  h.tick();
  h.tick();
  h.tick();
  assert.deepEqual(h.written.map((item) => item.name), [
    "prepare-user-data",
    "user-data",
    "user-data",
    "user-data",
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  h.tick(USER_PROFILE_RUNNER_TIMING.resetTimeoutTicks);
  const captured = h.results[0].controllerBytes;
  assert.deepEqual(captured, [{ phase: "sending", hex: "06" }]);
  assert.ok(
    h.progress.some((item) => /sent 1 bytes during the user-profile send/.test(item.message)),
  );
});

test("losing the controller mid-send fails instead of reporting success", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick();
  h.runner.disconnected();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "unexpected-disconnect");
  assert.match(h.results[0].message, /before every profile had been sent/);
});

test("a write failure stops the send and says which frame failed", () => {
  const h = harness(goldenPayloads(), { failWriteOn: "make-user-data-permanent" });
  h.runner.start();
  h.tick(4);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "failed");
  assert.match(h.results[0].message, /make-user-data-permanent/);
});

test("a configuration with no users still completes the whole lifecycle", () => {
  const h = harness([]);
  h.runner.start();
  h.tick();
  assert.deepEqual(h.written.map((item) => item.name), [
    "prepare-user-data",
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  assert.equal(h.runner.phase, "reset-wait");
});
