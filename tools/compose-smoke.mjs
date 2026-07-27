// End-to-end smoke test for the running compose stack.
//
// Speaks the same WebSocket path a browser does — through the web container's
// /bridge proxy — so it exercises the proxy, the bridge's origin/token check and
// the bridge's message handling together.
//
// It only ever sends READ-ONLY / locally-answered messages. It never sends dim,
// switch, scene or sync: pointing this at a real installation must not change
// any light or any controller state.
//
// Usage: node tools/compose-smoke.mjs [http://127.0.0.1:3000]
//        CONTROLLER_HOST/CONTROLLER_PORT/CONTROLLER_KEY to also attempt a
//        controller connect + status read (still no writes).

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const base = new URL(process.argv[2] || "http://127.0.0.1:3000");
const results = [];
let failures = 0;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  if (payload.length < 126)
    return Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      masked,
    ]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 0xfe;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, mask, masked]);
}

function decode(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const length0 = buffer[offset + 1] & 0x7f;
    let length = length0;
    let cursor = offset + 2;
    if (length0 === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length0 === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (cursor + length > buffer.length) break;
    if ((buffer[offset] & 0x0f) === 1)
      messages.push(buffer.subarray(cursor, cursor + length).toString("utf8"));
    offset = cursor + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** Opens the browser's WebSocket path and collects messages for `settleMs`. */
function converse(sends, settleMs = 2500) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket = net.createConnection(
      { host: base.hostname, port: Number(base.port || 80) },
      () => {
        socket.write(
          [
            "GET /bridge HTTP/1.1",
            `Host: ${base.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            `Origin: ${base.origin}`,
            "\r\n",
          ].join("\r\n"),
        );
      },
    );
    socket.setTimeout(settleMs + 8000, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });

    const expectedAccept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    let upgraded = false;
    // One buffer for the whole stream: the HTTP response and the first frames
    // can arrive in the same chunk, so the split happens here rather than by
    // guessing chunk boundaries.
    let pending = Buffer.alloc(0);
    const received = [];

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const end = pending.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = pending.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) {
          socket.destroy();
          return reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
        }
        if (!head.includes(expectedAccept)) {
          socket.destroy();
          return reject(new Error("bad Sec-WebSocket-Accept"));
        }
        upgraded = true;
        pending = pending.subarray(end + 4);
        for (const value of sends) socket.write(frame(value));
        setTimeout(() => {
          socket.destroy();
          resolve(received);
        }, settleMs);
      }
      const decoded = decode(pending);
      pending = decoded.rest;
      for (const message of decoded.messages) {
        try {
          received.push(JSON.parse(message));
        } catch {
          received.push({ type: "raw", message });
        }
      }
    });
    socket.on("error", reject);
  });
}

const health = await fetch(new URL("/healthz", base)).then(
  (response) => response.status,
  () => 0,
);
record("web container answers /healthz", health === 200, `HTTP ${health}`);

const workspace = await fetch(new URL("/api/workspace", base)).then(
  (response) => response.status,
  () => 0,
);
record(
  "workspace API backed by the /config volume responds",
  workspace === 200,
  `HTTP ${workspace}`,
);

// The bridge greets a new client with its capability profile. This is the
// handshake the UI relies on to know which controls to offer.
const greeting = await converse([], 1200).catch((error) => error);
if (greeting instanceof Error) {
  record("bridge WebSocket upgrade through the web proxy", false, greeting.message);
} else {
  record("bridge WebSocket upgrade through the web proxy", true);
  const status = greeting.find((message) => message.type === "status");
  record(
    "bridge announces it is ready",
    Boolean(status),
    status?.message ?? "no status message",
  );
  const capabilities = greeting.find(
    (message) => message.type === "capabilities",
  );
  record(
    "bridge announces a deny-by-default capability profile",
    Boolean(capabilities?.profile) &&
      capabilities.profile.fullTransfer === false &&
      capabilities.profile.verify === true,
    capabilities?.profile?.id ?? "no profile",
  );
}

// A comparison without a controller must fail locally and must not transmit.
const verify = await converse([{ type: "verify" }], 1500).catch((error) => error);
if (verify instanceof Error) {
  record("verify returns a verifyResult", false, verify.message);
} else {
  const reply = verify.find((message) => message.type === "verifyResult");
  record(
    "verify refuses cleanly when no controller is connected",
    reply?.state === "error" && /not connected/i.test(reply.message ?? ""),
    reply ? reply.state : "no verifyResult",
  );
}

// Writes must be refused by the profile, not attempted. `sync` is the
// destructive one, so it is the one worth proving.
const refusal = await converse([{ type: "sync", data: {} }], 1500).catch(
  (error) => error,
);
if (refusal instanceof Error) {
  record("whole-controller sync is refused", false, refusal.message);
} else {
  const error = refusal.find(
    (message) => message.type === "status" && message.state === "error",
  );
  record(
    "whole-controller sync is refused by the capability profile",
    Boolean(error) && /disabled by controller profile/.test(error.message),
    error?.message?.slice(0, 60) ?? "no refusal",
  );
}

// Optional: attempt the real controller path. Read-only — connect, authenticate
// and listen for passive status. No dim, switch, scene or sync is ever sent.
const host = process.env.CONTROLLER_HOST;
if (host) {
  const conversation = await converse(
    [
      {
        type: "connect",
        host,
        port: Number(process.env.CONTROLLER_PORT || 15273),
        securityCode: process.env.CONTROLLER_KEY || "",
      },
    ],
    6000,
  ).catch((error) => error);
  if (conversation instanceof Error) {
    record("controller connect attempt", false, conversation.message);
  } else {
    const connected = conversation.find(
      (message) => message.type === "status" && message.state === "connected",
    );
    const failed = conversation.find(
      (message) => message.type === "status" && message.state === "error",
    );
    record(
      "controller authenticated (read-only session)",
      Boolean(connected),
      connected?.message ?? failed?.message ?? "no outcome",
    );
    const status = conversation.find(
      (message) => message.type === "channelStatus",
    );
    if (connected)
      record(
        "controller reported passive channel levels",
        Boolean(status),
        status
          ? `${Object.keys(status.levels).length} channels`
          : "no f2 status within the listen window",
      );
  }
} else {
  console.log("• controller connect skipped (set CONTROLLER_HOST to include it)");
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
