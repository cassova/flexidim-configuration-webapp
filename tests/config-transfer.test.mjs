import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCK_TIMEOUT_TICKS,
  CONNECTION_TIMEOUT_TICKS,
  ConfigurationTransferSession,
  FINAL_STATUS_COUNT,
  FINAL_STATUS_TIMEOUT_TICKS,
  MAX_BLOCK_RETRIES,
  MAX_CONNECTION_RETRIES,
  POST_IMAGE_TIMEOUT_TICKS,
  SETTLE_TICKS,
  allUsersTerminator,
  appendCrc,
  buildTransferPayload,
  compileTransferTranscript,
  configurationBlock,
  escapeFrame,
  setupFrames,
  userDataFrames,
} from "../bridge/config-transfer.mjs";
import { crc16X25 } from "../bridge/protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function syntheticImage(length = 36492, firstPassLength = 27276) {
  const image = Buffer.alloc(length);
  for (let index = 0; index < image.length; index += 1)
    image[index] = (index * 73 + 0x1b) & 0xff;
  const pointer = firstPassLength - 1;
  image[24] = pointer & 0xff;
  image[25] = (pointer >>> 8) & 0xff;
  image[26] = (pointer >>> 16) & 0xff;
  return image;
}

function unescape(bytes) {
  const input = Buffer.from(bytes);
  const output = [input[0]];
  for (let index = 1; index < input.length; index += 1) {
    if (input[index] === 0x1b) index += 1;
    output.push(input[index]);
  }
  return Buffer.from(output);
}

function fromBcd(value) {
  return ((value >>> 4) & 0x0f) * 10 + (value & 0x0f);
}

function tick(session, count) {
  let result;
  for (let index = 0; index < count; index += 1)
    result = session.step({ type: "tick" });
  return result;
}

function reachFirstBlock(session) {
  session.start();
  session.step({ type: "tick" });
  session.step({ type: "reply", bytes: [0x06] });
  return tick(session, 21);
}

test("CRC append and escaping are independent byte-exact layers", () => {
  const body = Buffer.from([0xfe, 0x1b, 0xfd, 0xfe, 0xff, 0x00]);
  const withCrc = appendCrc(body);
  assert.equal(withCrc.readUInt16LE(body.length), crc16X25(body));
  const escaped = escapeFrame(withCrc);
  assert.deepEqual(unescape(escaped), withCrc);
  assert.deepEqual([...escaped.subarray(0, 10)], [
    0xfe, 0x1b, 0x1b, 0x1b, 0xfd, 0x1b, 0xfe, 0x1b, 0xff, 0x00,
  ]);
});

test("fixed setup, poll, reset and abort records match the oracle", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const setup = setupFrames(clock);
  assert.deepEqual([...setup[0].body], [0xff, 0xf6, 0x00, 0x40, 0x43, 0x52]);
  assert.deepEqual([...setup[1].body], [0xff, 0xf6, 0x26, 0x00, 0x07, 0x26]);
  assert.equal(setup[2].bytes.toString("hex"), "fffc0000000033e2");

  const session = new ConfigurationTransferSession({ image: syntheticImage(), clock });
  const firstBlock = reachFirstBlock(session);
  assert.equal(firstBlock.frames[1].bytes.toString("hex"), "fff700000000dfa5");
  for (let retry = 0; retry <= MAX_BLOCK_RETRIES; retry += 1) {
    const result = session.step({ type: "reply", bytes: [0x15] });
    if (retry === MAX_BLOCK_RETRIES)
      assert.equal(result.frames[0].bytes.toString("hex"), "fff80000000023cf");
  }
});

test("the transfer payload appends both compiler CRCs before zero padding", () => {
  const image = syntheticImage();
  const transfer = buildTransferPayload(image);
  assert.equal(transfer.imageLength, 36492);
  assert.equal(transfer.firstPassLength, 27276);
  assert.equal(transfer.blockCount, 143);
  assert.deepEqual(transfer.payload.subarray(0, image.length), image);
  assert.equal(transfer.payload.readUInt16LE(image.length), crc16X25(image.subarray(0, 27276)));
  assert.equal(transfer.payload.readUInt16LE(image.length + 2), crc16X25(image));
  assert.equal(transfer.payload.subarray(image.length + 4).some(Boolean), false);
});

test("block 0, a middle block and the final block have exact indexes, CRCs and payload", () => {
  const transfer = buildTransferPayload(syntheticImage());
  for (const index of [0, 71, 142]) {
    const block = configurationBlock(transfer.payload, index);
    const wire = unescape(block.bytes);
    assert.equal(wire[0], 0xfe);
    assert.equal(wire.readUInt16LE(1), index);
    assert.deepEqual(
      wire.subarray(3, 259),
      transfer.payload.subarray(index * 256, index * 256 + 256),
    );
    assert.equal(wire.readUInt16LE(259), crc16X25(wire.subarray(0, 259)));
  }
});

test("the pure transcript reproduces opening state order and the 21-tick delay", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const events = [
    { type: "tick" },
    { type: "reply", bytes: [0x06] },
    ...Array.from({ length: 21 }, () => ({ type: "tick" })),
  ];
  const transcript = compileTransferTranscript({ image: syntheticImage(), clock }, events);
  assert.deepEqual(transcript.transitions[0].messages, [
    "Compiling current local configuration",
  ]);
  assert.deepEqual(transcript.transitions[1].messages, [
    "Connecting to Scene Controller",
  ]);
  assert.deepEqual(transcript.transitions[0].frames.map(({ name }) => name), [
    "set-time", "set-date", "prepare-user-data",
  ]);
  assert.deepEqual(transcript.transitions[1].frames.map(({ name }) => name), [
    "prepare-user-data",
  ]);
  assert.equal(transcript.transitions.at(-2).frames.length, 0);
  assert.deepEqual(transcript.transitions.at(-1).frames.map(({ name }) => name), [
    "configuration-block", "poll-block",
  ]);
  assert.deepEqual(transcript.transitions.at(-1).messages, [
    "Downloading block 1",
  ]);
  assert.equal(transcript.final.state, "block-ack");
});

test("connection retries and failure match the original iOS lifecycle", () => {
  const session = new ConfigurationTransferSession({
    image: syntheticImage(),
    clock: {
      year: 2026, month: 7, day: 26, weekday: 0,
      hour: 12, minute: 43, second: 40, dst: true,
    },
  });
  session.start();
  session.step({ type: "tick" });
  for (let retry = 1; retry <= MAX_CONNECTION_RETRIES; retry += 1) {
    const result = tick(session, CONNECTION_TIMEOUT_TICKS);
    assert.equal(result.after.state, "handshake");
    assert.equal(result.frames[0].bytes.toString("hex"), "fffc0000000033e2");
    assert.deepEqual(result.messages, [
      `Retrying connection to Scene Controller : ${retry} / 5`,
    ]);
  }
  const failed = tick(session, CONNECTION_TIMEOUT_TICKS);
  assert.equal(failed.after.state, "connection-timeout");
  assert.equal(failed.frames[0].bytes.toString("hex"), "fff80000000023cf");
  assert.deepEqual(failed.messages, [
    "Failed to connect to Scene Controller - resetting",
  ]);
  assert.throws(() => session.step({ type: "tick" }), /terminal/);
});

test("ACK advances on the next tick; NAK and timeout resend byte-identically", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const session = new ConfigurationTransferSession({ image: syntheticImage(), clock });
  const original = reachFirstBlock(session);
  const originalBytes = original.frames.map(({ bytes }) => bytes);

  const nak = session.step({ type: "reply", bytes: [0x15] });
  assert.deepEqual(nak.frames.map(({ bytes }) => bytes), originalBytes);
  assert.equal(nak.after.retry, 1);

  const ack = session.step({ type: "reply", bytes: [0x06] });
  assert.equal(ack.frames.length, 0);
  assert.equal(ack.after.state, "block-gap");
  const next = session.step({ type: "tick" });
  assert.equal(next.frames[0].blockIndex, 1);

  const timeout = tick(session, BLOCK_TIMEOUT_TICKS);
  assert.deepEqual(timeout.frames.map(({ bytes }) => bytes), next.frames.map(({ bytes }) => bytes));
  assert.equal(timeout.after.retry, 1);
});

test("five retries are allowed, the sixth failure aborts, and terminal states reject work", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const session = new ConfigurationTransferSession({ image: syntheticImage(), clock });
  reachFirstBlock(session);
  for (let index = 0; index < MAX_BLOCK_RETRIES; index += 1) {
    const retry = session.step({ type: "reply", bytes: [0x15] });
    assert.equal(retry.after.state, "block-ack");
    assert.equal(retry.after.retry, index + 1);
  }
  const abort = session.step({ type: "reply", bytes: [0x15] });
  assert.equal(abort.after.state, "aborted");
  assert.equal(abort.frames[0].bytes.toString("hex"), "fff80000000023cf");
  assert.deepEqual(abort.messages, [
    "Failed to download to Scene Controller - resetting",
  ]);
  assert.throws(() => session.step({ type: "tick" }), /terminal/);
});

test("the final ACK enters post-image status wait and its observed timeout aborts", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const session = new ConfigurationTransferSession({ image: syntheticImage(300, 100), clock });
  reachFirstBlock(session);
  session.step({ type: "reply", bytes: [0x06] });
  session.step({ type: "tick" });
  const finalAck = session.step({ type: "reply", bytes: [0x06] });
  assert.equal(finalAck.after.state, "post-image");
  assert.deepEqual(finalAck.messages, ["Verifying Scene Controller"]);
  const reset = session.step({ type: "tick" });
  assert.equal(reset.frames[0].bytes.toString("hex"), "fffa00000000abd9");
  assert.equal(reset.after.state, "post-image-status");
  const timeout = tick(session, POST_IMAGE_TIMEOUT_TICKS);
  assert.equal(timeout.after.state, "post-image-timeout");
  assert.equal(timeout.frames[0].bytes.toString("hex"), "fff80000000023cf");
  assert.deepEqual(timeout.messages, ["Failed to verify - resetting "]);
});

test("post-image replies drive F9, F8, user F2 frames and final status completion", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const payload = Buffer.alloc(300, 0x41);
  const session = new ConfigurationTransferSession({
    image: syntheticImage(300, 100),
    clock,
    userPayloads: [payload],
  });
  reachFirstBlock(session);
  session.step({ type: "reply", bytes: [0x06] });
  session.step({ type: "tick" });
  session.step({ type: "reply", bytes: [0x06] });
  session.step({ type: "tick" });

  const f9 = session.step({
    type: "reply",
    bytes: [0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  assert.equal(f9.frames[0].bytes.toString("hex"), "fff90000000067c4");
  assert.deepEqual(f9.messages, [
    "Making permanent - this takes up to 60 seconds",
  ]);
  const f8 = session.step({ type: "reply", bytes: [0x06, 0] });
  assert.equal(f8.frames[0].bytes.toString("hex"), "fff80000000023cf");
  assert.equal(f8.after.state, "user-transfer");
  assert.deepEqual(f8.messages, [
    "Download complete - resetting Scene Controller",
    "This takes about 60 seconds",
  ]);

  const user = session.step({ type: "tick" });
  assert.equal(user.frames.length, 2);
  assert.deepEqual(user.frames.map(({ marker }) => marker), [0, 0x3fff]);
  const end = session.step({ type: "tick" });
  assert.deepEqual(end.frames[0].bytes, allUsersTerminator().bytes);
  assert.equal(end.after.state, "final-status");

  for (let index = 0; index < FINAL_STATUS_COUNT; index += 1)
    session.step({ type: "status" });
  const complete = session.step({ type: "tick" });
  assert.equal(complete.after.state, "completed");
  assert.deepEqual(complete.messages, [
    "Download completed successfully",
    "Scene controller running normally",
  ]);
});

test("user payload chunks carry a 14-bit index and mark the final data chunk 7f 7f", () => {
  const frames = userDataFrames(Buffer.alloc(513, 0x41), 7);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map(({ marker }) => marker), [0, 1, 0x3fff]);
  assert.deepEqual(
    frames.map(({ body }) => [...body.subarray(0, 5)]),
    [
      [0xff, 0xf2, 7, 0, 0],
      [0xff, 0xf2, 7, 1, 0],
      [0xff, 0xf2, 7, 0x7f, 0x7f],
    ],
  );
  assert.equal(frames[2].body[5], 0x41);
  assert.equal(frames[2].body.subarray(6).some(Boolean), false);
  assert.deepEqual(userDataFrames(Buffer.alloc(0), 0), []);
});

test("F9 and final-status waits use the original sender's 1201-tick limit", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  const session = new ConfigurationTransferSession({
    image: syntheticImage(100, 50),
    clock,
  });
  reachFirstBlock(session);
  session.step({ type: "reply", bytes: [0x06] });
  session.step({ type: "tick" });
  session.step({ type: "reply", bytes: [0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  const f9Timeout = tick(session, FINAL_STATUS_TIMEOUT_TICKS);
  assert.equal(f9Timeout.after.state, "f9-timeout");
  assert.equal(f9Timeout.frames[0].bytes.toString("hex"), "ff1bfe00000000bbf4");
  assert.deepEqual(f9Timeout.messages, ["Failed to make permanent"]);
});

test("reset success requires ten statuses and timeout uses the iOS recovery text", () => {
  const make = () => new ConfigurationTransferSession({
    image: syntheticImage(100, 50),
    clock: {
      year: 2026, month: 7, day: 26, weekday: 0,
      hour: 12, minute: 43, second: 40, dst: true,
    },
  });
  const reachFinalStatus = (session) => {
    reachFirstBlock(session);
    session.step({ type: "reply", bytes: [0x06] });
    session.step({ type: "tick" });
    session.step({
      type: "reply",
      bytes: [0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    session.step({ type: "reply", bytes: [0x06, 0] });
    session.step({ type: "tick" });
  };

  const notEnough = make();
  reachFinalStatus(notEnough);
  for (let index = 0; index < FINAL_STATUS_COUNT - 1; index += 1)
    notEnough.step({ type: "status" });
  const waiting = notEnough.step({ type: "tick" });
  assert.equal(waiting.after.state, "final-status");
  assert.deepEqual(waiting.messages, []);

  const timedOut = make();
  reachFinalStatus(timedOut);
  const failure = tick(timedOut, FINAL_STATUS_TIMEOUT_TICKS);
  assert.equal(failure.after.state, "final-status-timeout");
  assert.deepEqual(failure.messages, [
    "Scene controller reset not detected",
    "The Scene Controller will reset automatically in a few minutes, if it is not already working normally.",
  ]);
});

test("unknown profiles, replies and invalid header pointers fail closed", () => {
  const clock = {
    year: 2026, month: 7, day: 26, weekday: 0,
    hour: 12, minute: 43, second: 40, dst: true,
  };
  assert.throws(
    () => new ConfigurationTransferSession({ image: syntheticImage(), clock, siteType: 1 }),
    /unsupported transfer site type/,
  );
  assert.throws(
    () => new ConfigurationTransferSession({ image: syntheticImage(), clock, firmwareProfile: "unknown" }),
    /unsupported transfer firmware profile/,
  );
  assert.throws(
    () => new ConfigurationTransferSession({ image: syntheticImage(), clock, configurationMode: "users-only" }),
    /unsupported transfer configuration mode/,
  );
  assert.throws(
    () => new ConfigurationTransferSession({ image: syntheticImage(), clock, userPayloads: "invalid" }),
    /must be an array/,
  );
  const invalid = syntheticImage();
  invalid[24] = 0xff;
  invalid[25] = 0xff;
  invalid[26] = 0xff;
  assert.throws(() => buildTransferPayload(invalid), /valid first pass/);

  const session = new ConfigurationTransferSession({ image: syntheticImage(), clock });
  session.start();
  assert.throws(() => session.step({ type: "reply", bytes: [0x06] }), /requires a tick/);
  session.step({ type: "tick" });
  assert.throws(() => session.step({ type: "reply", bytes: [0x07] }), /exactly one byte/);
  const disconnected = session.step({ type: "disconnect" });
  assert.equal(disconnected.after.state, "disconnected");
  assert.deepEqual(disconnected.frames, []);
  assert.throws(() => session.step({ type: "tick" }), /terminal/);
});

test("operator cancellation is terminal, emits no speculative frame, and records why", () => {
  const session = new ConfigurationTransferSession({
    image: syntheticImage(),
    clock: {
      year: 2026, month: 7, day: 26, weekday: 0,
      hour: 12, minute: 43, second: 40, dst: true,
    },
  });
  session.start();
  const cancelled = session.cancel("emergency stop");
  assert.equal(cancelled.after.state, "cancelled");
  assert.deepEqual(cancelled.frames, []);
  assert.equal(session.cancelReason, "emergency stop");
  assert.throws(() => session.step({ type: "tick" }), /terminal/);
});

test("malformed post-image and F9 replies fail terminally without background frames", () => {
  const make = () => new ConfigurationTransferSession({
    image: syntheticImage(100, 50),
    clock: {
      year: 2026, month: 7, day: 26, weekday: 0,
      hour: 12, minute: 43, second: 40, dst: true,
    },
  });
  const postImage = make();
  reachFirstBlock(postImage);
  postImage.step({ type: "reply", bytes: [0x06] });
  postImage.step({ type: "tick" });
  const failedStatus = postImage.step({ type: "reply", bytes: [0x06] });
  assert.equal(failedStatus.after.state, "failed");
  assert.equal(failedStatus.frames[0].bytes.toString("hex"), "fff80000000023cf");
  assert.throws(() => postImage.step({ type: "tick" }), /terminal/);

  const f9 = make();
  reachFirstBlock(f9);
  f9.step({ type: "reply", bytes: [0x06] });
  f9.step({ type: "tick" });
  f9.step({ type: "reply", bytes: Buffer.alloc(10, 0x06) });
  const failedF9 = f9.step({ type: "reply", bytes: [0x06, 0x01] });
  assert.equal(failedF9.after.state, "failed");
  assert.equal(failedF9.frames[0].bytes.toString("hex"), "ff1bfe00000000bbf4");
  assert.throws(() => f9.step({ type: "status" }), /terminal/);
});

test("all 295 frames match the original iOS sender on the committed synthetic fixture", () => {
  const fixtures = path.join(here, "..", "tools", "oracle", "fixtures");
  const image = fs.readFileSync(path.join(fixtures, "transfer-oracle-image.bin"));
  const oracle = JSON.parse(
    fs.readFileSync(path.join(fixtures, "transfer-oracle-wire.json"), "utf8"),
  ).map((hex) => Buffer.from(hex, "hex"));
  const time = unescape(oracle[0]);
  const date = unescape(oracle[1]);
  const clock = {
    year: 2000 + fromBcd(date[2]),
    weekday: date[3],
    month: fromBcd(date[4]),
    day: fromBcd(date[5]),
    hour: fromBcd(time[5] & ~0x40),
    minute: fromBcd(time[4]),
    second: fromBcd(time[3]),
    dst: Boolean(time[5] & 0x40),
  };
  const userPayloads = JSON.parse(
    fs.readFileSync(
      path.join(fixtures, "transfer-oracle-user-payloads.json"),
      "utf8",
    ),
  ).map((value) => Buffer.from(value, "base64"));
  const session = new ConfigurationTransferSession({ image, clock, userPayloads });
  const generated = [];
  const collect = ({ frames }) =>
    generated.push(...frames.map(({ bytes }) => bytes));

  collect(session.start());
  collect(session.step({ type: "tick" }));
  collect(session.step({ type: "reply", bytes: [0x06] }));
  for (let index = 0; index < SETTLE_TICKS; index += 1)
    collect(session.step({ type: "tick" }));
  for (let index = 0; index < session.transfer.blockCount; index += 1) {
    collect(session.step({ type: "reply", bytes: [0x06] }));
    if (index + 1 < session.transfer.blockCount)
      collect(session.step({ type: "tick" }));
  }
  collect(session.step({ type: "tick" }));
  collect(session.step({
    type: "reply",
    bytes: [0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  }));
  collect(session.step({ type: "reply", bytes: [0x06, 0] }));
  collect(session.step({ type: "tick" }));
  collect(session.step({ type: "tick" }));
  for (let index = 0; index < FINAL_STATUS_COUNT; index += 1)
    collect(session.step({ type: "status" }));
  collect(session.step({ type: "tick" }));

  assert.equal(session.transfer.blockCount, 143);
  assert.equal(generated.length, 295);
  assert.deepEqual(generated, oracle);
  assert.equal(session.state, "completed");
});

test("the committed oracle manifest is sanitized and pins every frame family", () => {
  const fixtures = path.join(here, "..", "tools", "oracle", "fixtures");
  const source = fs.readFileSync(
    path.join(fixtures, "transfer-oracle-manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(source);
  assert.equal(manifest.containsPayloadBytes, false);
  assert.doesNotMatch(source, /"(body|bytes|hex|payload)"\s*:/i);
  const frames = manifest.transitions.flatMap((transition) => transition.frames);
  assert.ok(frames.every((frame) => frame.crcValid));
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(frames.map((frame) => frame.family))]
        .map((family) => [
          family,
          frames.filter((frame) => frame.family === family).length,
        ]),
    ),
    {
      "ff-f6": 2,
      "ff-fc": 2,
      "configuration-block": 143,
      "ff-f7": 143,
      "ff-fa": 1,
      "ff-f9": 1,
      "ff-f8": 1,
      "ff-f2": 2,
    },
  );
});
