// The bridge tells the app when a connected controller stops reporting normal
// status. Normal = the ordinary f2 channel scan; not normal = f3 records, which
// the controller emits while it is suspended or resetting after a transfer.
// This drives the real bridge against a tiny in-process controller so the whole
// path — parse f3 -> emit controllerStatus -> and back to normal on f2 — is
// covered end to end.

import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/**
 * Ask the OS for a free port rather than guessing one. Fixed ranges collide with
 * the other socket tests when the whole suite runs in one process.
 */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function spawnBridge(port) {
  const child = spawn(process.execPath, [path.join(root, "bridge", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      FLEXIDIM_BRIDGE_PORT: String(port),
      FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return {
    output: () => output,
    async ready() {
      const started = Date.now();
      while (Date.now() - started < 8_000) {
        if (/bridge ready/.test(output)) return;
        if (child.exitCode !== null) throw new Error(`bridge exited:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`bridge did not start:\n${output}`);
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    },
  };
}

/** An inbox that lets a test await the next message matching a predicate. */
function inbox(socket) {
  const queue = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const index = waiters.findIndex(({ predicate }) => predicate(value));
    if (index >= 0) {
      const [{ resolve, timer }] = waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(value);
    } else queue.push(value);
  });
  return {
    next(predicate, timeout = 8_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({
          predicate,
          resolve,
          timer: setTimeout(
            () => reject(new Error("timed out waiting for bridge message")),
            timeout,
          ),
        });
      });
    },
  };
}

const F3 = Buffer.from([0xf3, 0x0e, 0x0c, 0x0d]);
const F2 = Buffer.from([0xf2, 0x03, 0x00, (0xf2 + 0x03 + 0x00) & 0x7f]);

test("the bridge reports connected-but-not-normal on f3 and recovers on f2", async () => {
  const bridgePort = await freePort();
  let controllerConn;
  const controller = net.createServer((conn) => {
    controllerConn = conn;
    // The bridge marks the session authenticated as soon as it writes its login
    // record, so the controller need only accept the connection.
    conn.on("data", () => undefined);
    conn.on("error", () => undefined);
  });
  await new Promise((resolve) => controller.listen(0, "127.0.0.1", resolve));
  const controllerPort = controller.address().port;

  const bridge = spawnBridge(bridgePort);
  let socket;
  try {
    await bridge.ready();
    socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
    await once(socket, "open");
    const box = inbox(socket);
    socket.send(
      JSON.stringify({
        type: "connect",
        host: "127.0.0.1",
        port: controllerPort,
        securityCode: "EMULATORKEY01234",
      }),
    );
    await box.next((value) => value.type === "status" && value.state === "connected");
    assert.ok(controllerConn, "the controller received the bridge connection");

    // Suspended/resetting: the controller emits f3 instead of the f2 scan.
    controllerConn.write(F3);
    const abnormal = await box.next((value) => value.type === "controllerStatus");
    assert.equal(abnormal.normalStatus, false);
    assert.match(abnormal.message, /not reporting normal status/);

    // Back to normal: the ordinary f2 scan resumes.
    controllerConn.write(F2);
    const normal = await box.next(
      (value) => value.type === "controllerStatus" && value.normalStatus === true,
    );
    assert.equal(normal.normalStatus, true);
  } finally {
    if (socket && socket.readyState === socket.OPEN) socket.close();
    await bridge.stop();
    await new Promise((resolve) => controller.close(resolve));
  }
});
