import { crc16X25 } from "./protocol.mjs";

const ACK = 0x06;
const NAK = 0x15;
const BLOCK_BYTES = 256;
const CONNECTION_TIMEOUT_TICKS = 32;
const SETTLE_TICKS = 21;
const BLOCK_TIMEOUT_TICKS = 101;
const POST_IMAGE_TIMEOUT_TICKS = 151;
const FINAL_STATUS_TIMEOUT_TICKS = 1201;
const FINAL_STATUS_COUNT = 10;
const MAX_CONNECTION_RETRIES = 5;
const MAX_BLOCK_RETRIES = 5;

const IOS_TRANSFER_MESSAGES = Object.freeze({
  compiling: "Compiling current local configuration",
  connecting: "Connecting to Scene Controller",
  connectionRetry: (retry) =>
    `Retrying connection to Scene Controller : ${retry} / ${MAX_CONNECTION_RETRIES}`,
  connectionFailed: "Failed to connect to Scene Controller - resetting",
  block: (blockNumber) => `Downloading block ${blockNumber}`,
  blockRetry: (blockNumber, retry) =>
    `Retrying block ${blockNumber} (${retry})`,
  downloadFailed: "Failed to download to Scene Controller - resetting",
  verifying: "Verifying Scene Controller",
  verificationFailed: "Failed to verify - resetting ",
  makingPermanent: "Making permanent - this takes up to 60 seconds",
  permanenceFailed: "Failed to make permanent",
  resetting: "Download complete - resetting Scene Controller",
  resetDuration: "This takes about 60 seconds",
  resetNotDetected: "Scene controller reset not detected",
  resetAdvisory:
    "The Scene Controller will reset automatically in a few minutes, if it is not already working normally.",
  completed: "Download completed successfully",
  runningNormally: "Scene controller running normally",
});

function lifecycleMessages(before, after) {
  if (before.state === "created" && after.state === "compile")
    return [IOS_TRANSFER_MESSAGES.compiling];
  if (before.state === "compile" && after.state === "handshake")
    return [IOS_TRANSFER_MESSAGES.connecting];
  if (
    before.state === "handshake" &&
    after.state === "handshake" &&
    after.retry > before.retry
  )
    return [IOS_TRANSFER_MESSAGES.connectionRetry(after.retry)];
  if (after.state === "connection-timeout")
    return [IOS_TRANSFER_MESSAGES.connectionFailed];
  if (
    ["settle", "block-gap"].includes(before.state) &&
    after.state === "block-ack"
  )
    return [IOS_TRANSFER_MESSAGES.block(after.blockIndex + 1)];
  if (
    before.state === "block-ack" &&
    after.state === "block-ack" &&
    after.retry > before.retry
  )
    return [
      IOS_TRANSFER_MESSAGES.blockRetry(after.blockIndex + 1, after.retry),
    ];
  if (after.state === "aborted")
    return [IOS_TRANSFER_MESSAGES.downloadFailed];
  if (before.state === "block-ack" && after.state === "post-image")
    return [IOS_TRANSFER_MESSAGES.verifying];
  if (
    before.state === "post-image-status" &&
    after.state === "f9-ack"
  )
    return [IOS_TRANSFER_MESSAGES.makingPermanent];
  if (
    before.state === "post-image-status" &&
    ["failed", "post-image-timeout"].includes(after.state)
  )
    return [IOS_TRANSFER_MESSAGES.verificationFailed];
  if (before.state === "f9-ack" && after.state === "user-transfer")
    return [
      IOS_TRANSFER_MESSAGES.resetting,
      IOS_TRANSFER_MESSAGES.resetDuration,
    ];
  if (
    before.state === "f9-ack" &&
    ["failed", "f9-timeout"].includes(after.state)
  )
    return [IOS_TRANSFER_MESSAGES.permanenceFailed];
  if (after.state === "final-status-timeout")
    return [
      IOS_TRANSFER_MESSAGES.resetNotDetected,
      IOS_TRANSFER_MESSAGES.resetAdvisory,
    ];
  if (after.state === "completed")
    return [
      IOS_TRANSFER_MESSAGES.completed,
      IOS_TRANSFER_MESSAGES.runningNormally,
    ];
  return [];
}

function appendCrc(body) {
  const unescaped = Buffer.from(body);
  const crc = crc16X25(unescaped);
  return Buffer.concat([unescaped, Buffer.from([crc & 0xff, crc >>> 8])]);
}

function escapeFrame(bytes) {
  const input = Buffer.from(bytes);
  if (input.length === 0) throw new Error("cannot escape an empty frame");
  const output = [input[0]];
  for (const byte of input.subarray(1)) {
    if (byte === 0x1b || byte >= 0xfd) output.push(0x1b);
    output.push(byte);
  }
  return Buffer.from(output);
}

function frame(name, body, extra = {}) {
  const unescapedBody = Buffer.from(body);
  const withCrc = appendCrc(unescapedBody);
  return Object.freeze({
    name,
    family: unescapedBody[0] === 0xfe ? "configuration-block" : `ff-${unescapedBody[1].toString(16).padStart(2, "0")}`,
    body: unescapedBody,
    crc: withCrc.readUInt16LE(withCrc.length - 2),
    bytes: escapeFrame(withCrc),
    ...extra,
  });
}

function bcd(value, label, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new RangeError(`${label} must be an integer from 0 to ${maximum}`);
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
}

function validateClock(clock) {
  if (!clock || typeof clock !== "object")
    throw new TypeError("clock must provide fixed local date/time fields");
  const year = Number(clock.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2099)
    throw new RangeError("year must be an integer from 2000 to 2099");
  bcd(clock.month, "month", 12);
  if (clock.month < 1) throw new RangeError("month must be an integer from 1 to 12");
  bcd(clock.day, "day", 31);
  if (clock.day < 1) throw new RangeError("day must be an integer from 1 to 31");
  if (!Number.isInteger(clock.weekday) || clock.weekday < 0 || clock.weekday > 6)
    throw new RangeError("weekday must use 0=Sunday through 6=Saturday");
  bcd(clock.hour, "hour", 23);
  bcd(clock.minute, "minute", 59);
  bcd(clock.second, "second", 59);
  if (typeof clock.dst !== "boolean") throw new TypeError("dst must be boolean");
}

function setupFrames(clock) {
  validateClock(clock);
  // The original app uses bit 6—not the more usual high bit—as its DST flag.
  // For example, 15:xx during DST is sent as BCD 0x15 | 0x40 = 0x55.
  const encodedHour = bcd(clock.hour, "hour", 23) | (clock.dst ? 0x40 : 0);
  return [
    frame("set-time", [
      0xff, 0xf6, 0x00,
      bcd(clock.second, "second", 59),
      bcd(clock.minute, "minute", 59),
      encodedHour,
    ]),
    frame("set-date", [
      0xff, 0xf6,
      bcd(clock.year % 100, "year", 99),
      clock.weekday,
      bcd(clock.month, "month", 12),
      bcd(clock.day, "day", 31),
    ]),
    constantFrame("prepare-user-data", 0xfc),
  ];
}

function constantFrame(name, selector) {
  return frame(name, [0xff, selector, 0, 0, 0, 0]);
}

function firstPassLength(image) {
  const bytes = Buffer.from(image);
  if (bytes.length < 27) throw new RangeError("compiled image is too short to contain pointer 8");
  const length = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
  const inclusiveLength = length + 1;
  if (inclusiveLength < 1 || inclusiveLength > bytes.length)
    throw new RangeError("compiled image pointer 8 does not identify a valid first pass");
  return inclusiveLength;
}

function buildTransferPayload(image) {
  const compiledImage = Buffer.from(image);
  if (compiledImage.length === 0) throw new RangeError("compiled image cannot be empty");
  const firstLength = firstPassLength(compiledImage);
  const firstPassCrc = crc16X25(compiledImage.subarray(0, firstLength));
  const finalCrc = crc16X25(compiledImage);
  const meaningfulLength = compiledImage.length + 4;
  const paddedLength = Math.ceil(meaningfulLength / BLOCK_BYTES) * BLOCK_BYTES;
  const blockCount = paddedLength / BLOCK_BYTES;
  if (blockCount > 0x10000)
    throw new RangeError("transfer requires more blocks than the u16 wire index can represent");
  const payload = Buffer.alloc(paddedLength);
  compiledImage.copy(payload);
  payload.writeUInt16LE(firstPassCrc, compiledImage.length);
  payload.writeUInt16LE(finalCrc, compiledImage.length + 2);
  return Object.freeze({
    payload,
    imageLength: compiledImage.length,
    firstPassLength: firstLength,
    firstPassCrc,
    finalCrc,
    blockCount,
  });
}

function configurationBlock(payload, blockIndex) {
  const bytes = Buffer.from(payload);
  if (bytes.length === 0 || bytes.length % BLOCK_BYTES !== 0)
    throw new RangeError("transfer payload must contain whole 256-byte blocks");
  const blockCount = bytes.length / BLOCK_BYTES;
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blockCount)
    throw new RangeError(`block index must be an integer from 0 to ${blockCount - 1}`);
  if (blockIndex > 0xffff) throw new RangeError("block index does not fit the wire format");
  const start = blockIndex * BLOCK_BYTES;
  const body = Buffer.alloc(3 + BLOCK_BYTES);
  body[0] = 0xfe;
  body.writeUInt16LE(blockIndex, 1);
  bytes.copy(body, 3, start, start + BLOCK_BYTES);
  return frame("configuration-block", body, { blockIndex });
}

function userDataFrame(userIndex, marker, payload) {
  if (!Number.isInteger(userIndex) || userIndex < 0 || userIndex > 0xdf)
    throw new RangeError("user index must be an integer from 0 to 223");
  if (
    marker !== 0x3fff &&
    (!Number.isInteger(marker) || marker < 0 || marker > 0x3ffe)
  )
    throw new RangeError("user-data marker must fit the recovered 14-bit wire field");
  const bytes = Buffer.from(payload);
  if (bytes.length > BLOCK_BYTES)
    throw new RangeError("a user-data frame cannot contain more than 256 payload bytes");
  const body = Buffer.alloc(5 + BLOCK_BYTES);
  body[0] = 0xff;
  body[1] = 0xf2;
  body[2] = userIndex;
  body[3] = marker & 0x7f;
  body[4] = (marker >>> 7) & 0x7f;
  bytes.copy(body, 5);
  return frame("user-data", body, { userIndex, marker });
}

function userDataFrames(payload, userIndex) {
  const bytes =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (!bytes.length) return Object.freeze([]);
  const count = Math.ceil(bytes.length / BLOCK_BYTES);
  if (count > 0x3fff)
    throw new RangeError("user payload requires more chunks than the wire format can represent");
  return Object.freeze(
    Array.from({ length: count }, (_, chunkIndex) => {
      const final = chunkIndex + 1 === count;
      return userDataFrame(
        userIndex,
        final ? 0x3fff : chunkIndex,
        bytes.subarray(chunkIndex * BLOCK_BYTES, (chunkIndex + 1) * BLOCK_BYTES),
      );
    }),
  );
}

function allUsersTerminator() {
  const body = Buffer.alloc(5 + BLOCK_BYTES);
  body.set([0xff, 0xf2, 0xe0, 0x7f, 0x7f]);
  return frame("all-users-complete", body);
}

function normalizeBlockReply(bytes) {
  const reply = Buffer.from(bytes ?? []);
  if (reply.length !== 1 || (reply[0] !== ACK && reply[0] !== NAK))
    throw new Error("transfer reply must be exactly one byte: 06 (ACK) or 15 (NAK)");
  return reply[0];
}

function acceptsPostImageStatus(bytes) {
  const reply = Buffer.from(bytes ?? []);
  return reply.length >= 10 && reply[0] === ACK;
}

function acceptsF9Reply(bytes) {
  const reply = Buffer.from(bytes ?? []);
  return reply.length >= 2 && reply[0] === ACK && reply[1] === 0;
}

class ConfigurationTransferSession {
  constructor({
    image,
    clock,
    siteType = 0,
    firmwareProfile = "type-0-live-only",
    configurationMode = "full",
    modulePayloads = [],
    channelPayloads = [],
    userPayloads = [],
    profilePayloads = [],
  }) {
    if (siteType !== 0) throw new Error(`unsupported transfer site type: ${siteType}`);
    if (firmwareProfile !== "type-0-live-only")
      throw new Error(`unsupported transfer firmware profile: ${firmwareProfile}`);
    if (configurationMode !== "full")
      throw new Error(`unsupported transfer configuration mode: ${configurationMode}`);
    if (
      modulePayloads.length ||
      channelPayloads.length ||
      profilePayloads.length
    )
      throw new Error("module, channel and profile transfer ordering is not yet oracle-proven");
    if (!Array.isArray(userPayloads))
      throw new TypeError("userPayloads must be an array of UTF-8 strings or byte buffers");
    if (userPayloads.length > 0xe0)
      throw new RangeError("the type-0 user index field supports at most 224 users");
    this.transfer = buildTransferPayload(image);
    this.userPayloads = userPayloads.map((payload) =>
      typeof payload === "string" ? payload : Buffer.from(payload));
    this.clock = { ...clock };
    validateClock(this.clock);
    this.state = "created";
    this.blockIndex = 0;
    this.retry = 0;
    this.timeout = 0;
    this.settle = 0;
    this.userIndex = 0;
    this.finalStatusCount = 0;
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      blockIndex: this.blockIndex,
      retry: this.retry,
      timeout: this.timeout,
      settle: this.settle,
      userIndex: this.userIndex,
      finalStatusCount: this.finalStatusCount,
    });
  }

  start() {
    if (this.state !== "created") throw new Error("transfer session has already started");
    const before = this.snapshot();
    this.state = "compile";
    return this.result(before, setupFrames(this.clock));
  }

  step(event) {
    if (!event || !["tick", "reply", "status", "disconnect"].includes(event.type))
      throw new Error(`unknown transfer event: ${event?.type ?? "(missing)"}`);
    const before = this.snapshot();
    let frames = [];

    // A transport loss is terminal and deliberately emits no guessed recovery
    // frame. A future live runner must close its socket and require a fresh
    // comparison/preflight before it can acquire the transfer lock again.
    if (event.type === "disconnect") {
      this.state = "disconnected";
      return this.result(before, frames);
    }

    if (this.state === "compile") {
      this.requireEvent(event, "tick");
      frames = [constantFrame("prepare-user-data", 0xfc)];
      this.state = "handshake";
    } else if (this.state === "handshake") {
      if (event.type === "reply") {
        if (normalizeBlockReply(event.bytes) !== ACK)
          throw new Error("the oracle has not established handshake NAK behavior");
        this.state = "settle";
        this.timeout = 0;
        this.retry = 0;
      } else {
        this.requireEvent(event, "tick");
        this.timeout += 1;
        if (this.timeout === CONNECTION_TIMEOUT_TICKS) {
          this.timeout = 0;
          if (this.retry >= MAX_CONNECTION_RETRIES) {
            frames = [constantFrame("abort", 0xf8)];
            this.state = "connection-timeout";
          } else {
            this.retry += 1;
            frames = [constantFrame("prepare-user-data", 0xfc)];
          }
        }
      }
    } else if (this.state === "settle") {
      this.requireEvent(event, "tick");
      this.settle += 1;
      if (this.settle === SETTLE_TICKS) {
        frames = this.blockAttemptFrames();
        this.state = "block-ack";
      }
    } else if (this.state === "block-gap") {
      this.requireEvent(event, "tick");
      frames = this.blockAttemptFrames();
      this.state = "block-ack";
    } else if (this.state === "block-ack") {
      if (event.type === "reply") {
        const reply = normalizeBlockReply(event.bytes);
        if (reply === NAK) frames = this.retryOrAbort();
        else if (this.blockIndex + 1 === this.transfer.blockCount) {
          this.state = "post-image";
          this.timeout = 0;
          this.retry = 0;
        } else {
          this.blockIndex += 1;
          this.retry = 0;
          this.timeout = 0;
          this.state = "block-gap";
        }
      } else {
        this.requireEvent(event, "tick");
        this.timeout += 1;
        if (this.timeout === BLOCK_TIMEOUT_TICKS) frames = this.retryOrAbort();
      }
    } else if (this.state === "post-image") {
      this.requireEvent(event, "tick");
      frames = [constantFrame("commit-image", 0xfa)];
      this.state = "post-image-status";
      this.timeout = 0;
    } else if (this.state === "post-image-status") {
      if (event.type === "reply") {
        if (!acceptsPostImageStatus(event.bytes)) {
          frames = [constantFrame("abort", 0xf8)];
          this.state = "failed";
        } else {
          frames = [constantFrame("post-image-query", 0xf9)];
          this.state = "f9-ack";
          this.timeout = 0;
        }
      } else {
        this.requireEvent(event, "tick");
        this.timeout += 1;
        if (this.timeout === POST_IMAGE_TIMEOUT_TICKS) {
          frames = [constantFrame("abort", 0xf8)];
          this.state = "post-image-timeout";
        }
      }
    } else if (this.state === "f9-ack") {
      if (event.type === "reply") {
        if (!acceptsF9Reply(event.bytes)) {
          frames = [constantFrame("permanence-failed-reset", 0xfe)];
          this.state = "failed";
        } else {
          frames = [constantFrame("begin-user-data", 0xf8)];
          this.state = "user-transfer";
          // The original state carries one elapsed tick into state 7.
          this.timeout = 1;
        }
      } else {
        this.requireEvent(event, "tick");
        this.timeout += 1;
        if (this.timeout === FINAL_STATUS_TIMEOUT_TICKS) {
          frames = [constantFrame("permanence-failed-reset", 0xfe)];
          this.state = "f9-timeout";
        }
      }
    } else if (this.state === "user-transfer") {
      this.requireEvent(event, "tick");
      if (this.userIndex < this.userPayloads.length) {
        frames = [...userDataFrames(this.userPayloads[this.userIndex], this.userIndex)];
        this.userIndex += 1;
      } else {
        frames = [allUsersTerminator()];
        this.state = "final-status";
        this.timeout = 0;
        this.finalStatusCount = 0;
      }
    } else if (this.state === "final-status") {
      if (event.type === "status") {
        this.finalStatusCount += 1;
      } else {
        this.requireEvent(event, "tick");
        this.timeout += 1;
        if (this.finalStatusCount >= FINAL_STATUS_COUNT)
          this.state = "completed";
        else if (this.timeout === FINAL_STATUS_TIMEOUT_TICKS)
          this.state = "final-status-timeout";
      }
    } else {
      throw new Error(`transfer is terminal in state ${this.state}`);
    }
    return this.result(before, frames);
  }

  cancel(reason = "operator") {
    if ([
      "completed", "aborted", "failed", "post-image-timeout", "f9-timeout",
      "final-status-timeout", "connection-timeout", "disconnected", "cancelled",
    ].includes(this.state))
      throw new Error(`transfer is terminal in state ${this.state}`);
    const before = this.snapshot();
    this.state = "cancelled";
    this.cancelReason = String(reason);
    // No cancellation write is inferred here. The live runner, when one is
    // eventually qualified, must terminate the TCP connection fail-closed.
    return this.result(before, []);
  }

  requireEvent(event, type) {
    if (event.type !== type) throw new Error(`${this.state} requires a ${type} event`);
  }

  blockAttemptFrames() {
    this.timeout = 0;
    return [
      configurationBlock(this.transfer.payload, this.blockIndex),
      constantFrame("poll-block", 0xf7),
    ];
  }

  retryOrAbort() {
    this.timeout = 0;
    if (this.retry >= MAX_BLOCK_RETRIES) {
      this.state = "aborted";
      return [constantFrame("abort", 0xf8)];
    }
    this.retry += 1;
    return this.blockAttemptFrames();
  }

  result(before, frames) {
    const after = this.snapshot();
    return Object.freeze({
      before,
      frames: Object.freeze(frames),
      messages: Object.freeze(lifecycleMessages(before, after)),
      after,
    });
  }
}

function compileTransferTranscript(options, events = []) {
  const session = new ConfigurationTransferSession(options);
  const transitions = [session.start()];
  for (const event of events) transitions.push(session.step(event));
  return Object.freeze({
    transfer: session.transfer,
    transitions: Object.freeze(transitions),
    final: session.snapshot(),
  });
}

export {
  ACK,
  NAK,
  BLOCK_BYTES,
  CONNECTION_TIMEOUT_TICKS,
  SETTLE_TICKS,
  BLOCK_TIMEOUT_TICKS,
  POST_IMAGE_TIMEOUT_TICKS,
  FINAL_STATUS_TIMEOUT_TICKS,
  FINAL_STATUS_COUNT,
  MAX_CONNECTION_RETRIES,
  MAX_BLOCK_RETRIES,
  IOS_TRANSFER_MESSAGES,
  lifecycleMessages,
  appendCrc,
  escapeFrame,
  frame,
  setupFrames,
  firstPassLength,
  buildTransferPayload,
  configurationBlock,
  userDataFrame,
  userDataFrames,
  allUsersTerminator,
  ConfigurationTransferSession,
  compileTransferTranscript,
};
