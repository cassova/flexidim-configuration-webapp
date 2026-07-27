import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticationRecord } from "../bridge/session.mjs";
import { parseControllerReplies } from "../bridge/controller-replies.mjs";
import { packet } from "../bridge/protocol.mjs";
import {
  EVIDENCE_LEVELS,
  FIRMWARE_PROFILES,
  binaryOnlyCapabilities,
  fallbackFirmwareProfile,
  firmwareProfileFor,
  underEvidencedWrites,
  unevidencedCapabilities,
} from "../bridge/firmware-profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const emulator = path.join(here, "..", "tools", "controller-emulator.mjs");

/**
 * Stateful session tests against the emulated controller.
 *
 * These drive a real TCP session end to end — authentication, the passive f2
 * scan, command acknowledgement and disconnects — so session handling is
 * covered without touching the real installation.
 */

/** Start the emulator on an ephemeral port and wait until it is listening. */
async function startEmulator(env = {}) {
  const port = 15400 + Number(process.hrtime.bigint() % 200n);
  const child = spawn(
    process.execPath,
    [emulator],
    {
      env: {
        ...process.env,
        FLEXIDIM_CONTROLLER_PORT: String(port),
        FLEXIDIM_SCAN_INTERVAL_MS: "150",
        FLEXIDIM_EMULATED_CHANNELS: "8",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emulator did not start: ${output}`)),
      8000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("TCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  await ready;
  return {
    port,
    stop: async () => {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    },
  };
}

/** Collect replies for a window, parsing them the way the bridge does. */
function collect(socket, ms) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const statuses = [];
    const visible = [];
    const invalid = [];
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseControllerReplies(buffer);
      buffer = Buffer.from(parsed.rest);
      statuses.push(...parsed.statuses);
      visible.push(...parsed.visible);
      invalid.push(...parsed.invalid);
    };
    socket.on("data", onData);
    setTimeout(() => {
      socket.off("data", onData);
      resolve({ statuses, visible, invalid });
    }, ms);
  });
}

test("an authenticated session receives the passive channel scan", async () => {
  const controller = await startEmulator();
  try {
    const socket = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(socket, "connect");
    socket.write(authenticationRecord("EMULATORKEY01234"));
    const { statuses, invalid } = await collect(socket, 600);
    // The scan starts as soon as the session opens, unsolicited.
    assert.ok(statuses.length >= 8, `expected a full scan, got ${statuses.length}`);
    // Every record must pass the additive check the bridge enforces.
    assert.deepEqual(invalid, [], "the emulator must emit valid check bytes");
    const channels = new Set(statuses.map((status) => status.channel));
    assert.deepEqual([...channels].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    socket.destroy();
  } finally {
    await controller.stop();
  }
});

test("a dim command is acknowledged and reflected in the next scan", async () => {
  const controller = await startEmulator();
  try {
    const socket = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(socket, "connect");
    socket.write(authenticationRecord("EMULATORKEY01234"));
    await collect(socket, 250);
    socket.write(packet(0x04, [3, 55, 0]));
    const { statuses, visible } = await collect(socket, 500);
    // An f4 acknowledgement comes back for the command.
    assert.ok(visible.length >= 1, "expected an f4 acknowledgement");
    // The new level shows up in the status stream, so state actually changed.
    const channel3 = statuses.filter((status) => status.channel === 3);
    assert.ok(channel3.length > 0);
    assert.equal(channel3.at(-1).level, 55);
    socket.destroy();
  } finally {
    await controller.stop();
  }
});

test("a malformed authentication record is refused by dropping the connection", async () => {
  const controller = await startEmulator();
  try {
    const socket = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(socket, "connect");
    // Right length, wrong shape: no six-digit nonce and no 0xff terminator.
    socket.write(Buffer.alloc(23, 0x41));
    await once(socket, "close");
    assert.ok(socket.destroyed, "the controller must not hold a bad session open");
  } finally {
    await controller.stop();
  }
});

test("only one control session is accepted at a time", async () => {
  const controller = await startEmulator();
  try {
    const first = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(first, "connect");
    first.write(authenticationRecord("EMULATORKEY01234"));
    await collect(first, 200);

    // A real Scene Controller permits exactly one control connection; the
    // second must be refused rather than silently interleaved.
    const second = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(second, "connect");
    await once(second, "close");
    assert.ok(second.destroyed);

    // The first session keeps working after the refusal.
    const { statuses } = await collect(first, 400);
    assert.ok(statuses.length > 0, "the original session must survive");
    first.destroy();
  } finally {
    await controller.stop();
  }
});

test("the session frees up again after a disconnect", async () => {
  const controller = await startEmulator();
  try {
    const first = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(first, "connect");
    first.write(authenticationRecord("EMULATORKEY01234"));
    await collect(first, 200);
    first.destroy();
    await once(first, "close");

    // Reconnecting after a drop has to work, or a crashed client would lock the
    // controller out until it rebooted.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = net.createConnection({ host: "127.0.0.1", port: controller.port });
    await once(second, "connect");
    second.write(authenticationRecord("EMULATORKEY01234"));
    const { statuses } = await collect(second, 500);
    assert.ok(statuses.length > 0, "the reconnected session must get the scan");
    second.destroy();
  } finally {
    await controller.stop();
  }
});

test("the emulator answers discovery so the bridge can find it", async () => {
  const controller = await startEmulator();
  try {
    const dgram = await import("node:dgram");
    const socket = dgram.createSocket("udp4");
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no discovery reply")), 4000);
      socket.on("message", (message) => {
        clearTimeout(timer);
        resolve(message.toString("latin1"));
      });
    });
    await new Promise((resolve) => socket.bind(0, resolve));
    socket.send(Buffer.from("FLEXIDIM"), 15270, "127.0.0.1");
    assert.match(await reply, /FLEXIDIM/);
    socket.close();
  } finally {
    await controller.stop();
  }
});

// --- Firmware acceptance matrix ---------------------------------------------

test("an unidentified type-0 controller gets the narrowly supported fallback profile", () => {
  const profile = firmwareProfileFor({});
  assert.equal(profile.id, "type-0-live-only");
  assert.equal(profile, fallbackFirmwareProfile());
  // Full transfer is the one commissioning write supported by the exact
  // original-app oracle, emulator, and installed type-0 firmware evidence.
  assert.equal(profile.capabilities.fullTransfer, true);
  assert.equal(profile.capabilities.verify, true);
});

test("an unrecognised firmware version still falls back rather than matching loosely", () => {
  assert.equal(firmwareProfileFor({ version: "9.9.9" }).id, "type-0-live-only");
});

test("no profile enables a capability with no evidence at all", () => {
  // The matrix's core invariant: evidence gates capability.
  for (const profile of FIRMWARE_PROFILES)
    assert.deepEqual(
      unevidencedCapabilities(profile),
      [],
      `${profile.id} enables capabilities with no evidence`,
    );
});

test("no profile enables a configuration write without hardware evidence", () => {
  // A wrong live frame is ignored; a wrong write is not recoverable by retrying,
  // so writes need a stricter bar than reads.
  for (const profile of FIRMWARE_PROFILES)
    assert.deepEqual(
      underEvidencedWrites(profile),
      [],
      `${profile.id} enables a write without hardware evidence`,
    );
});

test("capabilities enabled on binary evidence alone are surfaced, not hidden", () => {
  // The switch frame is still binary-only. Verify was exercised against real
  // hardware and therefore no longer belongs in this warning list.
  const profile = fallbackFirmwareProfile();
  assert.deepEqual(binaryOnlyCapabilities(profile), ["liveSwitch"]);
});

test("every capability in a profile carries a recognised evidence level", () => {
  for (const profile of FIRMWARE_PROFILES)
    for (const [capability, level] of Object.entries(profile.evidence))
      assert.ok(
        EVIDENCE_LEVELS.includes(level),
        `${profile.id}.${capability} has an unknown evidence level ${level}`,
      );
});

test("the matrix records exactly one fallback", () => {
  assert.equal(FIRMWARE_PROFILES.filter((entry) => entry.fallback).length, 1);
});
