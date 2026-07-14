import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { discoverController } from "./discovery.mjs";
import { packet } from "./protocol.mjs";

const BRIDGE_PORT = Number(process.env.FLEXIDIM_BRIDGE_PORT || 8765);
const sockets = new Set();
const controllers = new Map();

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function emit(ws, value) { if (!ws.destroyed) ws.write(websocketFrame(value)); }

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
  if (!controller || controller.destroyed || !controller.writable) return emit(ws, { type: "status", state: "error", message: "Scene Controller is not connected" });
  controller.write(bytes);
  emit(ws, { type: "trace", message: `${label} · ${bytes.toString("hex").match(/.{1,2}/g).join(" ")}` });
}

function connectController(ws, host, port) {
    controllers.get(ws)?.destroy();
    if (!/^([a-z\d-]+\.)*[a-z\d-]+$|^\d{1,3}(\.\d{1,3}){3}$/i.test(host)) return emit(ws, { type: "status", state: "error", message: "Enter a valid Scene Controller address" });
    emit(ws, { type: "status", state: "connecting", message: `Connecting to ${host}:${port}` });
    let connected = false; let failed = false;
    const controller = net.createConnection({ host, port, timeout: 7000 }); controllers.set(ws, controller);
    controller.on("connect", () => {
      // The timeout above is for establishing the TCP connection only. Leaving it
      // enabled disconnects a healthy but idle controller seven seconds later.
      controller.setTimeout(0);
      connected = true;
      emit(ws, { type: "status", state: "connected", message: `Connected to Scene Controller at ${host}:${port}` });
    });
    controller.on("data", (data) => emit(ws, { type: "trace", message: `Controller reply · ${data.toString("hex").match(/.{1,2}/g).join(" ")}` }));
    controller.on("timeout", () => { failed = true; controller.destroy(); emit(ws, { type: "status", state: "error", message: "Scene Controller connection timed out" }); });
    controller.on("error", (error) => { failed = true; emit(ws, { type: "status", state: "error", message: `Controller connection failed: ${error.message}` }); });
    controller.on("close", () => { if (!ws.destroyed && connected && !failed) emit(ws, { type: "status", state: "bridge", message: "Scene Controller disconnected" }); });
}

function handleMessage(ws, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return emit(ws, { type: "status", state: "error", message: "Invalid bridge message" }); }
  if (message.type === "connect") {
    connectController(ws, String(message.host || ""), Number(message.port || 15273));
    return;
  }
  if (message.type === "discover") {
    const port = Number(message.port || 15273);
    emit(ws, { type: "status", state: "discovering", message: `Searching the local network for a FlexiDim controller on port ${port}…` });
    discoverController({ preferredHost: String(message.host || ""), port }).then((host) => {
      if (ws.destroyed) return;
      if (!host) return emit(ws, { type: "status", state: "error", message: `No FlexiDim controller was found on this local network at port ${port}` });
      emit(ws, { type: "discovered", host, port });
      connectController(ws, host, port);
    }).catch((error) => emit(ws, { type: "status", state: "error", message: `Controller discovery failed: ${error.message}` }));
    return;
  }
  if (message.type === "dim") writeController(ws, packet(0x04, [message.channel, message.level, message.transition]), `Channel ${message.channel} → ${message.level}%`);
  else if (message.type === "switch") writeController(ws, packet(0x00, [message.switch, message.button]), `Switch ${message.switch}, button ${message.button}`);
  else if (message.type === "scene") for (const [channel, level] of Object.entries(message.levels || {})) writeController(ws, packet(0x04, [channel, level, message.transition]), `Scene channel ${channel} → ${level}%`);
  else if (message.type === "periodFlags") writeController(ws, packet(0x05), "Request period flags");
  else if (message.type === "sync") emit(ws, { type: "status", state: "error", message: "Full configuration transfer needs a verified controller-specific binary profile; live commands are unaffected" });
}

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ service: "FlexiDim local bridge", status: "ready", port: BRIDGE_PORT }));
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"]; if (!key) return socket.destroy();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "\r\n"].join("\r\n"));
  sockets.add(socket); let pending = Buffer.alloc(0); emit(socket, { type: "status", state: "bridge", message: "Local FlexiDim bridge ready" });
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const decoded = decodeFrames(pending); pending = decoded.rest;
    for (const message of decoded.messages) handleMessage(socket, message);
    if (decoded.closeRequested && !socket.destroyed) {
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
    }
  });
  socket.on("close", () => { sockets.delete(socket); controllers.get(socket)?.destroy(); controllers.delete(socket); });
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

server.listen(BRIDGE_PORT, "127.0.0.1", () => console.log(`FlexiDim local bridge ready at ws://127.0.0.1:${BRIDGE_PORT}`));
function shutdown() { for (const socket of sockets) socket.destroy(); for (const controller of controllers.values()) controller.destroy(); server.close(); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
