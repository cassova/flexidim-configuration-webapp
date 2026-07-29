import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigurationTransferRunner } from "./transfer-runner.mjs";
import { crc16X25 } from "./protocol.mjs";
import { compileUserProfileTranscript } from "./user-transfer.mjs";

export const COMPARE_MAX_AGE_MS = 5 * 60 * 1000;
export const PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
export const OVERALL_DEADLINE_MS = 30 * 60 * 1000;
export const LIVE_WRITES_ENABLED = true;
export const QUALIFIED_FIRMWARE_VERSION = "4.0";

const TERMINAL = new Set([
  "completed", "failed", "aborted", "cancelled", "disconnected",
  "connection-timeout", "post-image-timeout", "f9-timeout",
  "final-status-timeout",
]);

function unescapeFrame(bytes) {
  const input = Buffer.from(bytes);
  if (!input.length) throw new Error("empty transfer frame");
  const output = [input[0]];
  for (let index = 1; index < input.length; index += 1) {
    if (input[index] === 0x1b) {
      index += 1;
      if (index >= input.length) throw new Error("truncated frame escape");
    }
    output.push(input[index]);
  }
  return Buffer.from(output);
}

export function validateTransferFrame(frame) {
  const wire = unescapeFrame(frame.bytes);
  if (wire.length < 3) throw new Error("transfer frame is too short");
  const body = wire.subarray(0, -2);
  const expected = wire.readUInt16LE(wire.length - 2);
  if (crc16X25(body) !== expected)
    throw new Error(`transfer frame ${frame.name} failed its CRC self-check`);
  if (!body.equals(frame.body))
    throw new Error(`transfer frame ${frame.name} changed during escaping`);
  return true;
}

function decodeBase64(value, label, maximum, allowEmpty = false) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new TypeError(`${label} must be canonical base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new TypeError(`${label} must be canonical base64`);
  if (!allowEmpty && !bytes.length) throw new RangeError(`${label} cannot be empty`);
  if (bytes.length > maximum) throw new RangeError(`${label} is too large`);
  return bytes;
}

function prepareTransferRequest(request) {
  const image = decodeBase64(request.imageBase64, "compiled image", 16 * 1024 * 1024);
  if (!Array.isArray(request.userPayloadsBase64) || request.userPayloadsBase64.length > 224)
    throw new RangeError("user payload list must contain at most 224 entries");
  const userPayloads = request.userPayloadsBase64.map((value, index) =>
    decodeBase64(value, `user payload ${index + 1}`, 4 * 1024 * 1024, true));
  const imageChecksum = crc16X25(image).toString(16).padStart(4, "0");
  if (String(request.imageChecksum || "").toLowerCase() !== imageChecksum)
    throw new Error("client and bridge disagree on the compiled image checksum");
  const bindingHash = createHash("sha256").update(image);
  for (const payload of userPayloads) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length);
    bindingHash.update(length).update(payload);
  }
  return {
    image,
    userPayloads,
    imageChecksum,
    binding: bindingHash.digest("hex"),
    sessionOptions: {
      image,
      userPayloads,
      clock: request.clock,
      siteType: request.siteType,
      firmwareProfile: request.firmwareProfile,
    },
  };
}

function driveSuccessfulDryRun(options) {
  const frames = [];
  const lifecycle = [];
  const results = [];
  const reconnectTimers = [];
  let handshakeCount = 0;
  let runner;
  const write = (_bytes, candidate) => {
    validateTransferFrame(candidate);
    frames.push(candidate);
    if (candidate.name === "prepare-user-data") {
      handshakeCount += 1;
      if (handshakeCount === 2) runner.receive([0x06]);
    } else if (candidate.name === "poll-block") {
      runner.receive([0x06]);
    } else if (candidate.name === "commit-image") {
      runner.receive([0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    } else if (candidate.name === "post-image-query") {
      runner.receive([0x06, 0]);
    }
  };
  runner = new ConfigurationTransferRunner({
    sessionOptions: options,
    write,
    reconnect: ({ connected }) => connected(),
    progress: ({ message }) => {
      if (message) lifecycle.push(message);
    },
    result: (value) => results.push(value),
    setIntervalFn: () => 1,
    clearIntervalFn: () => undefined,
    setTimeoutFn: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      reconnectTimers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => undefined,
  });
  runner.start();
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (runner.session.state === "final-status") break;
    if (!runner.active)
      throw new Error(`runner stopped in ${runner.session.state}`);
    runner.tick();
  }
  if (runner.session.state !== "final-status")
    throw new Error("runner did not reach the reset wait");

  // Exercise the binary-recovered type-0 reconnect path: stream end/error,
  // one-second tcpOpenTimeout plus two-second schedTcpOpen, then normal status.
  runner.disconnected();
  if (reconnectTimers.length !== 1 || reconnectTimers[0].milliseconds !== 3_000)
    throw new Error("runner did not schedule the original app's reconnect cycle");
  reconnectTimers[0].callback();
  for (let index = 0; index < 10; index += 1) {
    const body = Buffer.from([0xf2, index, (index * 7) % 101]);
    const check = body.reduce((sum, byte) => (sum + byte) & 0x7f, 0);
    runner.receive(Buffer.concat([body, Buffer.from([check])]));
  }
  runner.tick();
  if (results.length !== 1 || results[0].outcome !== "completed")
    throw new Error("runner dry run did not complete");
  return {
    session: runner.session,
    frames,
    lifecycle,
    runnerQualification: Object.freeze({
      state: "passed",
      resetReconnectExercised: true,
      validatedStatusRecords: 10,
    }),
  };
}

export class SanitizedTransferAudit {
  constructor(filePath = "") {
    this.filePath = filePath;
    this.entries = [];
    this.persistenceError = null;
  }

  append(event, details = {}) {
    const allowed = {};
    for (const key of [
      "owner", "state", "reason", "binding", "imageChecksum", "frameCount",
      "blockCount", "userCount", "outcome",
    ]) {
      if (details[key] !== undefined) allowed[key] = details[key];
    }
    const entry = Object.freeze({
      at: new Date().toISOString(),
      event: String(event),
      ...allowed,
    });
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        this.persistenceError = null;
      } catch (error) {
        // Audit trouble must never crash the bridge mid-session. It does,
        // however, make any future live qualification ineligible.
        this.persistenceError = error instanceof Error ? error.message : String(error);
      }
    }
    return entry;
  }

  recent(limit = 25) {
    return this.entries.slice(-Math.max(1, Math.min(100, Number(limit) || 25)));
  }
}

export class TransferSafetyCoordinator {
  constructor({
    now = () => Date.now(),
    compareMaxAgeMs = COMPARE_MAX_AGE_MS,
    overallDeadlineMs = OVERALL_DEADLINE_MS,
    audit = new SanitizedTransferAudit(),
  } = {}) {
    this.now = now;
    this.compareMaxAgeMs = compareMaxAgeMs;
    this.overallDeadlineMs = overallDeadlineMs;
    this.audit = audit;
    this.active = null;
    this.comparisons = new Map();
    this.preflights = new Map();
    this.emergencyStopped = false;
  }

  recordComparison(owner, result) {
    if (!["match", "different"].includes(result?.state)) return false;
    const localChecksum = String(result.localChecksum || "").toLowerCase();
    if (!/^[0-9a-f]{4}$/.test(localChecksum)) return false;
    this.comparisons.set(owner, {
      at: this.now(),
      localChecksum,
      controllerChecksum: String(result.controllerChecksum || "").toLowerCase(),
      state: result.state,
      version: String(result.version || ""),
    });
    this.audit.append("comparison-recorded", { owner, imageChecksum: localChecksum });
    return true;
  }

  comparisonStatus(owner, imageChecksum) {
    const comparison = this.comparisons.get(owner);
    const ageMs = comparison ? this.now() - comparison.at : null;
    return {
      present: Boolean(comparison),
      fresh: Boolean(comparison && ageMs >= 0 && ageMs <= this.compareMaxAgeMs),
      bound: Boolean(comparison && comparison.localChecksum === imageChecksum),
      ageMs,
      controllerChecksum: comparison?.controllerChecksum,
      state: comparison?.state,
      version: comparison?.version,
      firmwareQualified:
        comparison?.version === QUALIFIED_FIRMWARE_VERSION,
    };
  }

  acquire(owner, binding) {
    if (this.emergencyStopped) throw new Error("the transfer safety stop is latched");
    this.checkDeadline();
    if (this.active) throw new Error("another transfer operation already holds the lock");
    this.active = {
      id: randomUUID(),
      owner,
      binding,
      startedAt: this.now(),
      state: "preflight",
    };
    this.audit.append("lock-acquired", { owner, binding, state: "preflight" });
    return this.active;
  }

  release(outcome = "completed") {
    if (!this.active) return false;
    this.audit.append("lock-released", {
      owner: this.active.owner,
      binding: this.active.binding,
      state: this.active.state,
      outcome,
    });
    this.active = null;
    return true;
  }

  checkDeadline() {
    if (!this.active) return false;
    if (this.now() - this.active.startedAt <= this.overallDeadlineMs) return false;
    this.audit.append("deadline-expired", {
      owner: this.active.owner,
      binding: this.active.binding,
      state: this.active.state,
      outcome: "failed",
    });
    this.active = null;
    this.emergencyStopped = true;
    return true;
  }

  emergencyStop(reason = "operator") {
    this.audit.append("emergency-stop", {
      owner: this.active?.owner,
      binding: this.active?.binding,
      state: this.active?.state,
      reason: String(reason).slice(0, 80),
      outcome: "stopped",
    });
    this.active = null;
    this.emergencyStopped = true;
  }

  resetEmergencyStop() {
    this.emergencyStopped = false;
    this.audit.append("emergency-stop-reset", { outcome: "reset-offline-only" });
  }

  status(owner, imageChecksum = "") {
    return {
      type: "transferSafetyStatus",
      liveWritesEnabled: LIVE_WRITES_ENABLED,
      emergencyStopped: this.emergencyStopped,
      lock: this.active
        ? { active: true, state: this.active.state, ownedByClient: this.active.owner === owner }
        : { active: false },
      comparison: this.comparisonStatus(owner, String(imageChecksum).toLowerCase()),
      compareMaxAgeMs: this.compareMaxAgeMs,
      auditPersistent: !this.audit.persistenceError,
    };
  }

  dryRun(owner, request) {
    const {
      image, userPayloads, imageChecksum, binding, sessionOptions,
    } = prepareTransferRequest(request);
    this.acquire(owner, binding);
    try {
      const { session, frames, lifecycle, runnerQualification } =
        driveSuccessfulDryRun(sessionOptions);
      const transcriptSha256 = createHash("sha256")
        .update(Buffer.concat(frames.map((frame) => frame.bytes)))
        .digest("hex");
      const comparison = this.comparisonStatus(owner, imageChecksum);
      const result = {
        type: "transferPreflight",
        state: "passed",
        generatedAt: new Date(this.now()).toISOString(),
        imageChecksum,
        imageBytes: image.length,
        firstPassChecksum: session.transfer.firstPassCrc.toString(16).padStart(4, "0"),
        blockCount: session.transfer.blockCount,
        userCount: userPayloads.length,
        userBytes: userPayloads.reduce((total, item) => total + item.length, 0),
        frameCount: frames.length,
        runnerQualification,
        lifecycle,
        transcriptSha256,
        binding,
        comparison,
        eligibleAfterHardwareQualification:
          comparison.fresh &&
          comparison.bound &&
          comparison.state === "match" &&
          comparison.controllerChecksum === imageChecksum &&
          comparison.firmwareQualified &&
          !this.emergencyStopped &&
          !this.audit.persistenceError,
        liveWritesEnabled: LIVE_WRITES_ENABLED,
        message: "Offline transfer dry run passed; no controller bytes were written.",
      };
      this.audit.append("dry-run-passed", {
        owner, binding, imageChecksum, frameCount: frames.length,
        blockCount: session.transfer.blockCount, userCount: userPayloads.length,
        outcome: "passed",
      });
      this.preflights.set(owner, {
        at: this.now(),
        binding,
        imageChecksum,
      });
      this.release("passed");
      return result;
    } catch (error) {
      this.release("failed");
      throw error;
    }
  }

  /**
   * Compile the user-profile-only send offline and report exactly what it
   * would write. Nothing is sent: the frames are built, self-checked and
   * discarded, so this is safe with or without a controller present.
   */
  userProfileDryRun(owner, request) {
    if (
      !Array.isArray(request.userPayloadsBase64) ||
      request.userPayloadsBase64.length > 224
    )
      throw new RangeError("user payload list must contain at most 224 entries");
    const userPayloads = request.userPayloadsBase64.map((value, index) =>
      decodeBase64(value, `user payload ${index + 1}`, 4 * 1024 * 1024, true),
    );
    const transcript = compileUserProfileTranscript({ userPayloads });
    for (const frame of transcript.frames) validateTransferFrame(frame);
    const transcriptSha256 = createHash("sha256")
      .update(Buffer.concat(transcript.frames.map((frame) => frame.bytes)))
      .digest("hex");
    this.audit.append("user-profile-dry-run-passed", {
      owner,
      userCount: userPayloads.length,
      frameCount: transcript.frames.length,
      transcriptSha256,
      outcome: "passed",
    });
    return {
      type: "userProfilePreflight",
      state: "passed",
      generatedAt: new Date(this.now()).toISOString(),
      userCount: userPayloads.length,
      userBytes: userPayloads.reduce((total, item) => total + item.length, 0),
      frameCount: transcript.frames.length,
      tickCount: transcript.ticks.length,
      frameNames: transcript.frames.map((frame) => frame.name),
      transcriptSha256,
      // Sending profiles is a controller write, and no controller reply to the
      // user-only conversation has ever been observed. The frames match the
      // original app exactly; the live path stays closed until hardware
      // evidence exists.
      liveSendAvailable: false,
      message:
        "Offline user-profile dry run passed; no controller bytes were written.",
    };
  }

  /**
   * Take the lock for a live user-profile send and hand back its payloads.
   *
   * The frames are oracle-verified against the original app, but no controller
   * reply to this exchange has ever been observed, so the operator has to opt
   * in per bridge process (FLEXIDIM_ENABLE_USER_PROFILE_SEND=1) and confirm.
   * That acknowledgement is recorded, because the first real send is the
   * hardware experiment that produces the missing evidence.
   */
  beginLiveUserProfiles(owner, request, { operatorEnabled = false } = {}) {
    if (!operatorEnabled)
      throw new Error(
        "user-profile sending is not enabled on this bridge; restart it with FLEXIDIM_ENABLE_USER_PROFILE_SEND=1 to allow this unverified write",
      );
    if (request.confirm !== "Continue")
      throw new Error("the send confirmation was not received");
    const preflight = this.userProfileDryRun(owner, request);
    const lock = this.acquire(owner, preflight.transcriptSha256);
    lock.state = "sending-user-profiles";
    this.audit.append("user-profile-send-started", {
      owner,
      userCount: preflight.userCount,
      frameCount: preflight.frameCount,
      transcriptSha256: preflight.transcriptSha256,
      evidence: "oracle-only; controller reply unobserved",
      outcome: "started",
    });
    return {
      userPayloads: request.userPayloadsBase64.map((value, index) =>
        decodeBase64(value, `user payload ${index + 1}`, 4 * 1024 * 1024, true),
      ),
      preflight,
    };
  }

  /** Release the lock a user-profile send holds and record what happened. */
  finishLiveUserProfiles(owner, outcome, detail = {}) {
    this.audit.append("user-profile-send-finished", {
      owner,
      outcome,
      ...detail,
    });
    this.release(outcome === "completed" ? "completed" : "failed");
  }

  beginLive(owner, request) {
    if (!LIVE_WRITES_ENABLED) throw new Error("live configuration writes are disabled");
    const prepared = prepareTransferRequest(request);
    const comparison = this.comparisonStatus(owner, prepared.imageChecksum);
    if (
      !comparison.fresh ||
      !comparison.bound ||
      comparison.state !== "match" ||
      comparison.controllerChecksum !== prepared.imageChecksum ||
      !comparison.firmwareQualified
    ) {
      throw new Error(
        `run Compare from this connection and confirm firmware ${QUALIFIED_FIRMWARE_VERSION} matches this exact image first`,
      );
    }
    const preflight = this.preflights.get(owner);
    const preflightAge = preflight ? this.now() - preflight.at : null;
    if (
      !preflight ||
      preflightAge < 0 ||
      preflightAge > PREFLIGHT_MAX_AGE_MS ||
      preflight.binding !== prepared.binding
    ) {
      throw new Error(
        "run the offline transfer dry run for this exact image immediately before sending",
      );
    }
    if (this.audit.persistenceError)
      throw new Error("the sanitized transfer audit is unavailable");
    const lock = this.acquire(owner, prepared.binding);
    lock.state = "transferring";
    this.audit.append("live-transfer-started", {
      owner,
      binding: prepared.binding,
      imageChecksum: prepared.imageChecksum,
      blockCount: Math.ceil((prepared.image.length + 4) / 256),
      userCount: prepared.userPayloads.length,
      state: "transferring",
    });
    return {
      ...prepared,
      comparison,
      lock,
    };
  }

  finishLive(owner, outcome, details = {}) {
    if (!this.active || this.active.owner !== owner) return false;
    this.audit.append("live-transfer-finished", {
      owner,
      binding: this.active.binding,
      state: this.active.state,
      imageChecksum: details.imageChecksum,
      frameCount: details.frameCount,
      outcome,
    });
    return this.release(outcome);
  }
}

export function terminalTransferState(state) {
  return TERMINAL.has(state);
}
