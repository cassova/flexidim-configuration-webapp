#!/usr/bin/env node
// Minimal FlexiDim TCP probe. It deliberately bypasses the web app and bridge
// so one frame, one socket, and the resulting close/reply can be inspected.
//
// Safe default (connect only):
//   node tools/controller-probe.mjs 192.168.1.50
// Explicit commands:
//   node tools/controller-probe.mjs 192.168.1.50 --dim 9 50 0
//   node tools/controller-probe.mjs 192.168.1.50 --switch 63 4
//   node tools/controller-probe.mjs 192.168.1.50 --dims 17:100:1,1:100:1

import net from "node:net";
import fs from "node:fs";
import { parse } from "@plist/binary.parse";
import { packet } from "../bridge/protocol.mjs";
import { authenticationRecord } from "../bridge/session.mjs";

const args = process.argv.slice(2);
const host = args.shift();
if (!host || host === "--help") {
  console.error("Usage: node tools/controller-probe.mjs HOST [--key 16-CHAR-CODE | --config FILE] [--port PORT] [--dim CHANNEL LEVEL TRANSITION | --dims CH:LEVEL:FADE,... | --switch SWITCH BUTTON] [--watch MS] [--verbose]");
  process.exit(host ? 0 : 1);
}

function option(name, count) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const values = args.slice(index + 1, index + 1 + count).map(Number);
  if (values.length !== count || values.some((value) => !Number.isFinite(value))) {
    console.error(`${name} needs ${count} numeric argument${count === 1 ? "" : "s"}`);
    process.exit(1);
  }
  return values;
}

const [port = 15273] = option("--port", 1) ?? [];
const watchOption = option("--watch", 1);
const dim = option("--dim", 3);
const wallSwitch = option("--switch", 2);
const stringOption = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const configPath = stringOption("--config");
let securityCode = stringOption("--key");
if (configPath) {
  const file = fs.readFileSync(configPath);
  const archive = parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const uid = archive?.$top?.$10?.CF$UID ?? archive?.$top?.$10?.UID;
  securityCode = typeof uid === "number" ? archive.$objects?.[uid] : archive?.$top?.$10;
  if (typeof securityCode !== "string") {
    console.error("Could not read the site security code from --config");
    process.exit(1);
  }
}
const dimsIndex = args.indexOf("--dims");
const dims = dimsIndex < 0
  ? undefined
  : String(args[dimsIndex + 1] ?? "").split(",").map((entry) => entry.split(":").map(Number));
if (dims?.some((entry) => entry.length !== 3 || entry.some((value) => !Number.isFinite(value)))) {
  console.error("--dims needs comma-separated CHANNEL:LEVEL:TRANSITION entries");
  process.exit(1);
}
if ([dim, dims, wallSwitch].filter(Boolean).length > 1) {
  console.error("Choose one of --dim, --dims, or --switch");
  process.exit(1);
}

const frames = dim
  ? [packet(0x04, dim)]
  : dims
    ? dims.map((values) => packet(0x04, values))
  : wallSwitch
    ? [packet(0x00, [...wallSwitch, 0])]
    : [];
const watchMs = watchOption?.[0] ?? (frames.length ? 1000 : 5000);
const verbose = args.includes("--verbose");
if (frames.length && !securityCode) {
  console.error("Controller commands require --key or --config because iOS authenticates before sending them");
  process.exit(1);
}
const hex = (bytes) => bytes.toString("hex").match(/.{1,2}/g)?.join(" ") ?? "(empty)";
const started = Date.now();
let sentAt;
let ended = false;
let suppressedStatusPackets = 0;
const socket = net.createConnection({ host, port, timeout: 7000 });

socket.on("connect", () => {
  socket.setTimeout(0);
  console.log(`connected ${host}:${port} after ${Date.now() - started}ms`);
  const sendCommands = () => {
    if (frames.length) {
      sentAt = Date.now();
      for (const frame of frames) {
        console.log(`TX [${hex(frame)}]`);
        socket.write(frame);
      }
      console.log(`collecting replies for ${watchMs}ms, then closing locally`);
    } else if (!securityCode) {
      console.log("connect-only probe; no application bytes sent");
    }
    setTimeout(() => {
      if (ended) return;
      if (suppressedStatusPackets) console.log(`RX status/heartbeat packets suppressed: ${suppressedStatusPackets}`);
      console.log(`still connected after ${watchMs}ms; closing probe locally`);
      // The controller continuously streams status packets and may not answer a
      // TCP half-close, so end() can leave this diagnostic process alive.
      socket.destroy();
    }, watchMs);
  };
  if (securityCode) {
    const login = authenticationRecord(securityCode);
    console.log(`TX AUTH [16-byte key redacted ${login.subarray(16, 22).toString("ascii")} ff]`);
    // Keep authentication and the first command as distinct writes while
    // debugging. In normal iOS use a human action naturally supplies this gap.
    socket.write(login, () => setTimeout(sendCommands, 100));
  } else {
    sendCommands();
  }
});
socket.on("data", (data) => {
  if (!verbose && data.length === 4 && data[0] === 0xf2) {
    suppressedStatusPackets += 1;
    return;
  }
  console.log(`RX +${sentAt ? Date.now() - sentAt : Date.now() - started}ms [${hex(data)}]`);
});
socket.on("timeout", () => {
  console.error("connection attempt timed out");
  socket.destroy();
});
socket.on("error", (error) => console.error(`socket error ${error.code ?? ""}: ${error.message}`));
socket.on("close", (hadError) => {
  ended = true;
  const after = sentAt ? `${Date.now() - sentAt}ms after TX` : `${Date.now() - started}ms after connect start`;
  console.log(`closed ${after}${hadError ? " (after socket error)" : ""}`);
});
