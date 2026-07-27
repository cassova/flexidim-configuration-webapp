import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc16X25 } from "../bridge/protocol.mjs";
import { unescapeFrame } from "../tools/oracle/transfer-prefix-emulator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const fixtures = path.join(root, "tools", "oracle", "fixtures");
const oraclePath = path.join(fixtures, "transfer-oracle-wire.json");
const image = fs.readFileSync(path.join(fixtures, "transfer-oracle-image.bin"));
const wire = JSON.parse(fs.readFileSync(oraclePath, "utf8"))
  .map((value) => Buffer.from(value, "hex"));
const userPayloads = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "transfer-oracle-user-payloads.json"),
    "utf8",
  ),
).map((value) => Buffer.from(value, "base64"));
const fromBcd = (value) => ((value >>> 4) & 0x0f) * 10 + (value & 0x0f);
const capturedTime = unescapeFrame(wire[0]);
const capturedDate = unescapeFrame(wire[1]);
const clock = {
  year: 2000 + fromBcd(capturedDate[2]),
  month: fromBcd(capturedDate[4]),
  day: fromBcd(capturedDate[5]),
  weekday: capturedDate[3],
  hour: fromBcd(capturedTime[5] & ~0x40),
  minute: fromBcd(capturedTime[4]),
  second: fromBcd(capturedTime[3]),
  dst: Boolean(capturedTime[5] & 0x40),
};
const imageChecksum = crc16X25(image).toString(16).padStart(4, "0");

function ephemeralPort() {
  return 16_000 + Number(process.hrtime.bigint() % 2_000n);
}

function spawnService(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    },
  };
}

async function waitFor(service, pattern, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (pattern.test(service.output())) return;
    if (service.child.exitCode !== null)
      throw new Error(`service exited early:\n${service.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`service did not become ready:\n${service.output()}`);
}

function messages(socket) {
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const index = waiters.findIndex(({ predicate }) => predicate(value));
    if (index >= 0) {
      const [{ resolve, timer }] = waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(value);
    } else {
      queue.push(value);
    }
  });
  return {
    next(predicate, timeout = 12_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const item = {
          predicate,
          resolve,
          timer: setTimeout(
            () => reject(new Error("timed out waiting for bridge message")),
            timeout,
          ),
        };
        waiters.push(item);
      });
    },
  };
}

test("the live bridge follows the complete iOS oracle through reset and reconnect", async () => {
  const controllerPort = ephemeralPort();
  const bridgePort = ephemeralPort();
  const auditDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "flexidim-live-transfer-"),
  );
  const controller = spawnService(
    path.join(root, "tools", "controller-emulator.mjs"),
    {
      FLEXIDIM_CONTROLLER_PORT: String(controllerPort),
      FLEXIDIM_DISCOVERY_PORT: "0",
      FLEXIDIM_DISCOVERY_REPLY_PORT: "0",
      FLEXIDIM_SCAN_INTERVAL_MS: "50",
      FLEXIDIM_EMULATED_CHANNELS: "8",
      FLEXIDIM_RESET_DELAY_MS: "25",
      FLEXIDIM_EMULATED_CRC: imageChecksum,
      FLEXIDIM_TRANSFER_ORACLE_PATH: oraclePath,
    },
  );
  const bridge = spawnService(path.join(root, "bridge", "server.mjs"), {
    FLEXIDIM_BRIDGE_PORT: String(bridgePort),
    FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
    FLEXIDIM_TRANSFER_AUDIT_PATH: path.join(auditDirectory, "audit.jsonl"),
  });
  let socket;
  try {
    await waitFor(controller, /TCP listening/);
    await waitFor(bridge, /bridge ready/);
    socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
    await once(socket, "open");
    const inbox = messages(socket);
    const send = (value) => socket.send(JSON.stringify(value));

    send({
      type: "connect",
      host: "127.0.0.1",
      port: controllerPort,
      securityCode: "EMULATORKEY01234",
    });
    await inbox.next(
      (value) => value.type === "status" && value.state === "connected",
    );

    send({ type: "verify", localChecksum: imageChecksum });
    const comparison = await inbox.next(
      (value) => value.type === "verifyResult",
    );
    assert.equal(comparison.state, "match");
    assert.equal(comparison.controllerChecksum, imageChecksum);

    const request = {
      imageBase64: image.toString("base64"),
      imageChecksum,
      userPayloadsBase64: userPayloads.map((value) => value.toString("base64")),
      clock,
      siteType: 0,
      firmwareProfile: "type-0-live-only",
    };
    send({ type: "transferDryRun", ...request });
    const preflight = await inbox.next(
      (value) => value.type === "transferPreflight",
    );
    assert.equal(preflight.state, "passed");
    assert.equal(preflight.frameCount, wire.length);

    send({ type: "sync", confirm: "Continue", ...request });
    let result;
    try {
      result = await inbox.next(
        (value) => value.type === "transferResult",
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nBRIDGE:\n${bridge.output()}\nCONTROLLER:\n${controller.output()}`,
      );
    }
    assert.equal(
      result.state,
      "completed",
      `${JSON.stringify(result)}\nBRIDGE:\n${bridge.output()}\nCONTROLLER:\n${controller.output()}`,
    );
    assert.equal(result.outcome, "completed");
    assert.equal(result.frameCount, wire.length);
    assert.match(result.message, /Download completed successfully/);
    assert.match(controller.output(), /exact iOS-oracle transfer accepted/);

    const audit = fs.readFileSync(
      path.join(auditDirectory, "audit.jsonl"),
      "utf8",
    );
    assert.match(audit, /live-transfer-started/);
    assert.match(audit, /live-transfer-finished/);
    assert.doesNotMatch(audit, /imageBase64|userPayload|securityCode/);
  } finally {
    socket?.close();
    await bridge.stop();
    await controller.stop();
  }
});
