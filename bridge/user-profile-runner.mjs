// Drive the user-profile-only send against a live controller, mirroring what
// the original iOS app actually does — no more, no less.
//
// THE WRITE HALF is oracle-proven. The app writes this fixed conversation on a
// 50 ms timer (JCLTabViewController -processUsDownload:) and never gates a write
// on a reply: the oracle completed a whole pass with no controller bytes
// supplied at all (tools/oracle/private/user_capture.m), and feeding the real
// captured replies to its reply ivar produced byte-identical frames. So the
// frames and their cadence are fixed, and one tick is one timer fire.
//
// WHAT THE APP DOES AFTER THE SEND (recovered 2026-07-29 from the disassembly of
// -processUsDownload: at 0x1000a8bf8): when -sendUserData:userOnly: reports it
// has sent the terminal `ff fe`, the app stops its timer, stops and hides its
// activity indicator, and RETURNS. It does not disconnect, does not read the
// controller, does not wait for a reset, does not count status records. It goes
// silent and leaves the connection idle. The controller commits `ff fe` and
// resets itself on its own timer afterwards.
//
// An earlier version of this runner copied the FULL transfer's ending —
// reset-wait, reconnect, ten status records — which the user-only path does not
// have. Combined with the bridge keeping the link busy, that pinned a real
// controller in suspended-transfer mode until it was power-cycled. This runner
// therefore does exactly what the app does: send, then go silent.
//
// The ONE thing this adds over the app, and only for feedback and evidence, is a
// passive listen after the last frame. Listening transmits nothing, so it is
// safe. The controller replied within a fraction of a second on the first
// hardware run (an `f2` status record and an `06` ack); observing that reply is
// what lets the UI say "uploaded, now resetting" instead of the app's silence.
// It is a courtesy window with a hard timeout — never a wait the send depends on.

import { UserProfileTransferSession } from "./user-transfer.mjs";
import { validateTransferFrame } from "./transfer-safety.mjs";

// The app's own user-only tick interval.
const TICK_MS = 50;
// How long to listen for the controller's reply after the last frame before
// reporting the send as complete-without-a-reply. The app waits zero; this is
// purely for feedback, so it is short and bounded.
const REPLY_WINDOW_MS = 10_000;
// Once the first reply byte arrives, gather the rest of the burst (the observed
// reply was `f2 …` immediately followed by `06`) before finishing, so the
// captured evidence is the whole exchange rather than its first packet.
const REPLY_SETTLE_MS = 2_000;

const USER_PROFILE_MESSAGES = Object.freeze({
  sending: (index, count) => `Sending user profile ${index} of ${count}`,
  sent: "User profiles sent - waiting for the Scene Controller to respond",
  responded: "Scene Controller responded - finishing",
  // Terminal, dismissible wording. Deliberately does not promise the reset
  // completes on its own: the one hardware run so far did not self-reset, so the
  // power-cycle fallback stays until a silent send is observed to recover.
  uploaded:
    "User profiles uploaded. The Scene Controller is now saving them and should reset itself, which can take a few minutes. Do not send commands or make changes until it has finished. If it has not returned to normal after several minutes, it may need to be power-cycled.",
  resetStarted:
    "User profiles uploaded and the Scene Controller has started to reset. This can take a few minutes, during which switches will not respond. Do not send commands or make changes until it has finished.",
  noReply:
    "User profiles were sent, but the Scene Controller did not respond within the wait window. It should save them and reset shortly. Do not send commands or make changes until it has returned to normal; if it has not after several minutes, it may need to be power-cycled.",
  unexpectedDisconnect:
    "The Scene Controller disconnected before every profile had been sent.",
});

// Outcomes where every frame reached the controller. All are surfaced as a
// completed send; only their wording differs.
const SENT_OUTCOMES = new Set(["completed", "reset-started", "sent-no-reply"]);

export class UserProfileSendRunner {
  constructor({
    userPayloads = [],
    write,
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
    // the half of the exchange the app never observed; it is always recorded.
    this.controllerBytes = [];
    this.replySeen = false;
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
   * Bytes from the controller. Always captured; nothing here is allowed to throw
   * into the socket data handler, and nothing is ever written in response.
   */
  receive(bytes) {
    const data = Buffer.from(bytes ?? []);
    if (!this.active || !data.length) return data;
    this.controllerBytes.push({ phase: this.phase, hex: data.toString("hex") });
    try {
      if (this.phase === "sending") {
        // The app consults nothing here, so this cannot steer the send. It is
        // recorded because it is the missing evidence.
        this.report(
          `Scene Controller sent ${data.length} bytes during the user-profile send`,
          { reply: data.toString("hex") },
        );
      } else if (this.phase === "awaiting-reply" && !this.replySeen) {
        // The reply we were listening for. Gather the rest of the burst, then
        // finish as a confirmed upload.
        this.replySeen = true;
        this.report(USER_PROFILE_MESSAGES.responded);
        if (this.replyWindowTimer) this.clearTimeoutFn(this.replyWindowTimer);
        this.settleTimer = this.setTimeoutFn(
          () => this.finish("completed"),
          REPLY_SETTLE_MS,
        );
      }
    } catch (error) {
      this.messages.push(
        `Controller bytes were captured but could not be interpreted: ${error.message}`,
      );
    }
    // Consume everything: the runner owns the socket until it finishes, and the
    // bytes are already captured.
    return Buffer.alloc(0);
  }

  tick() {
    if (!this.active || this.phase !== "sending") return;
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
      // Every frame is out, including the terminal `ff fe`. Stop transmitting —
      // exactly what the app does — and listen passively for a bounded window.
      if (this.timer) this.clearIntervalFn(this.timer);
      this.phase = "awaiting-reply";
      this.report(USER_PROFILE_MESSAGES.sent);
      this.replyWindowTimer = this.setTimeoutFn(
        () => this.finish("sent-no-reply"),
        REPLY_WINDOW_MS,
      );
    } catch (error) {
      this.failureMessage = error.message;
      this.finish("failed");
    }
  }

  /**
   * The controller dropping the link. Before the send is complete that is a
   * failure; during the listen window it is the reset actually starting — the
   * best outcome there is.
   */
  disconnected() {
    if (!this.active) return;
    if (this.phase === "awaiting-reply") {
      this.finish("reset-started");
      return;
    }
    this.failureMessage = USER_PROFILE_MESSAGES.unexpectedDisconnect;
    this.finish("unexpected-disconnect");
  }

  cancel(reason = "operator") {
    if (!this.active) return false;
    this.failureMessage = `User-profile send cancelled: ${reason}`;
    this.finish("cancelled");
    return true;
  }

  finish(outcome) {
    if (this.finished) return;
    this.finished = true;
    this.phase = "stopped";
    if (this.timer) this.clearIntervalFn(this.timer);
    if (this.replyWindowTimer) this.clearTimeoutFn(this.replyWindowTimer);
    if (this.settleTimer) this.clearTimeoutFn(this.settleTimer);
    const sent = SENT_OUTCOMES.has(outcome);
    const message =
      outcome === "completed"
        ? USER_PROFILE_MESSAGES.uploaded
        : outcome === "reset-started"
          ? USER_PROFILE_MESSAGES.resetStarted
          : outcome === "sent-no-reply"
            ? USER_PROFILE_MESSAGES.noReply
            : (this.failureMessage ?? `User-profile send stopped: ${outcome}`);
    this.messages.push(message);
    this.result({
      outcome,
      state: sent ? "completed" : "failed",
      frameCount: this.frames.length,
      frameNames: Object.freeze([...this.frames]),
      userCount: this.session.userPayloads.length,
      replyObserved: this.replySeen,
      // Every byte the controller sent, so an operator has the first real
      // observation of this exchange.
      controllerBytes: Object.freeze([...this.controllerBytes]),
      messages: Object.freeze([...this.messages]),
      message,
    });
  }
}

export const USER_PROFILE_RUNNER_TIMING = Object.freeze({
  tickMs: TICK_MS,
  replyWindowMs: REPLY_WINDOW_MS,
  replySettleMs: REPLY_SETTLE_MS,
});
export { USER_PROFILE_MESSAGES };
