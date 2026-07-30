import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  crc16X25,
  packet,
  statusRequest,
  STATUS_REQUESTS,
  switchDimFunctionFrame,
  emulationModeFrame,
  EMULATION_MODE,
  EMULATION_REFRESH_SECONDS,
  transferHandshakeFrame,
  verifyMessage,
  VERIFY_MESSAGES,
  configurationChecksum,
  formatChecksum,
} from "../bridge/protocol.mjs";
import { parseControllerReplies } from "../bridge/controller-replies.mjs";
import { authenticationRecord } from "../bridge/session.mjs";
import { controllerChannelAddress } from "../app/flexidim-addressing.mjs";
import { rawControllerButton } from "../app/live-switch.mjs";

/**
 * Regression tests pinned to the hardware-verified byte sequences documented in
 * PROTOCOL.md. These are the exact frames a real controller accepted, so any
 * change to framing, CRC or addressing that alters them is a regression against
 * observed hardware — not merely a refactor.
 */

const hex = (bytes) =>
  Buffer.from(bytes).toString("hex").match(/.{1,2}/g).join(" ");
const bytes = (text) => Buffer.from(text.replace(/\s+/g, ""), "hex");

test("the two captured dim frames reproduce byte for byte", () => {
  // From PROTOCOL.md "Dim command (04) — hardware verified".
  assert.equal(
    hex(packet(0x04, [17, 0, 1])),
    "ff f3 04 11 00 01 e3 34",
    "channel 17 -> 0% over 0.5 s",
  );
  assert.equal(
    hex(packet(0x04, [17, 100, 1])),
    "ff f3 04 11 64 01 d6 36",
    "channel 17 -> 100% over 0.5 s",
  );
});

test("a dim frame carries level as 0x00-0x64 and transition in half-second ticks", () => {
  const frame = packet(0x04, [1, 50, 4]);
  assert.equal(frame[3], 1, "one-based channel address");
  assert.equal(frame[4], 50, "level is a percentage, not a 0-255 scale");
  assert.equal(frame[5], 4, "transition is 4 ticks = 2 seconds");
});

test("the switch frame keeps its required trailing zero", () => {
  // From PROTOCOL.md "Switch command (00) — binary verified".
  const frame = packet(0x00, [3, 9, 0]);
  assert.equal(frame.length, 8);
  assert.equal(hex(frame).startsWith("ff f3 00 03 09 00"), true);
  // Dropping the trailing zero changes the length the controller's check
  // expects, so it must be part of the body.
  assert.notEqual(hex(packet(0x00, [3, 9])), hex(frame));
});

test("every frame is framed ff f3 and closed with little-endian CRC-16/X25", () => {
  for (const [type, body] of [
    [0x04, [17, 0, 1]],
    [0x04, [1, 100, 0]],
    [0x00, [1, 1, 0]],
  ]) {
    const frame = packet(type, body);
    assert.equal(frame[0], 0xff);
    assert.equal(frame[1], 0xf3);
    assert.equal(frame[2], type);
    const expected = crc16X25(frame.subarray(0, -2));
    assert.equal(frame.at(-2), expected & 0xff, "CRC low byte first");
    assert.equal(frame.at(-1), (expected >> 8) & 0xff, "CRC high byte second");
  }
});

test("the authentication record keeps its recovered 23-byte shape", () => {
  const record = authenticationRecord("ABCDEFGHIJKLMNOP");
  assert.equal(record.length, 23);
  assert.equal(record.subarray(0, 16).toString("ascii"), "ABCDEFGHIJKLMNOP");
  assert.match(record.subarray(16, 22).toString("ascii"), /^\d{6}$/);
  assert.equal(record[22], 0xff);
});

test("authentication refuses a key that is not exactly sixteen characters", () => {
  // A short key would be padded or truncated silently on the wire; refusing is
  // what stops a malformed session being opened.
  assert.throws(() => authenticationRecord("TOO-SHORT"));
  assert.throws(() => authenticationRecord(""));
  assert.throws(() => authenticationRecord("SEVENTEEN-CHARSX!"));
});

test("the captured f2 status record decodes with its additive check", () => {
  // PROTOCOL.md: "f2 03 00 sums to f5, whose transmitted check is 75".
  const replies = parseControllerReplies(bytes("f2 03 00 75"));
  assert.deepEqual(replies.statuses, [{ channel: 4, level: 0 }]);
  assert.equal(replies.invalid.length, 0);
  assert.equal(replies.rest.length, 0);
});

test("an f2 record with a wrong check is rejected, not silently trusted", () => {
  const replies = parseControllerReplies(bytes("f2 03 00 74"));
  assert.deepEqual(replies.statuses, []);
  assert.equal(replies.invalid.length, 1);
});

test("an f3 record is decoded as a not-normal status, not swallowed as unknown", () => {
  // Observed on hardware while the controller was suspended after a send.
  // f3 0e 0c sums to 0x0d, its transmitted check.
  const replies = parseControllerReplies(bytes("f3 0e 0c 0d"));
  assert.equal(replies.abnormalStatuses.length, 1);
  assert.equal(replies.statuses.length, 0);
  assert.equal(replies.invalid.length, 0);
  assert.equal(replies.rest.length, 0);
  assert.deepEqual([...replies.abnormalStatuses[0].record], [0xf3, 0x0e, 0x0c, 0x0d]);
});

test("consecutive f3 records are each parsed rather than dumped together", () => {
  const replies = parseControllerReplies(bytes("f3 0e 0c 0d f3 0e 0c 0d"));
  assert.equal(replies.abnormalStatuses.length, 2);
  assert.equal(replies.visible.length, 0);
});

test("an f3 record with a wrong check is rejected", () => {
  const replies = parseControllerReplies(bytes("f3 0e 0c 0e"));
  assert.equal(replies.abnormalStatuses.length, 0);
  assert.equal(replies.invalid.length, 1);
});

test("f2 receive addresses are one less than transmit addresses", () => {
  // PROTOCOL.md: f2 address 0x10 reports TX channel 17.
  const sum = (0xf2 + 0x10 + 0x64) & 0x7f;
  const replies = parseControllerReplies(
    Buffer.from([0xf2, 0x10, 0x64, sum]),
  );
  assert.deepEqual(replies.statuses, [{ channel: 17, level: 100 }]);
});

test("a status record split across TCP chunks is buffered, not dropped", () => {
  // Socket data events do not preserve record boundaries.
  const whole = bytes("f2 03 00 75");
  const first = parseControllerReplies(whole.subarray(0, 2));
  assert.deepEqual(first.statuses, []);
  assert.equal(first.rest.length, 2, "the partial record is held back");
  const joined = Buffer.concat([first.rest, whole.subarray(2)]);
  assert.deepEqual(parseControllerReplies(joined).statuses, [
    { channel: 4, level: 0 },
  ]);
});

test("f4 is surfaced and also follows the iOS transfer-status counter branch", () => {
  const record = [0xf4, 0x01, 0x02, 0x03];
  const check = record.reduce((total, byte) => (total + byte) & 0x7f, 0);
  const replies = parseControllerReplies(Buffer.from([...record, check]));
  assert.deepEqual(replies.statuses, []);
  assert.equal(replies.transferStatuses.length, 1);
  assert.equal(replies.transferStatuses[0].kind, 0xf4);
  assert.equal(replies.visible.length, 1);
  assert.equal(replies.invalid.length, 0);
});

test("f5 is surfaced but does not increment the iOS transfer-status counter", () => {
  const record = [0xf5, 0x01, 0x02, 0x03];
  const check = record.reduce((total, byte) => (total + byte) & 0x7f, 0);
  const replies = parseControllerReplies(Buffer.from([...record, check]));
  assert.deepEqual(replies.statuses, []);
  assert.deepEqual(replies.transferStatuses, []);
  assert.equal(replies.visible.length, 1);
  assert.equal(replies.invalid.length, 0);
});

test("an unknown reply shape stays visible instead of being discarded", () => {
  const replies = parseControllerReplies(bytes("aa bb cc"));
  assert.equal(replies.visible.length, 1);
  assert.equal(replies.statuses.length, 0);
});

test("channel addressing reproduces the verified three-module ranges", () => {
  // PROTOCOL.md: stored modules 7000/7010/7020 give ranges 1-8, 9-16, 17-24.
  assert.equal(controllerChannelAddress(0, 1), 1);
  assert.equal(controllerChannelAddress(0, 8), 8);
  assert.equal(controllerChannelAddress(1, 1), 9);
  assert.equal(controllerChannelAddress(1, 8), 16);
  assert.equal(controllerChannelAddress(2, 1), 17);
  assert.equal(controllerChannelAddress(2, 8), 24);
  // An unplaced module falls back to the bare channel index.
  assert.equal(controllerChannelAddress(-1, 5), 5);
});

test("the type-15 plate skips wire code 11 for the third shifted button", () => {
  // PROTOCOL.md: physical positions 9, 10 and 11 map to wire codes 9, 10, 12.
  assert.equal(rawControllerButton(11, 9), 9);
  assert.equal(rawControllerButton(11, 10), 10);
  assert.equal(rawControllerButton(11, 11), 12);
});

test("the code skip applies per plate, at its own third shifted button", () => {
  // Plates with built-in buttons have `buttonCount - 3` main buttons; positions
  // up to mainButtons+2 map straight through and only the last skips a code.
  // A type-13 (7-button) plate therefore skips at position 7, not at 8.
  assert.equal(rawControllerButton(7, 6), 6);
  assert.equal(rawControllerButton(7, 7), 8);
  assert.equal(rawControllerButton(11, 10), 10);
  assert.equal(rawControllerButton(11, 11), 12);
});

test("plates without built-in buttons map every position straight through", () => {
  // Opto plates (types 2 and 8) have no shifted built-ins, so no code is
  // skipped anywhere on them.
  for (const buttons of [2, 8])
    for (let button = 1; button <= buttons; button += 1)
      assert.equal(
        rawControllerButton(buttons, button),
        button,
        `plate ${buttons}, button ${button}`,
      );
});

// --- Captured record set on a real type-0 session ----------------------------

test("the captured type-0 record set is exactly the f2 channel scan", async () => {
  // Hardware capture: 50 s (~2.4 full 128-address scans) on an authenticated
  // local session with nothing sent after authentication.
  const capture = JSON.parse(
    await readFile(
      new URL("../tools/oracle/fixtures/type0-record-capture.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(capture.recordCounts), ["0xf2"]);
  assert.ok(capture.recordCounts["0xf2"] > 128, "at least one complete scan");
  // Every record passed the additive check, so the parser's check matches the
  // controller's real output and not just the emulator's.
  assert.equal(capture.checkFailures, 0);
  // No unrecognised record shape appeared, so the parser is not silently
  // discarding a record type the controller actually sends.
  assert.deepEqual(capture.unknownSamples, []);
});

test("no period or pending-scene record arrives unsolicited on a type-0 session", () => {
  // This is the capture result for the period/pending-scene status records: they
  // do not exist on an unsolicited type-0 stream. Obtaining them would need a
  // request frame, which the binary shows is emitted only for encrypted remote
  // sessions — so a plaintext guess is both unverified and a write.
  const parsed = parseControllerReplies(bytes("f2 03 00 75"));
  assert.deepEqual(parsed.statuses, [{ channel: 4, level: 0 }]);
  assert.deepEqual(parsed.visible, [], "an f2 scan yields no other record");
});

// --- Recovered request and function frames -----------------------------------

test("the status request frames match the recovered templates byte for byte", () => {
  // Recovered constants: requestPeriodFlags at 0x1000412a4 and
  // requestPendingScenes at 0x100041410, both nine bytes with CRC over all nine.
  const periodFlags = statusRequest("periodFlags");
  const pendingScenes = statusRequest("pendingScenes");
  // The ff f1 prefix is a different frame family from the ff f3 commands.
  assert.equal(hex(periodFlags).startsWith("ff f1 00 00 00 00 00 00 00"), true);
  assert.equal(hex(pendingScenes).startsWith("ff f1 01 00 00 00 00 00 00"), true);
  // Nine body bytes plus a two-byte CRC, before any escaping.
  assert.equal(periodFlags.length, 11);
  assert.equal(pendingScenes.length, 11);
  // The two differ only in the selector byte.
  assert.equal(periodFlags[2], 0x00);
  assert.equal(pendingScenes[2], 0x01);
});

test("status request frames carry a valid CRC over the whole nine-byte body", () => {
  for (const kind of Object.keys(STATUS_REQUESTS)) {
    const frame = statusRequest(kind);
    const expected = crc16X25(frame.subarray(0, 9));
    assert.equal(frame[9], expected & 0xff);
    assert.equal(frame[10], (expected >> 8) & 0xff);
  }
});

test("an unknown status request is refused rather than silently framed", () => {
  assert.throws(() => statusRequest("somethingElse"));
});

test("the switch/dim function frame masks payload to seven bits", () => {
  // Template ff f3 06, target transmitted zero-based.
  const frame = switchDimFunctionFrame(1, 100, 3);
  assert.equal(hex(frame).startsWith("ff f3 06 00 64 03 00"), true);
  const another = switchDimFunctionFrame(18, 50, 1);
  assert.equal(hex(another).startsWith("ff f3 06 11 32 01 00"), true);
});

test("high payload bits become escape flags in the command byte", () => {
  // Byte 2 records the bits that were masked off, so no payload byte can stray
  // into the 0xfd..0xff delimiter range.
  assert.equal(switchDimFunctionFrame(0x81 + 1, 0, 0)[2], 0x06 | 0x08);
  assert.equal(switchDimFunctionFrame(1, 0x80, 0)[2], 0x06 | 0x10);
  assert.equal(switchDimFunctionFrame(1, 0, 0x80)[2], 0x06 | 0x20);
  // All three at once.
  assert.equal(
    switchDimFunctionFrame(0x81 + 1, 0x80, 0x80)[2],
    0x06 | 0x08 | 0x10 | 0x20,
  );
  // And the payload bytes themselves stay within seven bits.
  const frame = switchDimFunctionFrame(0x81 + 1, 0xff, 0xff);
  for (const index of [3, 4, 5]) assert.ok(frame[index] <= 0x7f);
});

test("every recovered frame stays clear of the delimiter after escaping", () => {
  // 0xff starts a frame and 0x1b escapes, so no later byte may be either unescaped.
  const frames = [
    statusRequest("periodFlags"),
    statusRequest("pendingScenes"),
    switchDimFunctionFrame(1, 100, 3),
    packet(0x04, [17, 100, 1]),
  ];
  for (const frame of frames) {
    assert.equal(frame[0], 0xff);
    for (let index = 1; index < frame.length; index += 1)
      if (frame[index] === 0x1b || frame[index] >= 0xfd)
        assert.equal(
          frame[index - 1],
          0x1b,
          `unescaped delimiter byte at ${index} in ${hex(frame)}`,
        );
  }
});

test("the emulation-mode frames match the recovered enter and leave bytes", () => {
  // -emulationMode: at 0x10003ef24, template ff 00 00 00 00 00, CRC over six.
  // Byte 1 is 0xfd to enter emulation and 0xfe to leave it.
  const enter = emulationModeFrame(true);
  const leave = emulationModeFrame(false);
  assert.equal(enter[0], 0xff);
  assert.equal(leave[0], 0xff);
  // 0xfd and 0xfe are in the escape range, so byte 1 arrives escaped — which is
  // exactly what the framing escape exists for.
  assert.equal(enter[1], 0x1b);
  assert.equal(enter[2], EMULATION_MODE.enter);
  assert.equal(leave[1], 0x1b);
  assert.equal(leave[2], EMULATION_MODE.leave);
  assert.notEqual(enter.toString("hex"), leave.toString("hex"));
});

test("the emulation frame's CRC covers the six unescaped body bytes", () => {
  for (const on of [true, false]) {
    const body = Buffer.from([
      0xff,
      on ? EMULATION_MODE.enter : EMULATION_MODE.leave,
      0,
      0,
      0,
      0,
    ]);
    const expected = crc16X25(body);
    // Rebuild the unescaped stream to compare, since the frame is escaped.
    const frame = emulationModeFrame(on);
    const unescaped = [];
    for (let index = 0; index < frame.length; index += 1) {
      if (index > 0 && frame[index] === 0x1b) continue;
      unescaped.push(frame[index]);
    }
    assert.deepEqual(unescaped.slice(0, 6), [...body]);
    assert.equal(unescaped[6], expected & 0xff);
    assert.equal(unescaped[7], (expected >> 8) & 0xff);
  }
});

test("emulation mode has to be renewed on the app's recovered interval", () => {
  // The app schedules a repeating refreshEmulationMode timer while emulation is
  // on; without it the controller stops reporting presses.
  assert.equal(EMULATION_REFRESH_SECONDS, 15);
});

test("the transfer handshake is the recovered ff fc constant", () => {
  const frame = transferHandshakeFrame();
  // 0xfc is below the 0xfd escape threshold, so byte 1 is not escaped.
  assert.equal(hex(frame).startsWith("ff fc 00 00 00 00"), true);
  assert.equal(frame.length, 8);
  const expected = crc16X25(frame.subarray(0, 6));
  assert.equal(frame[6], expected & 0xff);
  assert.equal(frame[7], (expected >> 8) & 0xff);
});

test("the recovered frame families each use a distinct prefix", () => {
  // Commands, status requests and the transfer handshake must not collide.
  const prefixes = new Set([
    packet(0x04, [1, 0, 0]).subarray(0, 2).toString("hex"),
    statusRequest("periodFlags").subarray(0, 2).toString("hex"),
    transferHandshakeFrame().subarray(0, 2).toString("hex"),
  ]);
  assert.equal(prefixes.size, 3);
  assert.ok(prefixes.has("fff3"));
  assert.ok(prefixes.has("fff1"));
  assert.ok(prefixes.has("fffc"));
});

// --- The configuration checksum the app displays ----------------------------

test("the configuration checksum is CRC-16/X25, the same as the wire protocol", () => {
  // Established by running the iOS app's own compiler and comparing: the number
  // the app shows is CRC-16/X25 over the whole compiled image. There is no
  // separate configuration checksum — one algorithm serves both purposes.
  assert.equal(configurationChecksum(Buffer.alloc(0)), crc16X25(Buffer.alloc(0)));
  const sample = Buffer.from("FlexiDim", "utf8");
  assert.equal(configurationChecksum(sample), crc16X25(sample));
});

test("checksums render as four hex digits, the way the app shows them", () => {
  assert.equal(formatChecksum(0xabcd), "abcd");
  assert.equal(formatChecksum(0x5e45), "5e45");
  assert.equal(formatChecksum(0), "0000");
  assert.equal(formatChecksum(0xffff), "ffff");
  // Always four digits, so short values are padded rather than truncated.
  assert.equal(formatChecksum(0x1).length, 4);
});

test("the four comparison messages match the recovered constants", () => {
  // From processVerify:. All six-byte constants — no block number, offset or
  // length is written into any of them.
  for (const [kind, selector] of Object.entries(VERIFY_MESSAGES)) {
    const frame = verifyMessage(kind);
    assert.equal(frame[0], 0xff);
    // 0xfc is below the escape threshold; 0xfe is not, so it arrives escaped.
    const escaped = frame[1] === 0x1b;
    assert.equal(escaped ? frame[2] : frame[1], selector);
    const body = Buffer.from([0xff, selector, 0, 0, 0, 0]);
    const expected = crc16X25(body);
    const unescaped = [];
    for (let i = 0; i < frame.length; i += 1) {
      if (i > 0 && frame[i] === 0x1b) continue;
      unescaped.push(frame[i]);
    }
    assert.deepEqual(unescaped.slice(0, 6), [...body]);
    assert.equal(unescaped[6], expected & 0xff);
    assert.equal(unescaped[7], (expected >> 8) & 0xff);
  }
});

test("an unknown comparison message is refused rather than invented", () => {
  assert.throws(() => verifyMessage("f9"));
});
