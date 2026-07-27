// Emulated FlexiDim Scene Controller.
//
// A fake controller that speaks the reverse-engineered protocol so you can
// debug the webapp/bridge with NO hardware: it logs and decodes every frame
// the app sends, verifies the CRC, and answers discovery. Point the bridge's
// controller host at 127.0.0.1.
//
//   node tools/controller-emulator.mjs
//   FLEXIDIM_BRIDGE_PORT unchanged; then in the app connect to 127.0.0.1:15273
//
// This is a debugging surface, not a real controller: it acknowledges frames
// but does not drive lights. Once you capture the REAL controller's replies
// (via tools/flexidim-trace.js on the iPad), fold them into reply() below to
// make the emulator behave like the genuine hardware.

import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import { describe, decodeFrame } from './decode.mjs';
import { TransferPrefixEmulator } from './oracle/transfer-prefix-emulator.mjs';

const TCP_PORT = Number(process.env.FLEXIDIM_CONTROLLER_PORT || 15273);
const DISCOVERY_PORT = Number(process.env.FLEXIDIM_DISCOVERY_PORT || 15270);
const DISCOVERY_REPLY_PORT = Number(
  process.env.FLEXIDIM_DISCOVERY_REPLY_PORT || 15001,
);
const SCAN_INTERVAL_MS = Number(process.env.FLEXIDIM_SCAN_INTERVAL_MS || 1000);
const RESET_DELAY_MS = Number(process.env.FLEXIDIM_RESET_DELAY_MS || 250);
const EMULATED_CRC = Number.parseInt(
  String(process.env.FLEXIDIM_EMULATED_CRC || 'd2fc'),
  16,
);
const TRANSFER_ORACLE_PATH = String(
  process.env.FLEXIDIM_TRANSFER_ORACLE_PATH || '',
);
const transferExpectedFrames = TRANSFER_ORACLE_PATH
  ? JSON.parse(fs.readFileSync(TRANSFER_ORACLE_PATH, 'utf8'))
      .map((value) => Buffer.from(value, 'hex'))
  : null;
let transferCompleted = false;
/** The single control session a real controller permits. */
let activeSession = null;

const ts = () => new Date().toISOString().slice(11, 23);
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');

// Split a TCP stream into FlexiDim frames. Each frame starts with 0xff; a frame
// ends at the byte before the next unescaped 0xff (0x1b escapes the following
// byte, so an escaped 0xff does not start a new frame).
function splitFrames(buf) {
  const frames = [];
  let start = -1;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x1b) { i += 1; continue; }
    if (buf[i] === 0xff) {
      if (start !== -1) frames.push(buf.subarray(start, i));
      start = i;
    }
  }
  const rest = start === -1 ? Buffer.alloc(0) : buf.subarray(start);
  return { frames, rest };
}

// Emulated channel levels, so a status scan reports something coherent and a
// dim command visibly changes what the next scan reports.
const CHANNEL_COUNT = Number(process.env.FLEXIDIM_EMULATED_CHANNELS || 24);
const levels = new Map();
for (let channel = 1; channel <= CHANNEL_COUNT; channel += 1)
  levels.set(channel, 0);

/**
 * Controller replies use a seven-bit additive check over the preceding bytes.
 * Building it here rather than hard-coding bytes keeps the emulator honest: the
 * bridge's parser rejects a wrong check, so a mistake here shows up as a failed
 * integrity check instead of passing silently.
 */
function checked(bytes) {
  const record = Buffer.from(bytes);
  const sum = record.reduce((total, byte) => (total + byte) & 0x7f, 0);
  return Buffer.concat([record, Buffer.from([sum])]);
}

/** An `f2` channel-level record. Status addresses are zero-based. */
function statusRecord(channel, level) {
  return checked([0xf2, channel - 1, level]);
}

/** The continuous level scan a real controller emits on an open session. */
function statusScan() {
  return Buffer.concat(
    [...levels.entries()].map(([channel, level]) =>
      statusRecord(channel, level),
    ),
  );
}

function reply(frame) {
  const r = decodeFrame(Array.from(frame));
  if (r.ok && frame[1] === 0xfc)
    return Buffer.from([0x06]);
  if (r.ok && frame[1] === 0xf5) {
    const now = new Date();
    return Buffer.from([
      0x06, EMULATED_CRC & 0xff, (EMULATED_CRC >>> 8) & 0xff,
      now.getHours(), now.getMinutes(), now.getSeconds(),
      1 << now.getDay(), 0x00, 0x04, 0x00,
    ]);
  }
  if (r.ok && r.decoded.name === 'PERIOD_FLAGS') return Buffer.from([0xff, 0xf3, 0x05, 0x00]);
  // A dim command updates the emulated level and is acknowledged with an f4,
  // then reflected by the next scan — the same order the real controller uses.
  if (r.ok && r.decoded.name === 'DIM' && frame.length >= 5) {
    const channel = frame[3];
    const level = frame[4];
    if (levels.has(channel)) levels.set(channel, level);
    return Buffer.concat([checked([0xf4, channel, level, 0x00]), statusRecord(channel, level)]);
  }
  return null;
}

const tcp = net.createServer((sock) => {
  const who = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`\n[${ts()}] ● app connected from ${who}`);
  let pending = Buffer.alloc(0);
  let authenticated = false;
  let scan;
  let transferOracle = null;
  // A real Scene Controller accepts only ONE control connection. Refusing the
  // second is the behaviour the app has to handle, so the emulator refuses too.
  if (activeSession) {
    console.log(`[${ts()}] ✗ second connection refused (controller allows one session)`);
    return sock.destroy();
  }
  activeSession = sock;
  sock.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!authenticated && pending.length >= 23) {
      const login = pending.subarray(0, 23);
      const nonce = login.subarray(16, 22).toString('ascii');
      if (/^\d{6}$/.test(nonce) && login[22] === 0xff) {
        authenticated = true;
        pending = pending.subarray(23);
        console.log(`[${ts()}] ← RX AUTH [16-byte key redacted ${nonce} ff]`);
        // A real controller starts its level scan once the session is open.
        // Emit one immediately, then keep scanning, so a client sees the same
        // passive feedback it gets from hardware.
        sock.write(statusScan());
        scan = setInterval(() => {
          if (!sock.destroyed) sock.write(statusScan());
        }, SCAN_INTERVAL_MS);
      } else {
        // Wrong-shaped credentials: the controller drops the connection rather
        // than answering, which is what the app has to cope with.
        console.log(`[${ts()}] ✗ authentication rejected; closing`);
        return sock.destroy();
      }
    }
    if (!authenticated) {
      console.log(`[${ts()}] ← waiting for 23-byte iOS authentication record (${pending.length}/23 bytes)`);
      return;
    }
    if (
      transferExpectedFrames &&
      !transferCompleted &&
      !transferOracle &&
      pending.length >= transferExpectedFrames[0].length &&
      pending
        .subarray(0, transferExpectedFrames[0].length)
        .equals(transferExpectedFrames[0])
    ) {
      transferOracle = new TransferPrefixEmulator({
        expectedFrames: transferExpectedFrames,
      });
      if (scan) {
        clearInterval(scan);
        scan = undefined;
      }
      console.log(`[${ts()}] ⇣ exact iOS-oracle transfer started`);
    }
    if (transferOracle) {
      while (transferOracle.cursor < transferExpectedFrames.length) {
        const expected = transferExpectedFrames[transferOracle.cursor];
        if (pending.length < expected.length) return;
        const candidate = pending.subarray(0, expected.length);
        pending = pending.subarray(expected.length);
        const answer = transferOracle.receive(candidate);
        if (answer) sock.write(answer);
      }
      for (let index = 0; index < 10; index += 1) transferOracle.status();
      if (!transferOracle.complete)
        throw new Error('oracle transfer did not reach its complete prefix');
      transferCompleted = true;
      console.log(`[${ts()}] ✓ exact iOS-oracle transfer accepted; resetting`);
      setTimeout(() => sock.destroy(), RESET_DELAY_MS);
      return;
    }
    if (pending.length) console.log(`[${ts()}] ← RX command bytes [${hex(pending)}]`);
    const { frames, rest } = splitFrames(pending);
    pending = rest;
    // Frames have no terminator, so splitFrames holds the last one back until
    // the next 0xff. If the trailing bytes already form a CRC-valid frame,
    // emit them now and clear the buffer (covers one-frame-per-write, the norm).
    if (rest.length >= 5 && rest[0] === 0xff && decodeFrame(Array.from(rest)).crcOk) {
      frames.push(rest);
      pending = Buffer.alloc(0);
    }
    for (const f of frames) {
      console.log(`[${ts()}]   frame [${hex(f)}]  ►►► ${describe(Array.from(f))}`);
      const answer = reply(f);
      if (answer) { console.log(`[${ts()}]   → reply [${hex(answer)}]`); sock.write(answer); }
    }
  });
  sock.on('close', () => {
    if (scan) clearInterval(scan);
    if (activeSession === sock) activeSession = null;
    console.log(`[${ts()}] ○ app disconnected ${who}`);
  });
  sock.on('error', (e) => console.log(`[${ts()}] socket error: ${e.message}`));
});
tcp.listen(TCP_PORT, () => console.log(`Emulated controller: TCP listening on 0.0.0.0:${TCP_PORT}`));

// Answer discovery broadcasts so the app/bridge's UDP discovery finds us.
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  console.log(`[${ts()}] ⇢ discovery from ${rinfo.address}:${rinfo.port}  [${hex(msg)}] "${msg.toString('latin1')}"`);
  const reply = Buffer.from('FLEXIDIM', 'utf8');
  udp.send(reply, rinfo.port, rinfo.address);
  udp.send(reply, DISCOVERY_REPLY_PORT, rinfo.address);
});
udp.bind(DISCOVERY_PORT, () => {
  try { udp.setBroadcast(true); } catch {}
  console.log(`Emulated controller: UDP discovery listening on ${DISCOVERY_PORT}`);
});

process.on('SIGINT', () => { tcp.close(); udp.close(); process.exit(0); });
