// Passive controller-record capture.
//
// Opens ONE authenticated session, listens, and writes down every record type
// the controller emits unsolicited. It sends NOTHING after the authentication
// record — no dim, switch, scene, verify or sync — so it cannot change a light
// or any controller state. This is the "read a status" case.
//
// Usage:
//   CONTROLLER_HOST=… CONTROLLER_PORT=15273 CONTROLLER_KEY=… \
//     node tools/capture-records.mjs [seconds] [outfile]
//
// The summary deliberately reports record TYPES and counts, never addresses or
// levels tied to a real site, so its output is safe to quote.

import net from "node:net";
import { writeFileSync } from "node:fs";
import { authenticationRecord } from "../bridge/session.mjs";

const host = process.env.CONTROLLER_HOST;
const port = Number(process.env.CONTROLLER_PORT || 15273);
const key = process.env.CONTROLLER_KEY || "";
const seconds = Number(process.argv[2] || 45);
const outfile = process.argv[3];

if (!host) {
  console.error("CONTROLLER_HOST is required");
  process.exit(2);
}

/** Known record lengths. Anything else is captured verbatim as unknown. */
const LENGTH_BY_TYPE = { 0xf2: 4, 0xf4: 5, 0xf5: 5 };

const counts = new Map();
const unknown = [];
const samples = new Map();
let bytesSeen = 0;
let checkFailures = 0;

/** Seven-bit additive check over the preceding bytes. */
const additiveCheck = (record) =>
  record.subarray(0, -1).reduce((sum, byte) => (sum + byte) & 0x7f, 0);

function consume(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const type = buffer[offset];
    const length = LENGTH_BY_TYPE[type];
    if (!length) {
      // An unrecognised record shape. Record one sample and resynchronise on the
      // next byte that could start a known record.
      let next = offset + 1;
      while (next < buffer.length && !LENGTH_BY_TYPE[buffer[next]]) next += 1;
      const blob = buffer.subarray(offset, next);
      if (blob.length && unknown.length < 40) unknown.push(blob.toString("hex"));
      counts.set("unknown", (counts.get("unknown") ?? 0) + 1);
      offset = next;
      continue;
    }
    if (offset + length > buffer.length) break;
    const record = buffer.subarray(offset, offset + length);
    const name = `0x${type.toString(16)}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (record.at(-1) !== additiveCheck(record)) checkFailures += 1;
    if (!samples.has(name)) samples.set(name, record.toString("hex"));
    offset += length;
  }
  return buffer.subarray(offset);
}

const socket = net.createConnection({ host, port, timeout: 10000 });
let pending = Buffer.alloc(0);

socket.on("connect", () => {
  socket.setTimeout(0);
  socket.write(authenticationRecord(key));
  console.log(`authenticated; listening passively for ${seconds}s (sending nothing)`);
});

socket.on("data", (chunk) => {
  bytesSeen += chunk.length;
  pending = consume(Buffer.concat([pending, chunk]));
});

socket.on("timeout", () => {
  console.error("connection timed out");
  socket.destroy();
});
socket.on("error", (error) => {
  console.error(`connection failed: ${error.code || error.message}`);
  process.exit(1);
});

setTimeout(() => {
  socket.destroy();
  const summary = {
    listenedSeconds: seconds,
    bytesSeen,
    recordCounts: Object.fromEntries([...counts.entries()].sort()),
    checkFailures,
    // Sample records are byte-level protocol shapes. 0xf2 carries a channel
    // address and level, so its sample is withheld; the others do not.
    samples: Object.fromEntries(
      [...samples.entries()].filter(([name]) => name !== "0xf2"),
    ),
    unknownSamples: unknown,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (outfile) writeFileSync(outfile, JSON.stringify(summary, null, 2));
  process.exit(0);
}, seconds * 1000);
