import { crc16X25 } from "../../bridge/protocol.mjs";

function unescapeFrame(bytes) {
  const input = Buffer.from(bytes);
  if (!input.length) throw new Error("empty transfer frame");
  const output = [input[0]];
  for (let index = 1; index < input.length; index += 1) {
    if (input[index] === 0x1b) {
      index += 1;
      if (index >= input.length) throw new Error("dangling escape byte");
    }
    output.push(input[index]);
  }
  return Buffer.from(output);
}

function describeFrame(bytes) {
  const frame = unescapeFrame(bytes);
  if (frame.length < 3) throw new Error("transfer frame is too short");
  const body = frame.subarray(0, -2);
  if (frame.readUInt16LE(frame.length - 2) !== crc16X25(body))
    throw new Error("transfer frame CRC is invalid");
  if (body[0] === 0xfe) {
    if (body.length !== 259) throw new Error("configuration block has the wrong length");
    return { family: "configuration-block", blockIndex: body.readUInt16LE(1) };
  }
  if (body[0] === 0xff && body[1] === 0xf2) {
    if (body.length !== 261) throw new Error("user-data frame has the wrong length");
    return {
      family: "ff-f2",
      userIndex: body[2],
      marker: body[3] | (body[4] << 7),
    };
  }
  if (body[0] !== 0xff || body.length !== 6)
    throw new Error("unsupported transfer frame family");
  return { family: `ff-${body[1].toString(16).padStart(2, "0")}` };
}

/**
 * Controller-side emulator for the complete oracle-proven type-0 transcript.
 *
 * It consumes a captured synthetic iOS transcript, requires the exact next
 * frame, returns the scripted replies that made the original iOS sender
 * complete offline, and exposes ten final validated status events. These replies are
 * oracle inputs, not a claim that production firmware has been captured.
 */
class TransferPrefixEmulator {
  constructor({ expectedFrames, nakByBlock = new Map(), timeoutByBlock = new Map() }) {
    if (!Array.isArray(expectedFrames) || !expectedFrames.length)
      throw new TypeError("expectedFrames must be a non-empty oracle transcript");
    this.expectedFrames = expectedFrames.map((bytes) => Buffer.from(bytes));
    this.descriptions = this.expectedFrames.map(describeFrame);
    this.nakByBlock = new Map(nakByBlock);
    this.timeoutByBlock = new Map(timeoutByBlock);
    this.cursor = 0;
    this.fcCount = 0;
    this.currentBlock = undefined;
    this.failed = false;
    this.resetRequested = false;
    this.userDataComplete = false;
    this.statusCount = 0;
    this.consecutiveNaks = 0;
    this.abortExpected = false;
  }

  receive(bytes) {
    if (this.failed) throw new Error("emulator rejected an earlier frame");
    if (this.cursor >= this.expectedFrames.length)
      throw new Error("transfer prefix is already complete");
    const actual = Buffer.from(bytes);
    if (this.abortExpected && describeFrame(actual).family === "ff-f8") {
      this.abortExpected = false;
      return null;
    }
    const expected = this.expectedFrames[this.cursor];
    if (!actual.equals(expected)) {
      this.failed = true;
      throw new Error(`unexpected transfer frame at transcript index ${this.cursor}`);
    }

    const description = this.descriptions[this.cursor];
    this.cursor += 1;
    if (description.family === "configuration-block") {
      this.currentBlock = description.blockIndex;
      return null;
    }
    if (description.family === "ff-fc") {
      this.fcCount += 1;
      return this.fcCount === 2 ? Buffer.from([0x06]) : null;
    }
    if (description.family === "ff-f7") {
      if (this.currentBlock === undefined)
        throw new Error("block poll arrived before a configuration block");
      if (this.consumeFault(this.timeoutByBlock, this.currentBlock)) {
        this.cursor -= 2;
        return null;
      }
      if (this.consumeFault(this.nakByBlock, this.currentBlock)) {
        this.consecutiveNaks += 1;
        if (this.consecutiveNaks >= 6) this.abortExpected = true;
        this.cursor -= 2;
        return Buffer.from([0x15]);
      }
      this.consecutiveNaks = 0;
      return Buffer.from([0x06]);
    }
    if (description.family === "ff-fa") {
      this.resetRequested = true;
      return Buffer.from([0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    if (description.family === "ff-f9") {
      return Buffer.from([0x06, 0]);
    }
    if (
      description.family === "ff-f2" &&
      description.userIndex === 0xe0 &&
      description.marker === 0x3fff
    ) {
      this.userDataComplete = true;
    }
    return null;
  }

  status() {
    if (this.failed) throw new Error("emulator rejected an earlier frame");
    if (!this.userDataComplete || this.cursor !== this.expectedFrames.length)
      throw new Error("final status arrived before the transfer transcript completed");
    if (this.statusCount >= 10)
      throw new Error("the oracle transcript contains exactly ten final status messages");
    this.statusCount += 1;
    return Object.freeze({ type: "status" });
  }

  consumeFault(faults, blockIndex) {
    const remaining = Number(faults.get(blockIndex) ?? 0);
    if (remaining <= 0) return false;
    faults.set(blockIndex, remaining - 1);
    return true;
  }

  get complete() {
    return (
      this.cursor === this.expectedFrames.length &&
      this.resetRequested &&
      this.userDataComplete &&
      this.statusCount === 10
    );
  }
}

export { unescapeFrame, describeFrame, TransferPrefixEmulator };
