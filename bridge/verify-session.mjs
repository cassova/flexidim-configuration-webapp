import { verifyMessage } from "./protocol.mjs";

const TICK_MS = 100;
const HANDSHAKE_TICKS = 31;
const HANDSHAKE_ATTEMPTS = 6;
const RESULT_TICKS = 101;
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function validKnownRecord(buffer, offset) {
  const kind = buffer[offset];
  const length = kind === 0xf2 ? 4 : kind === 0xf4 || kind === 0xf5 ? 5 : 0;
  if (!length || offset + length > buffer.length) return 0;
  const record = buffer.subarray(offset, offset + length);
  const expected = record
    .subarray(0, -1)
    .reduce((sum, byte) => (sum + byte) & 0x7f, 0);
  return record.at(-1) === expected ? length : 0;
}

export function parseVerifyReply(bytes) {
  if (bytes.length < 10) return null;
  const reply = Buffer.from(bytes.subarray(0, 10));
  const dayIndex = Math.log2(reply[6]);
  const day =
    Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex < DAY_NAMES.length
      ? DAY_NAMES[dayIndex]
      : "Unknown day";
  return {
    verified: reply[0] === 0x06,
    // Stored low byte first; the iOS format call displays byte 2 then byte 1.
    controllerChecksum: `${reply[2].toString(16).padStart(2, "0")}${reply[1]
      .toString(16)
      .padStart(2, "0")}`,
    day,
    // The reply stores seconds, minutes, hours; the iOS format call passes them
    // in reverse order to render HH:MM:SS.
    time: [reply[5], reply[4], reply[3]]
      .map((value) => String(value).padStart(2, "0"))
      .join(":"),
    version: `${reply[8]}.${reply[9]}`,
    bytes: reply,
  };
}

/**
 * The read-only four-state `processVerify:` exchange from the iOS app.
 *
 * `ff fc` asks the controller to enter verification mode. A 0x06 acknowledgement
 * advances to `ff f5`, whose 10-byte reply carries the verdict, controller CRC,
 * day/time and firmware version. `ff fe` exits after a result; `ff f8` aborts a
 * handshake that never acknowledged.
 */
export class VerifySession {
  constructor({
    send,
    result,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.send = send;
    this.result = result;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.phase = "idle";
    this.buffer = Buffer.alloc(0);
    this.passthrough = [];
    this.ticks = 0;
    this.attempts = 0;
    this.localChecksum = "";
  }

  get active() {
    return this.phase !== "idle" && this.phase !== "done";
  }

  start(localChecksum) {
    if (this.active) return false;
    this.localChecksum = String(localChecksum || "").toLowerCase();
    this.phase = "handshake";
    this.buffer = Buffer.alloc(0);
    this.passthrough = [];
    this.ticks = 0;
    this.attempts = 1;
    this.send(verifyMessage("fc"), "Start controller comparison");
    this.timer = this.setIntervalFn(() => this.tick(), TICK_MS);
    return true;
  }

  /**
   * Keep the controller's normal f2/f4/f5 records available to the ordinary
   * parser while retaining only the raw verification reply.
   */
  receive(data) {
    if (!this.active) return Buffer.from(data);
    this.buffer = Buffer.concat([this.buffer, data]);
    let offset = 0;
    while (offset < this.buffer.length) {
      const length = validKnownRecord(this.buffer, offset);
      if (!length) break;
      this.passthrough.push(this.buffer.subarray(offset, offset + length));
      offset += length;
    }
    if (offset) this.buffer = this.buffer.subarray(offset);
    const passthrough = Buffer.concat(this.passthrough);
    this.passthrough = [];
    return passthrough;
  }

  tick() {
    if (this.phase === "handshake") {
      if (this.buffer.length) {
        const acknowledged = this.buffer[0] === 0x06;
        this.buffer = Buffer.alloc(0);
        if (acknowledged) {
          this.phase = "sendVerify";
          this.ticks = 0;
          return;
        }
      }
      this.ticks += 1;
      if (this.ticks < HANDSHAKE_TICKS) return;
      if (this.attempts < HANDSHAKE_ATTEMPTS) {
        this.attempts += 1;
        this.ticks = 0;
        this.send(verifyMessage("fc"), "Retry controller comparison");
        return;
      }
      this.send(verifyMessage("f8"), "Abort controller comparison");
      this.finish({
        type: "verifyResult",
        state: "error",
        message: "The Scene Controller did not acknowledge the comparison request.",
      });
      return;
    }

    if (this.phase === "sendVerify") {
      this.phase = "result";
      this.ticks = 0;
      this.buffer = Buffer.alloc(0);
      this.send(verifyMessage("f5"), "Read controller comparison");
      return;
    }

    if (this.phase !== "result") return;
    if (this.buffer.length >= 10) {
      const parsed = parseVerifyReply(this.buffer);
      const rest = this.buffer.subarray(10);
      this.buffer = Buffer.alloc(0);
      if (rest.length) this.passthrough.push(rest);
      this.send(verifyMessage("fe"), "Finish controller comparison");
      this.finish({
        type: "verifyResult",
        state: parsed.verified ? "match" : "different",
        localChecksum: this.localChecksum,
        controllerChecksum: parsed.controllerChecksum,
        version: parsed.version,
        verifiedAt: `${parsed.day} ${parsed.time}`,
        message: parsed.verified
          ? `Current local configuration CRC: ${this.localChecksum}. Verified OK ${parsed.day} ${parsed.time}. Controller CRC: ${parsed.controllerChecksum}; Version = ${parsed.version}.`
          : `Current local configuration CRC: ${this.localChecksum}. Failed to verify. Controller CRC: ${parsed.controllerChecksum}; Version = ${parsed.version}.`,
      });
      return;
    }
    this.ticks += 1;
    if (this.ticks < RESULT_TICKS) return;
    this.send(verifyMessage("fe"), "Finish timed-out controller comparison");
    this.finish({
      type: "verifyResult",
      state: "error",
      message: "The Scene Controller did not return a comparison result.",
    });
  }

  finish(value) {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    this.phase = "done";
    this.result(value);
  }

  cancel() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    this.phase = "done";
  }
}

export const VERIFY_TIMING = Object.freeze({
  tickMs: TICK_MS,
  handshakeTicks: HANDSHAKE_TICKS,
  handshakeAttempts: HANDSHAKE_ATTEMPTS,
  resultTicks: RESULT_TICKS,
});
