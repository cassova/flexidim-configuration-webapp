/**
 * A Scene Controller accepts one control session, and the bridge releases it
 * from the app socket's `close` event. These tests drive a real bridge process
 * to prove that a browser which dies *without* producing that event still gets
 * its controller session released, rather than holding the controller's only
 * control slot for the lifetime of the bridge.
 *
 * The client here is a raw socket that performs the WebSocket handshake by hand
 * precisely so that it does NOT answer pings: a library client would auto-pong
 * and could never reproduce the failure.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const PING_INTERVAL_MS = 150;
const IDLE_TIMEOUT_MS = 450;
const SECURITY_CODE = "0123456789abcdef";

function ephemeralPort() {
  return 17_000 + Number(process.hrtime.bigint() % 2_000n);
}

/** A Scene Controller stand-in that only records session lifecycle. */
async function controllerStub(port) {
  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { closed: false, bytes: 0 };
    sessions.push(session);
    socket.on("data", (chunk) => { session.bytes += chunk.length; });
    socket.on("close", () => { session.closed = true; });
    socket.on("error", () => undefined);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    sessions,
    async stop() {
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

function spawnBridge(port, environment = {}) {
  const child = spawn(process.execPath, ["bridge/server.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_PORT: String(port),
      FLEXIDIM_BRIDGE_TOKEN: "",
      FLEXIDIM_BRIDGE_PING_INTERVAL_MS: String(PING_INTERVAL_MS),
      FLEXIDIM_BRIDGE_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      ...environment,
    },
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

async function waitForOutput(service, pattern, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (pattern.test(service.output())) return;
    if (service.child.exitCode !== null)
      throw new Error(`bridge exited early:\n${service.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`bridge never matched ${pattern}:\n${service.output()}`);
}

async function waitFor(predicate, description, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/**
 * Open a WebSocket by hand. The returned client never answers a ping, which is
 * exactly how a crashed or suspended browser behaves.
 */
async function silentClient(port, { path: requestPath = "/" } = {}) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  socket.write([
    `GET ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n"));
  const [head] = await once(socket, "data");
  const expected = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  assert.match(head.toString("latin1"), /^HTTP\/1\.1 101 /, "expected a WebSocket upgrade");
  assert.ok(
    head.toString("latin1").includes(expected),
    "the bridge must return the RFC 6455 accept value",
  );
  let pings = 0;
  socket.on("data", (chunk) => {
    for (let index = 0; index + 1 < chunk.length; index += 1)
      if (chunk[index] === 0x89) pings += 1;
  });
  return {
    socket,
    pings: () => pings,
    send(value) {
      const payload = Buffer.from(JSON.stringify(value));
      const mask = randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([
        Buffer.from([0x81, 0x80 | payload.length]),
        mask,
        masked,
      ]));
    },
  };
}

test("an unresponsive app client has its Scene Controller session released", async (t) => {
  const controllerPort = ephemeralPort();
  const bridgePort = controllerPort + 1;
  let controller;
  try {
    controller = await controllerStub(controllerPort);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }
  const bridge = spawnBridge(bridgePort);
  t.after(async () => { await bridge.stop(); await controller.stop(); });
  await waitForOutput(bridge, /FlexiDim local bridge ready/);

  const client = await silentClient(bridgePort);
  await waitForOutput(bridge, /● app client connected/);
  client.send({
    type: "connect",
    host: "127.0.0.1",
    port: controllerPort,
    securityCode: SECURITY_CODE,
  });

  await waitFor(() => controller.sessions.length === 1, "the controller session to open");
  await waitFor(() => controller.sessions[0].bytes >= 23, "the authentication record");
  assert.equal(controller.sessions[0].closed, false);

  // The client is alive at TCP level but answers nothing. Before the fix the
  // bridge had no way to notice, and this session stayed open indefinitely.
  await waitForOutput(bridge, /app client unresponsive for \d+ms; releasing its Scene Controller session/);
  const elapsed = await waitFor(
    () => controller.sessions[0].closed,
    "the controller session to be released",
  );
  assert.ok(client.pings() >= 1, "the bridge should have pinged before giving up");
  assert.ok(
    elapsed < 4_000,
    `the controller session should be released promptly, took ${elapsed}ms`,
  );
  // Reaping must go through the ordinary disconnect path, not a special case.
  assert.match(bridge.output(), /○ app client disconnected/);
  assert.equal(controller.sessions.length, 1, "no reconnect attempt was made");
});

test("a client that answers pings keeps its Scene Controller session", async (t) => {
  const controllerPort = ephemeralPort() + 40;
  const bridgePort = controllerPort + 1;
  let controller;
  try {
    controller = await controllerStub(controllerPort);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }
  const bridge = spawnBridge(bridgePort);
  t.after(async () => { await bridge.stop(); await controller.stop(); });
  await waitForOutput(bridge, /FlexiDim local bridge ready/);

  const client = await silentClient(bridgePort);
  // Answer every ping with a masked pong, the way a browser does.
  client.socket.on("data", (chunk) => {
    for (let index = 0; index + 1 < chunk.length; index += 1) {
      if (chunk[index] !== 0x89) continue;
      const mask = randomBytes(4);
      client.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), mask]));
    }
  });
  client.send({
    type: "connect",
    host: "127.0.0.1",
    port: controllerPort,
    securityCode: SECURITY_CODE,
  });
  await waitFor(() => controller.sessions.length === 1, "the controller session to open");

  // Well past the idle timeout: a healthy client must survive indefinitely.
  await new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS * 6));
  assert.equal(
    controller.sessions[0].closed,
    false,
    "a client answering pings must never be reaped",
  );
  assert.doesNotMatch(bridge.output(), /app client unresponsive/);
  assert.ok(client.pings() >= 2, "the heartbeat should have pinged repeatedly");
});

/**
 * `http.Server` creates connections with `allowHalfOpen: true`, so a bare FIN
 * raises `end` and never `close`. The controller session is released from the
 * `close` handler, so without completing the half-close the bridge held the
 * controller for a client that had already hung up — and it is reachable
 * through ordinary means: an intermediary that closes at the TCP layer, or the
 * web host's own proxy teardown, both send a FIN without a close frame.
 */
test("a bare FIN with no close frame still releases the Scene Controller session", async (t) => {
  const controllerPort = ephemeralPort() + 120;
  const bridgePort = controllerPort + 1;
  let controller;
  try {
    controller = await controllerStub(controllerPort);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }
  // Long heartbeat windows, so only the half-close handling can release this.
  const bridge = spawnBridge(bridgePort, {
    FLEXIDIM_BRIDGE_PING_INTERVAL_MS: "60000",
    FLEXIDIM_BRIDGE_IDLE_TIMEOUT_MS: "300000",
  });
  t.after(async () => { await bridge.stop(); await controller.stop(); });
  await waitForOutput(bridge, /FlexiDim local bridge ready/);

  const client = await silentClient(bridgePort);
  client.send({
    type: "connect",
    host: "127.0.0.1",
    port: controllerPort,
    securityCode: SECURITY_CODE,
  });
  await waitFor(() => controller.sessions.length === 1, "the controller session to open");
  assert.equal(controller.sessions[0].closed, false);

  // A FIN and nothing else: no WebSocket close frame, no reset.
  client.socket.end();
  const elapsed = await waitFor(
    () => controller.sessions[0].closed,
    "the controller session to be released after a bare FIN",
  );
  assert.ok(elapsed < 4_000, `release took ${elapsed}ms`);
  assert.match(bridge.output(), /○ app client disconnected/);
});

test("a client ping is answered so a browser-initiated heartbeat also works", async (t) => {
  const bridgePort = ephemeralPort() + 80;
  const bridge = spawnBridge(bridgePort, {
    // Long enough that nothing is reaped during this test.
    FLEXIDIM_BRIDGE_PING_INTERVAL_MS: "10000",
    FLEXIDIM_BRIDGE_IDLE_TIMEOUT_MS: "30000",
  });
  t.after(async () => { await bridge.stop(); });
  try {
    await waitForOutput(bridge, /FlexiDim local bridge ready/);
  } catch (error) {
    if (/EPERM|EACCES/.test(bridge.output())) {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }

  const socket = net.createConnection({ host: "127.0.0.1", port: bridgePort });
  socket.on("error", () => undefined);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  socket.write([
    "GET / HTTP/1.1",
    `Host: 127.0.0.1:${bridgePort}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n"));
  await once(socket, "data");

  const pongs = [];
  socket.on("data", (chunk) => {
    for (let index = 0; index + 1 < chunk.length; index += 1)
      if (chunk[index] === 0x8a) pongs.push(chunk.subarray(index + 2, index + 2 + chunk[index + 1]));
  });
  // A masked client ping carrying a payload the pong must echo verbatim.
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const body = Buffer.from([0xde, 0xad]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([Buffer.from([0x89, 0x82]), mask, masked]));

  await waitFor(() => pongs.length >= 1, "a pong answering the client ping");
  assert.deepEqual([...pongs[0]], [0xde, 0xad], "the pong must echo the ping payload");
});
