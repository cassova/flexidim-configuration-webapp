import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null)
      throw new Error(`Service exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The service can refuse connections while Node is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForExit(child, timeout = 2000) {
  if (child.exitCode != null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Service did not stop before the shutdown deadline")),
      timeout,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("Compose builds and starts both private bridge and persistent web services", async () => {
  const compose = await readFile("compose.yaml", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(compose, /flexidim-web:/);
  assert.match(compose, /flexidim-bridge:/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /FLEXIDIM_BRIDGE_UPSTREAM_HOST: flexidim-bridge/);
  assert.doesNotMatch(compose, /8765:8765/);
  assert.match(compose, /flexidim-config:\/config/);
  assert.match(compose, /FLEXIDIM_TRANSFER_AUDIT_PATH: \/config\/transfer-audit\.jsonl/);
  assert.equal(
    (compose.match(/- flexidim-config:\/config/g) ?? []).length,
    2,
    "both services must reuse the same named volume; neither may create an anonymous one",
  );
  assert.match(
    dockerfile,
    /COPY (?:--chown=node:node )?--from=build \/app\/bridge \.\/bridge/,
  );
  // The image must default to the all-in-one supervisor so a plain
  // `docker run` deploys everything, while each compose service must pin its
  // own single process instead of inheriting that default.
  assert.match(dockerfile, /CMD \["node", "server\/start-all\.mjs"\]/);
  assert.match(compose, /command: \["node", "server\/host\.mjs"\]/);
  assert.match(compose, /command: \["node", "bridge\/server\.mjs"\]/);
});

test("the all-in-one launcher runs both services and stops cleanly", async (t) => {
  let bridgePort;
  let webPort;
  try {
    bridgePort = await unusedPort();
    webPort = await unusedPort();
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }
  const configDirectory = await mkdtemp(join(tmpdir(), "flexidim-all-"));
  const launcher = spawn(process.execPath, ["server/start-all.mjs"], {
    stdio: "pipe",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(webPort),
      CONFIG_DIR: configDirectory,
      FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_PORT: String(bridgePort),
      FLEXIDIM_BRIDGE_UPSTREAM_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_UPSTREAM_PORT: String(bridgePort),
    },
  });
  t.after(async () => {
    launcher.kill("SIGKILL");
    await rm(configDirectory, { recursive: true, force: true });
  });

  await waitForHttp(`http://127.0.0.1:${webPort}/api/workspace`, launcher);
  // The bridge must be reachable through the web proxy without any upstream
  // configuration beyond the shared port, exactly as inside the container.
  const firstMessage = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${webPort}/bridge`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for the proxied bridge"));
    }, 3000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Proxied bridge WebSocket failed"));
    }, { once: true });
  });
  assert.equal(firstMessage.state, "bridge");

  launcher.kill("SIGTERM");
  const exit = await waitForExit(launcher, 5000);
  assert.deepEqual(exit, { code: 0, signal: null });
});

test("the web server proxies an authenticated bridge WebSocket", async (t) => {
  let bridgePort;
  let webPort;
  try {
    bridgePort = await unusedPort();
    webPort = await unusedPort();
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }
  const configDirectory = await mkdtemp(join(tmpdir(), "flexidim-deploy-"));
  const token = "deployment-test-token";
  const bridge = spawn(process.execPath, ["bridge/server.mjs"], {
    stdio: "pipe",
    env: {
      ...process.env,
      FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_PORT: String(bridgePort),
      FLEXIDIM_BRIDGE_TOKEN: token,
    },
  });
  const web = spawn(process.execPath, ["server/host.mjs"], {
    stdio: "pipe",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(webPort),
      CONFIG_DIR: configDirectory,
      FLEXIDIM_BRIDGE_UPSTREAM_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_UPSTREAM_PORT: String(bridgePort),
      FLEXIDIM_BRIDGE_TOKEN: token,
    },
  });
  t.after(async () => {
    bridge.kill("SIGTERM");
    web.kill("SIGTERM");
    await rm(configDirectory, { recursive: true, force: true });
  });

  await waitForHttp(`http://127.0.0.1:${bridgePort}`, bridge);
  await waitForHttp(`http://127.0.0.1:${webPort}/api/workspace`, web);
  const htmlResponse = await fetch(`http://127.0.0.1:${webPort}/`);
  assert.equal(htmlResponse.headers.get("cache-control"), "no-store");
  const html = await htmlResponse.text();
  const stylesheetPath = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  assert.ok(stylesheetPath, "Rendered HTML should reference a stylesheet");
  const stylesheetResponse = await fetch(
    `http://127.0.0.1:${webPort}${stylesheetPath}`,
  );
  assert.equal(stylesheetResponse.status, 200);
  assert.match(
    stylesheetResponse.headers.get("content-type") || "",
    /^text\/css/,
  );
  assert.ok((await stylesheetResponse.text()).length > 1000);
  const workerResponse = await fetch(`http://127.0.0.1:${webPort}/sw.js`);
  assert.equal(workerResponse.status, 200);
  assert.equal(workerResponse.headers.get("cache-control"), "no-store");
  const firstMessage = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${webPort}/bridge`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for the proxied bridge"));
    }, 3000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Proxied bridge WebSocket failed"));
    }, { once: true });
  });
  assert.deepEqual(firstMessage, {
    type: "status",
    state: "bridge",
    message: "Local FlexiDim bridge ready",
  });

  const rejected = await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: webPort,
    });
    socket.setEncoding("utf8");
    let response = "";
    socket.on("connect", () => {
      socket.write([
        "GET /bridge HTTP/1.1",
        `Host: 127.0.0.1:${webPort}`,
        "Origin: https://untrusted.example",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
  assert.match(rejected, /^HTTP\/1\.1 403 Forbidden/);

  const heldSocket = new WebSocket(`ws://127.0.0.1:${webPort}/bridge`);
  await new Promise((resolve, reject) => {
    heldSocket.addEventListener("open", resolve, { once: true });
    heldSocket.addEventListener("error", reject, { once: true });
  });
  const shutdownStarted = Date.now();
  web.kill("SIGTERM");
  const webExit = await waitForExit(web);
  bridge.kill("SIGTERM");
  const bridgeExit = await waitForExit(bridge);
  assert.deepEqual(webExit, { code: 0, signal: null });
  assert.deepEqual(bridgeExit, { code: 0, signal: null });
  assert.ok(Date.now() - shutdownStarted < 2000);
});

/**
 * An abruptly reset browser socket emits `error` and `close` but never `end`,
 * and `pipe` forwards only `end`. Without an explicit teardown the proxy left
 * the upstream bridge socket connected, so the bridge kept holding the Scene
 * Controller's single control session for a client that no longer existed.
 *
 * The bridge heartbeat is configured far longer than this test runs, so a
 * prompt release can only be the proxy propagating the disconnect.
 */
test("a reset browser socket releases the proxied controller session", async (t) => {
  const bridgePort = await unusedPort();
  const webPort = await unusedPort();
  const controllerPort = await unusedPort();

  const controllerSessions = [];
  const controller = net.createServer((socket) => {
    const session = { closed: false };
    controllerSessions.push(session);
    // The socket must be read, not merely accepted: a paused stream never
    // reaches EOF, so it would never emit `close` and this test would report a
    // held session no matter how the bridge behaved.
    socket.resume();
    socket.on("close", () => { session.closed = true; });
    socket.on("error", () => undefined);
  });
  try {
    await new Promise((resolve, reject) => {
      controller.once("error", reject);
      controller.listen(controllerPort, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("This environment does not permit local listening sockets");
      return;
    }
    throw error;
  }

  const configDirectory = await mkdtemp(join(tmpdir(), "flexidim-proxy-"));
  const token = "proxy-teardown-token";
  const bridge = spawn(process.execPath, ["bridge/server.mjs"], {
    stdio: "pipe",
    env: {
      ...process.env,
      FLEXIDIM_BRIDGE_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_PORT: String(bridgePort),
      FLEXIDIM_BRIDGE_TOKEN: token,
      // Long enough that the heartbeat cannot be what releases the session.
      FLEXIDIM_BRIDGE_PING_INTERVAL_MS: "60000",
      FLEXIDIM_BRIDGE_IDLE_TIMEOUT_MS: "300000",
    },
  });
  const web = spawn(process.execPath, ["server/host.mjs"], {
    stdio: "pipe",
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(webPort),
      CONFIG_DIR: configDirectory,
      FLEXIDIM_BRIDGE_UPSTREAM_HOST: "127.0.0.1",
      FLEXIDIM_BRIDGE_UPSTREAM_PORT: String(bridgePort),
      FLEXIDIM_BRIDGE_TOKEN: token,
    },
  });
  t.after(async () => {
    bridge.kill("SIGKILL");
    web.kill("SIGKILL");
    await new Promise((resolve) => controller.close(resolve));
    await rm(configDirectory, { recursive: true, force: true });
  });
  await waitForHttp(`http://127.0.0.1:${bridgePort}`, bridge);
  await waitForHttp(`http://127.0.0.1:${webPort}/api/workspace`, web);

  // A hand-rolled client, so the socket carrying the WebSocket session is the
  // one this test resets. A library client hides it and only closes gracefully.
  const client = net.createConnection({ host: "127.0.0.1", port: webPort });
  client.on("error", () => undefined);
  await new Promise((resolve) => client.once("connect", resolve));
  client.write([
    "GET /bridge HTTP/1.1",
    `Host: 127.0.0.1:${webPort}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  const [handshake] = await once(client, "data");
  assert.match(handshake.toString("latin1"), /^HTTP\/1\.1 101 /);

  const request = Buffer.from(JSON.stringify({
    type: "connect",
    host: "127.0.0.1",
    port: controllerPort,
    securityCode: "0123456789abcdef",
  }));
  const mask = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]);
  const masked = Buffer.from(request);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  client.write(Buffer.concat([
    Buffer.from([0x81, 0x80 | request.length]),
    mask,
    masked,
  ]));

  for (let attempt = 0; attempt < 200 && !controllerSessions.length; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(controllerSessions.length, 1, "the controller session should be open");
  assert.equal(controllerSessions[0].closed, false);

  // RST rather than FIN: the client emits `error` and `close` but never `end`,
  // which is precisely what `pipe` does not propagate.
  client.resetAndDestroy();

  const started = Date.now();
  while (Date.now() - started < 8_000 && !controllerSessions[0].closed)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    controllerSessions[0].closed,
    true,
    "the controller session must be released when the browser socket is reset",
  );
  assert.ok(web.exitCode === null, "an ECONNRESET must not take the web host down");
});
