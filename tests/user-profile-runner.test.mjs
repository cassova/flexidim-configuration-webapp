// The live user-profile send and the feedback it reports.
//
// The write half is fixed by the oracle (see tests/user-transfer.test.mjs).
// These tests cover the observable half, which now mirrors the original app:
// send every frame, then go silent and listen. The app does not disconnect,
// reconnect, count status records, or react to replies (recovered from
// -processUsDownload:). The runner adds only a bounded, passive listen window so
// the UI can report the upload and capture whatever the controller says.

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
  let intervalCallback = null;
  const timeouts = new Map();
  let nextTimeoutId = 0;
  const runner = new UserProfileSendRunner({
    userPayloads,
    write: (bytes, frame) => {
      if (failWriteOn && frame.name === failWriteOn)
        throw new Error(`Scene Controller disconnected before ${frame.name}`);
      written.push({ name: frame.name, bytes });
    },
    progress: (value) => progress.push(value),
    result: (value) => results.push(value),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {
      intervalCallback = null;
    },
    setTimeoutFn: (callback) => {
      const id = ++nextTimeoutId;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeoutFn: (id) => {
      timeouts.delete(id);
    },
  });
  return {
    runner,
    written,
    progress,
    results,
    tick: (times = 1) => {
      for (let index = 0; index < times; index += 1) intervalCallback?.();
    },
    // Fire whatever timeouts are currently registered (a cleared one is gone).
    fireTimeouts: () => {
      for (const callback of [...timeouts.values()]) callback();
    },
    pendingTimeouts: () => timeouts.size,
  };
}

test("the tick uses the app's 50 ms user-only interval", () => {
  assert.equal(USER_PROFILE_RUNNER_TIMING.tickMs, 50);
});

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

test("after the last frame it goes silent and waits for a reply", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  assert.deepEqual(h.written.map((item) => item.name).slice(-2), [
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  assert.equal(h.runner.phase, "awaiting-reply");
  assert.ok(
    h.progress.some((item) => /waiting for the Scene Controller/.test(item.message)),
  );
  assert.equal(h.results.length, 0, "the send is not finished until it stops listening");

  // Going silent: further ticks transmit nothing.
  const writtenAfter = h.written.length;
  h.tick(10);
  assert.equal(h.written.length, writtenAfter, "no frames are sent after ff fe");
});

test("a reply during the listen window completes the send as an upload", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  // The controller answers immediately, as it did on hardware: an f2 record then 06.
  h.runner.receive(Buffer.from([0xf2, 0x0b, 0x00, 0x7d]));
  h.runner.receive(Buffer.from([0x06]));
  assert.equal(h.results.length, 0, "it settles briefly before finishing");
  h.fireTimeouts();

  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "completed");
  assert.equal(h.results[0].state, "completed");
  assert.equal(h.results[0].replyObserved, true);
  assert.match(h.results[0].message, /uploaded/i);
  assert.match(h.results[0].message, /reset/i);
  assert.deepEqual(h.results[0].controllerBytes, [
    { phase: "awaiting-reply", hex: "f20b007d" },
    { phase: "awaiting-reply", hex: "06" },
  ]);
});

test("no reply within the window still reports the profiles as sent", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  assert.equal(h.pendingTimeouts(), 1, "the reply window is armed");
  h.fireTimeouts();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "sent-no-reply");
  assert.equal(h.results[0].state, "completed");
  assert.equal(h.results[0].replyObserved, false);
  assert.match(h.results[0].message, /did not respond/);
});

test("the controller dropping the link while listening is the reset starting", () => {
  const h = harness(goldenPayloads());
  h.runner.start();
  h.tick(4);
  h.runner.disconnected();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "reset-started");
  assert.equal(h.results[0].state, "completed");
  assert.match(h.results[0].message, /started to reset/);
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
  h.fireTimeouts();
  assert.deepEqual(h.results[0].controllerBytes, [{ phase: "sending", hex: "06" }]);
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
  assert.equal(h.results[0].state, "failed");
  assert.match(h.results[0].message, /before every profile had been sent/);
});

test("a write failure stops the send and says which frame failed", () => {
  const h = harness(goldenPayloads(), { failWriteOn: "make-user-data-permanent" });
  h.runner.start();
  h.tick(4);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].outcome, "failed");
  assert.equal(h.results[0].state, "failed");
  assert.match(h.results[0].message, /make-user-data-permanent/);
});

test("a configuration with no users still sends and goes silent", () => {
  const h = harness([]);
  h.runner.start();
  h.tick();
  assert.deepEqual(h.written.map((item) => item.name), [
    "prepare-user-data",
    "all-users-complete",
    "make-user-data-permanent",
  ]);
  assert.equal(h.runner.phase, "awaiting-reply");
});
