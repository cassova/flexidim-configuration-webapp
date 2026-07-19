import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { discoverController } from "./discovery.mjs";
import { parseControllerReplies } from "./controller-replies.mjs";
import { packet } from "./protocol.mjs";
import { authenticationRecord } from "./session.mjs";
import { capabilityFor, SAFE_LOCAL_PROFILE } from "./controller-capabilities.mjs";

const BRIDGE_PORT = Number(process.env.FLEXIDIM_BRIDGE_PORT || 8765);
const BRIDGE_HOST = String(process.env.FLEXIDIM_BRIDGE_HOST || "127.0.0.1");
const BRIDGE_TOKEN = String(process.env.FLEXIDIM_BRIDGE_TOKEN || "");
const BRIDGE_ORIGINS = String(process.env.FLEXIDIM_BRIDGE_ORIGINS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(BRIDGE_HOST) && !BRIDGE_TOKEN) {
  throw new Error("FLEXIDIM_BRIDGE_TOKEN is required when the bridge binds beyond loopback");
}
const sockets = new Set();
const controllers = new Map();

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
}
const hex = (buffer) =>
  buffer.length ? buffer.toString("hex").match(/.{1,2}/g).join(" ") : "(empty)";

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function emit(ws, value) { if (!ws.destroyed) ws.write(websocketFrame(value)); }

function queueControllerStatus(ws, controller, statuses) {
  controller.flexidimPendingLevels ??= {};
  controller.flexidimKnownLevels ??= new Map();
  controller.flexidimStatusReports ??= 0;
  controller.flexidimStatusChanges ??= 0;
  for (const status of statuses) {
    const previous = controller.flexidimKnownLevels.get(status.channel);
    controller.flexidimKnownLevels.set(status.channel, status.level);
    controller.flexidimPendingLevels[status.channel] = status.level;
    controller.flexidimStatusReports += 1;
    if (previous !== status.level) controller.flexidimStatusChanges += 1;
    if (controller.flexidimStatusReports >= 128) {
      log(`↻ controller status synchronized: 128 channel reports, ${controller.flexidimStatusChanges} level changes`);
      controller.flexidimStatusReports = 0;
      controller.flexidimStatusChanges = 0;
    }
  }
  if (!controller.flexidimStatusTimer) {
    controller.flexidimStatusTimer = setTimeout(() => {
      controller.flexidimStatusTimer = undefined;
      const levels = controller.flexidimPendingLevels;
      controller.flexidimPendingLevels = {};
      if (Object.keys(levels).length) emit(ws, { type: "channelStatus", levels });
    }, 500);
  }
}

function decodeFrames(buffer) {
  const messages = []; let closeRequested = false; let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]; const second = buffer[offset + 1]; let length = second & 0x7f; let cursor = offset + 2;
    if (length === 126) { if (cursor + 2 > buffer.length) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    if (length === 127) { if (cursor + 8 > buffer.length) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
    const masked = Boolean(second & 0x80); let mask;
    if (masked) { if (cursor + 4 > buffer.length) break; mask = buffer.subarray(cursor, cursor + 4); cursor += 4; }
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    const opcode = first & 0x0f;
    if (opcode === 1) messages.push(payload.toString("utf8"));
    else if (opcode === 8) closeRequested = true;
    offset = cursor + length;
  }
  return { messages, closeRequested, rest: buffer.subarray(offset) };
}

function writeController(ws, bytes, label) {
  const controller = controllers.get(ws);
  if (!controller || controller.destroyed || !controller.writable || !controller.flexidimAuthenticated) {
    log(`✗ NOT SENT (controller not connected): ${label}`);
    return emit(ws, { type: "status", state: "error", message: "Scene Controller is not connected" });
  }
  const ok = controller.write(bytes);
  controller.flexidimLastTx = { at: Date.now(), label, bytes: Buffer.from(bytes) };
  log(`→ TX ${label}  [${hex(bytes)}]${ok ? "" : "  (socket buffer full)"}`);
  emit(ws, { type: "trace", message: `${label} · ${hex(bytes)}` });
}

function connectController(ws, host, port, securityCode) {
    controllers.get(ws)?.destroy();
    if (!/^([a-z\d-]+\.)*[a-z\d-]+$|^\d{1,3}(\.\d{1,3}){3}$/i.test(host)) return emit(ws, { type: "status", state: "error", message: "Enter a valid Scene Controller address" });
    log(`connect → ${host}:${port}`);
    emit(ws, { type: "status", state: "connecting", message: `Connecting to ${host}:${port}` });
    let connected = false; let failed = false; let connectedAt = 0;
    const controller = net.createConnection({ host, port, timeout: 7000 }); controllers.set(ws, controller);
    controller.on("connect", () => {
      // The timeout above is for establishing the TCP connection only. Leaving it
      // enabled disconnects a healthy but idle controller seven seconds later.
      controller.setTimeout(0);
      controller.setKeepAlive(true, 3000);
      let login;
      try {
        login = authenticationRecord(securityCode);
      } catch (error) {
        failed = true;
        log(`✗ controller authentication not sent: ${error.message}`);
        emit(ws, { type: "status", state: "error", message: error.message });
        controller.destroy();
        return;
      }
      connected = true;
      connectedAt = Date.now();
      // Recovered from stream0:handleEvent: in the iOS app. A site-type-0
      // session starts with key + six-digit random nonce + 0xff. The app only
      // enters tcpState 3 (command-ready) after writing this record.
      controller.write(login);
      controller.flexidimAuthenticated = true;
      log(`→ TX controller authentication [16-byte key redacted + ${login.subarray(16, 22).toString("ascii")} + ff]`);
      log(`✓ controller authenticated: ${host}:${port}`);
      emit(ws, { type: "trace", message: "Controller authentication sent (security code redacted)" });
      emit(ws, { type: "status", state: "connected", message: `Authenticated with Scene Controller at ${host}:${port}` });
      // Do not add an application-level poll here. The iOS app only emits its
      // period-flag request for encrypted remote sessions, where it is a
      // different, longer frame. Sending a guessed plaintext 0x05 frame to a
      // local controller causes real controllers to terminate the TCP stream.
    });
    controller.on("data", (data) => {
      controller.flexidimRxBuffer = Buffer.concat([controller.flexidimRxBuffer ?? Buffer.alloc(0), data]);
      const replies = parseControllerReplies(controller.flexidimRxBuffer);
      controller.flexidimRxBuffer = Buffer.from(replies.rest);
      if (replies.invalid.length) {
        log(`✗ controller reply integrity check failed [${hex(Buffer.concat(replies.invalid))}]`);
        emit(ws, { type: "trace", message: `Controller reply failed integrity check · ${hex(Buffer.concat(replies.invalid))}` });
      }
      if (replies.statuses.length) queueControllerStatus(ws, controller, replies.statuses);
      if (replies.visible.length) {
        const visible = Buffer.concat(replies.visible);
        log(`← RX controller reply  [${hex(visible)}]`);
        emit(ws, { type: "trace", message: `Controller reply · ${hex(visible)}` });
      }
    });
    controller.on("timeout", () => { failed = true; log(`✗ controller timed out (${host}:${port})`); controller.destroy(); emit(ws, { type: "status", state: "error", message: "Scene Controller connection timed out" }); });
    controller.on("error", (error) => { failed = true; log(`✗ controller error: ${error.code || ""} ${error.message}`); emit(ws, { type: "status", state: "error", message: `Controller connection failed: ${error.message}` }); });
    controller.on("close", (hadError) => {
      if (controller.flexidimStatusTimer) clearTimeout(controller.flexidimStatusTimer);
      const last = controller.flexidimLastTx;
      const age = last ? Date.now() - last.at : undefined;
      const lifetime = connectedAt ? Date.now() - connectedAt : 0;
      const diagnostic = last
        ? `; ${age}ms after TX ${last.label} [${hex(last.bytes)}]`
        : `; no command sent during ${lifetime}ms connection`;
      log(`controller connection closed${hadError ? " (after error)" : ""}${connected ? "" : " (never established)"}${diagnostic}`);
      if (!ws.destroyed && connected && !failed) emit(ws, {
        type: "status",
        state: "bridge",
        message: `Scene Controller disconnected${last ? ` after ${last.label}` : ""}`,
      });
    });
}

function handleMessage(ws, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { log(`✗ invalid message: ${raw}`); return emit(ws, { type: "status", state: "error", message: "Invalid bridge message" }); }
  log(
    `client → ${message.type}` +
      (message.type === "dim" ? ` (ch ${message.channel}, ${message.level}%, t=${message.transition})` : "") +
      (message.type === "switch" ? ` (sw ${message.switch}, btn ${message.button})` : ""),
  );
  if (!capabilityFor(message.type)) {
    return emit(ws, {
      type: "status", state: "error",
      message: `${message.type} is disabled by controller profile ${SAFE_LOCAL_PROFILE.id}; captured protocol evidence and recoverable hardware validation are required`,
    });
  }
  if (message.type === "connect") {
    connectController(ws, String(message.host || ""), Number(message.port || 15273), String(message.securityCode || ""));
    return;
  }
  if (message.type === "discover") {
    const port = Number(message.port || 15273);
    emit(ws, { type: "status", state: "discovering", message: `Searching the local network for a FlexiDim controller on port ${port}…` });
    discoverController({ preferredHost: String(message.host || ""), port }).then((host) => {
      if (ws.destroyed) return;
      if (!host) return emit(ws, { type: "status", state: "error", message: `No FlexiDim controller was found on this local network at port ${port}` });
      emit(ws, { type: "discovered", host, port });
      connectController(ws, host, port, String(message.securityCode || ""));
    }).catch((error) => emit(ws, { type: "status", state: "error", message: `Controller discovery failed: ${error.message}` }));
    return;
  }
  if (message.type === "dim") writeController(ws, packet(0x04, [message.channel, message.level, message.transition]), `Channel ${message.channel} → ${message.level}%`);
  // The app always sends a 6-byte switch body: ff f3 00 <switch> <button> 00.
  // The trailing 0x00 is part of what the controller's CRC/length check expects.
  else if (message.type === "switch") writeController(ws, packet(0x00, [message.switch, message.button, 0]), `Switch ${message.switch}, button ${message.button}`);
  else if (message.type === "scene") for (const [channel, level] of Object.entries(message.levels || {})) writeController(ws, packet(0x04, [channel, level, message.transition]), `Scene channel ${channel} → ${level}%`);
  else if (message.type === "periodFlags") emit(ws, { type: "status", state: "error", message: "Period flags are only available through the iOS encrypted remote-session protocol" });
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && (BRIDGE_ORIGINS.includes(origin) || (LOOPBACK_HOSTS.has(BRIDGE_HOST) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))))
    response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ service: "FlexiDim local bridge", status: "ready", port: BRIDGE_PORT }));
});

server.on("upgrade", (request, socket) => {
  const origin = String(request.headers.origin || "");
  const token = new URL(request.url || "/", "http://bridge.local").searchParams.get("token") || "";
  const originAllowed = !BRIDGE_ORIGINS.length || BRIDGE_ORIGINS.includes(origin) ||
    (LOOPBACK_HOSTS.has(BRIDGE_HOST) && (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
  if (!originAllowed || (BRIDGE_TOKEN && token !== BRIDGE_TOKEN)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const key = request.headers["sec-websocket-key"]; if (!key) return socket.destroy();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "\r\n"].join("\r\n"));
  sockets.add(socket); let pending = Buffer.alloc(0); log("● app client connected"); emit(socket, { type: "status", state: "bridge", message: "Local FlexiDim bridge ready" });
  emit(socket, { type: "capabilities", profile: SAFE_LOCAL_PROFILE });
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const decoded = decodeFrames(pending); pending = decoded.rest;
    for (const message of decoded.messages) handleMessage(socket, message);
    if (decoded.closeRequested && !socket.destroyed) {
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
    }
  });
  socket.on("close", () => { log("○ app client disconnected"); sockets.delete(socket); controllers.get(socket)?.destroy(); controllers.delete(socket); });
  socket.on("error", () => undefined);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`FlexiDim bridge is already running at ws://127.0.0.1:${BRIDGE_PORT}`);
    process.exit(1);
  }
  console.error(`FlexiDim bridge failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => console.log(`FlexiDim local bridge ready at ws://${BRIDGE_HOST}:${BRIDGE_PORT}`));
function shutdown() { for (const socket of sockets) socket.destroy(); for (const controller of controllers.values()) controller.destroy(); server.close(); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
