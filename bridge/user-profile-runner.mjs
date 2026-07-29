// Drive the user-profile-only send against a live controller, and report what
// happens the way the full transfer does.
//
// Two halves, with very different evidence behind them.
//
// The WRITE half is oracle-proven. The original app writes this conversation on
// its 100 ms timer and never gates a write on a reply: the oracle completed a
// whole pass with no controller bytes supplied at all
// (tools/oracle/private/user_capture.m). So the frames and their cadence are
// fixed, and one session tick is one timer fire.
//
// The OBSERVE half reuses signals that are already hardware-verified from the
// full transfer, and is why this runner exists rather than a bare write loop.
// The trailing `ff fe` makes the profiles permanent, and an operator has since
// observed a real controller resetting after an iPad user-profile send — the
// same thing that ends a successful full transfer. So after the last frame this
// runner waits exactly as the full transfer's reset wait does: it watches for
// the disconnect, reconnects on the original app's 1 s + 2 s schedule, and
// counts validated `f2`/`f4` status records until the controller is running
// normally again.
//
// Everything the controller sends is captured verbatim throughout, including
// during the write phase. Whether that phase draws per-frame replies has never
// been observed; capturing it is how that question gets answered.

import { parseControllerReplies } from "./controller-replies.mjs";
import { UserProfileTransferSession } from "./user-transfer.mjs";
import { validateTransferFrame } from "./transfer-safety.mjs";

const TICK_MS = 100;
const RECONNECT_DELAY_MS = 3_000;
// The full transfer's own completion rule: ten validated status records.
const NORMAL_STATUS_COUNT = 10;
// 1,201 ticks at 100 ms, matching the original app's reset patience.
const RESET_TIMEOUT_TICKS = 1201;

const USER_PROFILE_MESSAGES = Object.freeze({
  sending: (index, count) => `Sending user profile ${index} of ${count}`,
  makingPermanent: "Making permanent - this takes up to 60 seconds",
  resetting: "User profiles sent - resetting Scene Controller",
  resetDuration: "This takes about 60 seconds",
  reconnecting: "Scene Controller reset detected; reconnecting in 3 seconds",
  resetWait: "Reconnected; waiting for normal Scene Controller status",
  retrying: "Scene Controller has not returned; retrying the iOS reconnect cycle",
  resetNotDetected: "Scene controller reset not detected",
  resetAdvisory:
    "The Scene Controller will reset automatically in a few minutes, if it is not already working normally.",
  completed: "User profiles sent successfully",
  runningNormally: "Scene controller running normally",
});

export class UserProfileSendRunner {
  constructor({
    userPayloads = [],
    write,
    reconnect = () => undefined,
    close = () => undefined,
    progress = () => undefined,
    result = () => undefined,
    ordinaryData = () => undefined,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    if (typeof write !== "function")
      throw new TypeError("user-profile runner requires a write function");
    this.session = new UserProfileTransferSession({ userPayloads });
    this.write = write;
    this.reconnect = reconnect;
    this.close = close;
    this.progress = progress;
    this.result = result;
    this.ordinaryData = ordinaryData;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.frames = [];
    this.messages = [];
    // Bytes the controller sent, tagged with the phase they arrived in. This is
    // the unobserved half of the exchange; it is always recorded.
    this.controllerBytes = [];
    this.statusBuffer = Buffer.alloc(0);
    this.normalStatusCount = 0;
    this.resetTicks = 0;
    this.connected = true;
    this.phase = "idle";
    this.finished = false;
  }

  get active() {
    return !this.finished && this.phase !== "idle";
  }

  report(message, extra = {}) {
    this.messages.push(message);
    this.progress({ state: this.phase, message, ...extra });
  }

  start() {
    if (this.phase !== "idle") return false;
    this.phase = "sending";
    this.report(
      USER_PROFILE_MESSAGES.sending(
        Math.min(1, this.session.userPayloads.length),
        this.session.userPayloads.length,
      ),
      { userIndex: 0, userCount: this.session.userPayloads.length },
    );
    this.timer = this.setIntervalFn(() => this.tick(), TICK_MS);
    return true;
  }

  /**
   * Bytes from the controller. During the write phase they are recorded but
   * never allowed to steer the send, because the original app does not consult
   * them there. During the reset wait they drive completion, exactly as the
   * full transfer's final-status counting does.
   */
  receive(bytes) {
    const data = Buffer.from(bytes ?? []);
    if (!this.active || !data.length) return data;
    this.controllerBytes.push({ phase: this.phase, hex: data.toString("hex") });
    if (this.phase === "sending") {
      this.report(
        `Scene Controller sent ${data.length} bytes during the user-profile send`,
        { reply: data.toString("hex") },
      );
      return Buffer.alloc(0);
    }
    this.statusBuffer = Buffer.concat([this.statusBuffer, data]);
    const parsed = parseControllerReplies(this.statusBuffer);
    this.statusBuffer = Buffer.from(parsed.rest);
    this.normalStatusCount += parsed.transferStatuses.length;
    const passthrough = Buffer.concat([...parsed.visible, ...parsed.invalid]);
    if (passthrough.length) this.ordinaryData(passthrough);
    if (this.normalStatusCount >= NORMAL_STATUS_COUNT) {
      this.report(USER_PROFILE_MESSAGES.runningNormally);
      this.stop("completed");
    }
    return Buffer.alloc(0);
  }

  tick() {
    if (!this.active) return;
    if (this.phase === "reset-wait") {
      this.resetTicks += 1;
      if (this.resetTicks >= RESET_TIMEOUT_TICKS) {
        this.report(USER_PROFILE_MESSAGES.resetNotDetected);
        this.report(USER_PROFILE_MESSAGES.resetAdvisory);
        // The profiles were written; only the reset was not seen.
        this.stop("reset-not-detected");
      }
      return;
    }
    try {
      const { frames, snapshot } = this.session.next();
      for (const frame of frames) {
        // Re-check every frame at the last moment before it reaches the wire.
        validateTransferFrame(frame);
        this.write(frame.bytes, frame);
        this.frames.push(frame.name);
      }
      if (!snapshot.complete) {
        this.report(
          USER_PROFILE_MESSAGES.sending(snapshot.userIndex, snapshot.userCount),
          { userIndex: snapshot.userIndex, userCount: snapshot.userCount },
        );
        return;
      }
      this.phase = "reset-wait";
      this.resetTicks = 0;
      this.report(USER_PROFILE_MESSAGES.makingPermanent);
      this.report(USER_PROFILE_MESSAGES.resetting);
      this.report(USER_PROFILE_MESSAGES.resetDuration);
    } catch (error) {
      this.failureMessage = error.message;
      this.stop("failed");
    }
  }

  /** The controller dropping the link after `ff fe` is the reset starting. */
  disconnected() {
    if (!this.active || !this.connected) return;
    this.connected = false;
    if (this.phase !== "reset-wait") {
      this.failureMessage =
        "The Scene Controller disconnected before every profile had been sent.";
      this.stop("unexpected-disconnect");
      return;
    }
    this.report(USER_PROFILE_MESSAGES.reconnecting);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.active || this.connected || this.reconnectTimer) return;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      if (!this.active || this.connected) return;
      this.reconnect({
        connected: () => this.reconnected(),
        failed: () => this.reconnectFailed(),
      });
    }, RECONNECT_DELAY_MS);
  }

  reconnected() {
    if (!this.active || this.phase !== "reset-wait") return false;
    this.connected = true;
    this.report(USER_PROFILE_MESSAGES.resetWait);
    return true;
  }

  reconnectFailed() {
    if (!this.active || this.connected) return;
    this.report(USER_PROFILE_MESSAGES.retrying);
    this.scheduleReconnect();
  }

  cancel(reason = "operator") {
    if (!this.active) return false;
    this.failureMessage = `User-profile send cancelled: ${reason}`;
    this.stop("cancelled");
    return true;
  }

  stop(outcome) {
    if (this.finished) return;
    this.finished = true;
    this.phase = "stopped";
    if (this.timer) this.clearIntervalFn(this.timer);
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    if (outcome === "completed") this.messages.push(USER_PROFILE_MESSAGES.completed);
    this.result({
      outcome,
      frameCount: this.frames.length,
      frameNames: Object.freeze([...this.frames]),
      userCount: this.session.userPayloads.length,
      // Every byte the controller sent, so an operator can hand back the first
      // real observation of this exchange.
      controllerBytes: Object.freeze([...this.controllerBytes]),
      normalStatusCount: this.normalStatusCount,
      messages: Object.freeze([...this.messages]),
      message:
        outcome === "completed"
          ? `${USER_PROFILE_MESSAGES.completed}. ${USER_PROFILE_MESSAGES.runningNormally}.`
          : outcome === "reset-not-detected"
            ? `${this.session.userPayloads.length} profiles were sent, but ${USER_PROFILE_MESSAGES.resetNotDetected.toLowerCase()}. ${USER_PROFILE_MESSAGES.resetAdvisory}`
            : (this.failureMessage ?? `User-profile send stopped: ${outcome}`),
    });
  }
}

export const USER_PROFILE_RUNNER_TIMING = Object.freeze({
  tickMs: TICK_MS,
  reconnectDelayMs: RECONNECT_DELAY_MS,
  normalStatusCount: NORMAL_STATUS_COUNT,
  resetTimeoutTicks: RESET_TIMEOUT_TICKS,
});
export { USER_PROFILE_MESSAGES };
