// What the send dialog does after user profiles have been written.
//
// Ground truth (PROTOCOL.md): the controller applies the profiles and restarts,
// and a Compare read-back is what completes the reset. Automatic reconnect
// polling proved unreliable on hardware, so the operator drives it: a two-minute
// countdown, then "Reconnect & Sync" reconnects and Compares.

import assert from "node:assert/strict";
import test from "node:test";
import {
  UserProfileRecovery,
  USER_PROFILE_RECOVERY_TIMING,
} from "../app/user-profile-recovery.ts";

/** A recovery wired to fake timers, recording view/reconnect/verify calls. */
function harness() {
  const views = [];
  let reconnects = 0;
  let verifies = 0;
  const timers = new Map();
  let nextId = 0;
  const recovery = new UserProfileRecovery({
    onView: (view) => views.push(view),
    reconnect: () => {
      reconnects += 1;
    },
    sendVerify: () => {
      verifies += 1;
    },
    setTimeoutFn: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
  });
  return {
    recovery,
    views,
    get reconnects() {
      return reconnects;
    },
    get verifies() {
      return verifies;
    },
    get phase() {
      return recovery.phase;
    },
    last: () => views.at(-1),
    pending: () => timers.size,
    fire: (ms) => {
      for (const [id, timer] of timers) {
        if (timer.ms === ms) {
          timers.delete(id);
          timer.callback();
          return true;
        }
      }
      return false;
    },
  };
}

const T = USER_PROFILE_RECOVERY_TIMING;

/** Start and run the countdown out, leaving the machine ready to sync. */
function ready(h) {
  h.recovery.start();
  h.fire(T.countdownMs);
}

test("the built-in timers survive a browser's receiver check", async () => {
  // Regression: the defaults used to be `?? setTimeout`, stored on the instance
  // and invoked as `this.setTimeoutFn(...)` — which passes the recovery object as
  // the receiver. Browsers throw "Illegal invocation" for that (Node does not),
  // so in the real app every timer arm threw, the error was swallowed upstream,
  // and the dialog parked forever. This reproduces the browser's strictness
  // against the DEFAULT timers (none injected).
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function browserLikeSetTimeout(callback, ms) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return realSetTimeout(callback, ms);
  };
  globalThis.clearTimeout = function browserLikeClearTimeout(handle) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return realClearTimeout(handle);
  };
  let recovery;
  try {
    const views = [];
    recovery = new UserProfileRecovery({
      onView: (view) => views.push(view),
      reconnect: () => undefined,
      sendVerify: () => undefined,
      timing: { ...T, countdownMs: 10 },
    });
    recovery.start();
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    assert.equal(recovery.phase, "ready", "the countdown ran with real timers");
  } finally {
    recovery?.stop();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("it opens on a countdown with syncing disabled", () => {
  const h = harness();
  h.recovery.start();
  assert.equal(h.phase, "waiting");
  assert.equal(h.last().countdownMs, T.countdownMs);
  assert.equal(h.last().canSync, false, "the button is disabled while waiting");
  assert.match(h.last().message, /applying them and restarting/);
  assert.equal(h.reconnects, 0, "nothing is sent to the controller while waiting");
});

test("pressing sync before the countdown ends does nothing", () => {
  const h = harness();
  h.recovery.start();
  assert.equal(h.recovery.reconnectAndSync(), false);
  assert.equal(h.phase, "waiting");
  assert.equal(h.reconnects, 0);
});

test("when the countdown expires the button is offered with lights guidance", () => {
  const h = harness();
  ready(h);
  assert.equal(h.phase, "ready");
  assert.equal(h.last().canSync, true);
  assert.match(h.last().message, /lights are on/);
  assert.equal(h.last().countdownMs, undefined, "no countdown once ready");
  assert.equal(h.pending(), 0, "nothing is scheduled while it waits on the operator");
});

test("Reconnect & Sync reconnects, then Compares once connected", () => {
  const h = harness();
  ready(h);
  assert.equal(h.recovery.reconnectAndSync(), true);
  assert.equal(h.phase, "syncing");
  assert.equal(h.reconnects, 1);
  assert.equal(h.last().canSync, false, "the button is disabled mid-sync");
  assert.equal(h.verifies, 0, "it Compares only after the connection is up");
  h.recovery.connectionEstablished();
  assert.equal(h.verifies, 1);
  h.recovery.compareResult("match");
  assert.equal(h.phase, "success");
  assert.match(h.last().message, /completing its final reset/);
  assert.equal(h.pending(), 0);
});

test("a different checksum still counts as the reset being triggered", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  h.recovery.connectionEstablished();
  h.recovery.compareResult("different");
  assert.equal(h.phase, "success");
});

test("a connection that never comes up fails and re-offers the button", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  assert.ok(h.fire(T.connectTimeoutMs), "the connect attempt is bounded");
  assert.equal(h.phase, "failed");
  assert.equal(h.last().canSync, true, "the operator can try again");
  assert.match(h.last().message, /press .Reconnect & Sync. again/);
  // And trying again works.
  assert.equal(h.recovery.reconnectAndSync(), true);
  assert.equal(h.reconnects, 2);
});

test("a reconnect that fails outright re-offers the button", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  h.recovery.reconnectFailed();
  assert.equal(h.phase, "failed");
  assert.equal(h.last().canSync, true);
});

test("a Compare that never answers fails via its own timeout", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  h.recovery.connectionEstablished();
  assert.ok(h.fire(T.compareResultTimeoutMs));
  assert.equal(h.phase, "failed");
});

test("a Compare error fails and re-offers the button", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  h.recovery.connectionEstablished();
  h.recovery.compareResult("error");
  assert.equal(h.phase, "failed");
  assert.equal(h.last().canSync, true);
});

test("signals outside a sync are ignored", () => {
  const h = harness();
  ready(h);
  const before = h.views.length;
  h.recovery.connectionEstablished();
  h.recovery.compareResult("match");
  h.recovery.reconnectFailed();
  assert.equal(h.views.length, before, "nothing changed while merely ready");
  assert.equal(h.phase, "ready");
});

test("stop clears everything and ignores later signals", () => {
  const h = harness();
  h.recovery.start();
  h.recovery.stop();
  assert.equal(h.phase, "stopped");
  assert.equal(h.pending(), 0);
  const before = h.views.length;
  h.recovery.reconnectAndSync();
  h.recovery.compareResult("match");
  assert.equal(h.views.length, before);
});

test("late signals after success are ignored", () => {
  const h = harness();
  ready(h);
  h.recovery.reconnectAndSync();
  h.recovery.connectionEstablished();
  h.recovery.compareResult("match");
  assert.equal(h.phase, "success");
  const before = h.views.length;
  h.recovery.compareResult("error");
  h.recovery.reconnectAndSync();
  assert.equal(h.views.length, before);
  assert.equal(h.phase, "success");
});
