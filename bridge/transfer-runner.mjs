import { parseControllerReplies } from "./controller-replies.mjs";
import { ConfigurationTransferSession } from "./config-transfer.mjs";

const TICK_MS = 100;
// On an end/error event the original type-0 stream handler schedules
// tcpOpenTimeout: after one second. Its manual-host branch then schedules
// schedTcpOpen after another two seconds.
const RECONNECT_DELAY_MS = 3_000;

const REPLY_LENGTH = Object.freeze({
  handshake: 1,
  "block-ack": 1,
  "post-image-status": 10,
  "f9-ack": 2,
});

const TERMINAL_SESSION_STATES = new Set([
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "disconnected",
  "connection-timeout",
  "post-image-timeout",
  "f9-timeout",
  "final-status-timeout",
]);

/**
 * Side-effect boundary for the oracle-proven type-0 transfer state machine.
 *
 * The runner owns timing, reply fragmentation, validated normal-status
 * counting and the reset/reconnect wait. It does not create a socket: the
 * bridge supplies write/reconnect/close functions, which keeps the protocol
 * testable without making live controller access reachable from a web command.
 */
export class ConfigurationTransferRunner {
  constructor({
    sessionOptions,
    write,
    reconnect,
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
      throw new TypeError("transfer runner requires a write function");
    if (typeof reconnect !== "function")
      throw new TypeError("transfer runner requires a reconnect function");
    this.session = new ConfigurationTransferSession(sessionOptions);
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
    this.replyBuffer = Buffer.alloc(0);
    this.statusBuffer = Buffer.alloc(0);
    this.frames = [];
    this.messages = [];
    this.connected = true;
    this.phase = "idle";
    this.finished = false;
  }

  get active() {
    return !this.finished && this.phase !== "idle";
  }

  start() {
    if (this.phase !== "idle") return false;
    this.phase = "running";
    this.timer = this.setIntervalFn(() => this.tick(), TICK_MS);
    try {
      this.apply(this.session.start());
    } catch (error) {
      this.fail(`Transfer stopped: ${error.message}`, "transport-write-failed");
    }
    return true;
  }

  receive(bytes) {
    if (!this.active) return Buffer.from(bytes);
    const data = Buffer.from(bytes);
    if (!data.length) return data;

    if (this.session.state === "final-status") {
      this.statusBuffer = Buffer.concat([this.statusBuffer, data]);
      const parsed = parseControllerReplies(this.statusBuffer);
      this.statusBuffer = Buffer.from(parsed.rest);
      for (let index = 0; index < parsed.transferStatuses.length; index += 1)
        this.apply(this.session.step({ type: "status" }));
      const passthrough = Buffer.concat([
        ...parsed.visible,
        ...parsed.invalid,
      ]);
      if (passthrough.length) this.ordinaryData(passthrough);
      return Buffer.alloc(0);
    }

    this.replyBuffer = Buffer.concat([this.replyBuffer, data]);
    return Buffer.alloc(0);
  }

  tick() {
    if (!this.active) return;
    try {
      // processDownload state 1 replaces dlRsp before sending the second FC.
      // A response to startDownload's setup FC therefore cannot satisfy the
      // actual transfer handshake.
      if (this.session.state === "compile")
        this.replyBuffer = Buffer.alloc(0);
      const required = REPLY_LENGTH[this.session.state];
      let transition;
      if (required && this.replyBuffer.length >= required) {
        const reply = this.replyBuffer;
        this.replyBuffer = Buffer.alloc(0);
        transition = this.session.step({ type: "reply", bytes: reply });
      } else {
        transition = this.session.step({ type: "tick" });
      }
      this.apply(transition);
    } catch (error) {
      this.fail(`Transfer stopped: ${error.message}`, "invalid-controller-reply");
    }
  }

  /**
   * The original stream delegate preserves dlState across a TCP end/error and
   * reconnects the manual host after 1s + 2s. Only the state-8 reset wait is
   * enabled here: a disconnect in an earlier write phase is terminal because
   * its resume semantics have not been established by the oracle.
   */
  disconnected() {
    if (!this.active || !this.connected) return;
    this.connected = false;
    if (this.session.state !== "final-status") {
      this.session.step({ type: "disconnect" });
      this.fail(
        "Transfer stopped because the controller disconnected before the reset wait.",
        "unexpected-disconnect",
      );
      return;
    }
    this.progress({
      state: "reconnecting",
      message: "Scene Controller reset detected; reconnecting in 3 seconds",
    });
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
    if (!this.active || this.session.state !== "final-status") return false;
    this.connected = true;
    this.progress({
      state: "reset-wait",
      message: "Reconnected; waiting for normal Scene Controller status",
    });
    return true;
  }

  reconnectFailed() {
    if (!this.active || this.connected) return;
    this.progress({
      state: "reconnecting",
      message: "Scene Controller has not returned; retrying the iOS reconnect cycle",
    });
    this.scheduleReconnect();
  }

  cancel(reason = "operator") {
    if (!this.active) return false;
    const transition = this.session.cancel(reason);
    this.messages.push(...transition.messages);
    this.fail(`Transfer cancelled: ${reason}`, "cancelled");
    return true;
  }

  apply(transition) {
    this.messages.push(...transition.messages);
    for (const message of transition.messages) {
      this.progress({
        state: transition.after.state,
        blockNumber:
          transition.after.state === "block-ack"
            ? transition.after.blockIndex + 1
            : undefined,
        retry: transition.after.retry,
        message,
      });
    }
    for (const frame of transition.frames) {
      if (!this.connected) {
        this.fail(
          `Transfer stopped before ${frame.name} because the controller is disconnected.`,
          "write-while-disconnected",
        );
        return;
      }
      this.write(frame.bytes, frame);
      this.frames.push(frame);
    }
    if (transition.after.state === "completed") {
      this.finish("completed");
    } else if (TERMINAL_SESSION_STATES.has(transition.after.state)) {
      this.finish(transition.after.state);
    }
  }

  fail(message, outcome) {
    if (this.finished) return;
    this.progress({ state: "failed", message });
    this.close();
    this.finish(outcome, message);
  }

  finish(outcome, message) {
    if (this.finished) return;
    this.finished = true;
    this.phase = "done";
    if (this.timer) this.clearIntervalFn(this.timer);
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    this.timer = undefined;
    this.reconnectTimer = undefined;
    this.result(Object.freeze({
      outcome,
      message,
      session: this.session.snapshot(),
      frameCount: this.frames.length,
      messages: Object.freeze([...this.messages]),
    }));
  }
}

export const TRANSFER_RUNNER_TIMING = Object.freeze({
  tickMs: TICK_MS,
  reconnectDelayMs: RECONNECT_DELAY_MS,
});
