function crc16X25(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return (~crc) & 0xffff;
}

function packet(command, values = []) {
  const body = Buffer.from([0xff, 0xf3, command, ...values.map((value) => Math.max(0, Math.min(255, Number(value) || 0)))]);
  const crc = crc16X25(body);
  const complete = Buffer.concat([body, Buffer.from([crc & 0xff, crc >>> 8])]);
  const escaped = [complete[0]];
  for (const byte of complete.subarray(1)) {
    if (byte === 0x1b || byte >= 0xfd) escaped.push(0x1b);
    escaped.push(byte);
  }
  return Buffer.from(escaped);
}

/**
 * Frame the given body exactly as `packet` does, so recovered constant frames
 * share one escaping and CRC path rather than reimplementing it.
 */
function framed(body) {
  const buffer = Buffer.from(body);
  const crc = crc16X25(buffer);
  const complete = Buffer.concat([buffer, Buffer.from([crc & 0xff, crc >>> 8])]);
  const escaped = [complete[0]];
  for (const byte of complete.subarray(1)) {
    if (byte === 0x1b || byte >= 0xfd) escaped.push(0x1b);
    escaped.push(byte);
  }
  return Buffer.from(escaped);
}

/**
 * Status-request frames, recovered byte for byte from the iOS binary.
 *
 * These use the `ff f1` prefix — a different family from the `ff f3` command
 * frames — and are nine-byte constants with the CRC appended over all nine.
 *   requestPeriodFlags    (0x1000412a4): ff f1 00 00 00 00 00 00 00
 *   requestPendingScenes  (0x100041410): ff f1 01 00 00 00 00 00 00
 *
 * NOT transmitted by this build: the capability profile gates them until a
 * reply has been observed on recoverable hardware. They are implemented and
 * tested so that enabling them later is a profile change, not new protocol work.
 */
const STATUS_REQUESTS = { periodFlags: 0x00, pendingScenes: 0x01 };

function statusRequest(kind) {
  const selector = STATUS_REQUESTS[kind];
  if (selector === undefined)
    throw new Error(`unknown status request: ${kind}`);
  return framed([0xff, 0xf1, selector, 0, 0, 0, 0, 0, 0]);
}

/**
 * The generic switch/dimmer function frame, `-sendSwDiMessage:value:function:`
 * at 0x100041550. Template `ff f3 06 …`, CRC over seven bytes.
 *
 * Payload bytes are masked to seven bits and the dropped high bits are recorded
 * as flags in byte 2 — the app's way of keeping payload out of the 0xfd..0xff
 * delimiter range:
 *   0x08 target had bit 7, 0x10 value had bit 7, 0x20 function had bit 7.
 * The target is transmitted zero-based (`target - 1`).
 *
 * Recovered from `runScene:`, `brightness:` and `brightnessStep:`, so this is
 * the scene/brightness path. The verified live path in this build still expands
 * a scene into per-channel `04` dim frames; this frame is implemented for parity
 * and is not transmitted until it has been confirmed on hardware.
 */
function switchDimFunctionFrame(target, value, functionCode) {
  const zeroBased = (Number(target) || 0) - 1;
  let flags = 0x06;
  if (zeroBased & 0x80) flags |= 0x08;
  if (Number(value) & 0x80) flags |= 0x10;
  if (Number(functionCode) & 0x80) flags |= 0x20;
  return framed([
    0xff,
    0xf3,
    flags,
    zeroBased & 0x7f,
    Number(value) & 0x7f,
    Number(functionCode) & 0x7f,
    0x00,
  ]);
}

/**
 * Switch emulation mode, `-emulationMode:` at 0x10003ef24. Fully recovered.
 *
 * Six-byte frame, CRC over all six. Byte 1 selects the action:
 *   0xfd enter emulation, 0xfe leave it.
 * Both land in the 0xfd..0xff escape range, so the framing escape is what keeps
 * them from being read as a frame delimiter — this command is precisely why that
 * mechanism exists.
 *
 * Entering emulation is what makes the controller report switch presses, which
 * is how the original app implements "identify switch by button press". The app
 * also starts a repeating 15-second `refreshEmulationMode` timer while it is on,
 * so the mode has to be renewed or the controller stops reporting.
 *
 * Only valid for site types 0 and 1; `siteType > 1` takes a different branch in
 * the app. NOT transmitted by this build — gated by `switchDetection`.
 */
const EMULATION_MODE = { enter: 0xfd, leave: 0xfe };

/** How often the app renews emulation mode while it is active, in seconds. */
const EMULATION_REFRESH_SECONDS = 15;

function emulationModeFrame(on) {
  return framed([0xff, on ? EMULATION_MODE.enter : EMULATION_MODE.leave, 0, 0, 0, 0]);
}

/**
 * The shared configuration download/verification handshake:
 *
 *   ff fc 00 00 00 00 + CRC
 *
 * An early binary-only reading named this a user-data frame because
 * `sendUserData:userOnly:` references the same template. Executing the sender
 * oracle established that actual user payloads use `ff f2`; `ff fc` is the
 * handshake used before download and verification.
 */
function transferHandshakeFrame() {
  return framed([0xff, 0xfc, 0, 0, 0, 0]);
}

// Compatibility alias for callers written before the sender oracle corrected
// the command's role. New code should use transferHandshakeFrame().
const userDataFrame = transferHandshakeFrame;

/**
 * The four messages the iOS app sends during a configuration comparison,
 * recovered byte for byte from `processVerify:`.
 *
 * All are six-byte constants — no block number, offset or length is written into
 * any of them, verified by the absence of any byte-store between each template
 * load and its checksum call. The controller drives the exchange; the app
 * advances a four-state machine on what comes back.
 *
 * `bridge/verify-session.mjs` implements the recovered state order, reply fields,
 * retry limits and cleanup messages. This is a read-only controller operation:
 * it returns a verdict and metadata, and never sends compiled configuration data.
 */
const VERIFY_MESSAGES = {
  f5: 0xf5,
  f8: 0xf8,
  fc: 0xfc,
  fe: 0xfe,
};

function verifyMessage(kind) {
  const selector = VERIFY_MESSAGES[kind];
  if (selector === undefined)
    throw new Error(`unknown verify message: ${kind}`);
  return framed([0xff, selector, 0, 0, 0, 0]);
}

/**
 * The checksum the app displays for a configuration.
 *
 * Established by running the app's own compiler and comparing: it is CRC-16/X25
 * over the entire compiled image — the SAME algorithm the wire protocol uses,
 * not a separate one. The private-reference oracle verifies the original app's
 * displayed value without exposing that configuration fingerprint here.
 *
 * The app renders it as four hex digits with no prefix, which is worth
 * matching: reading it as decimal makes a correct value look wrong.
 */
function configurationChecksum(compiledImage) {
  return crc16X25(compiledImage);
}

function formatChecksum(value) {
  return value.toString(16).padStart(4, "0");
}

export {
  crc16X25,
  packet,
  framed,
  statusRequest,
  STATUS_REQUESTS,
  switchDimFunctionFrame,
  emulationModeFrame,
  EMULATION_MODE,
  EMULATION_REFRESH_SECONDS,
  userDataFrame,
  transferHandshakeFrame,
  verifyMessage,
  VERIFY_MESSAGES,
  configurationChecksum,
  formatChecksum,
};
