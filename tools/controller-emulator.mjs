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
import net from 'node:net';
import { describe, decodeFrame } from './decode.mjs';

const TCP_PORT = Number(process.env.FLEXIDIM_CONTROLLER_PORT || 15273);
const DISCOVERY_PORT = 15270;
const DISCOVERY_REPLY_PORT = 15001;

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

function reply(frame) {
  // Placeholder: a real controller echoes/acks. Replace with captured replies.
  const r = decodeFrame(Array.from(frame));
  if (r.ok && r.decoded.name === 'PERIOD_FLAGS') return Buffer.from([0xff, 0xf3, 0x05, 0x00]);
  return null;
}

const tcp = net.createServer((sock) => {
  const who = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`\n[${ts()}] ● app connected from ${who}`);
  let pending = Buffer.alloc(0);
  let authenticated = false;
  sock.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!authenticated && pending.length >= 23) {
      const login = pending.subarray(0, 23);
      const nonce = login.subarray(16, 22).toString('ascii');
      if (/^\d{6}$/.test(nonce) && login[22] === 0xff) {
        authenticated = true;
        pending = pending.subarray(23);
        console.log(`[${ts()}] ← RX AUTH [16-byte key redacted ${nonce} ff]`);
      }
    }
    if (!authenticated) {
      console.log(`[${ts()}] ← waiting for 23-byte iOS authentication record (${pending.length}/23 bytes)`);
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
  sock.on('close', () => console.log(`[${ts()}] ○ app disconnected ${who}`));
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
