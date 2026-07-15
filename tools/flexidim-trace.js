/*
 * flexidim-trace.js — Frida instrumentation for the real FlexiDim iOS app.
 *
 * This runs the actual .ipa "as is" on a jailbroken iPad and captures every
 * byte the app exchanges with the Scene Controller, decoding the FlexiDim
 * wire protocol inline. It hooks at two layers:
 *
 *   1. libSystem BSD socket calls (connect/send/sendto/recv/recvfrom/read/write)
 *      — the ground truth: whatever actually goes over the wire, regardless of
 *      which Objective-C API produced it. Each frame is tagged with the peer
 *      ip:port so you can tell controller traffic from everything else.
 *
 *   2. High-level Objective-C methods (sendDiMessage:/sendSwMessage:/
 *      openConnection:/initTCPto:/appendCRC:) — gives semantic context: which
 *      user action produced which bytes.
 *
 * Usage on the iPad (with frida-server running):
 *   Spawn (captures connection setup + handshake from the very start):
 *     frida -U -f com.jclighting.flexidimconfig -l flexidim-trace.js --no-pause
 *   Attach to the already-running app:
 *     frida -U -n FlexiDim -l flexidim-trace.js
 *
 * Tip: redirect to a file to keep a capture log:
 *   frida -U -f com.jclighting.flexidimconfig -l flexidim-trace.js --no-pause \
 *     -o flexidim-capture-$(date +%s).log
 */

'use strict';

// ---- Config -----------------------------------------------------------------
// Only frames to/from these ports are treated as controller traffic. Everything
// else (HTTP, DNS, App Store lookups) is summarised, not hex-dumped, to reduce
// noise. Set DUMP_ALL = true to hex-dump every socket.
const CONTROLLER_PORTS = [15273, 15270, 15001];
const DUMP_ALL = false;

// ---- FlexiDim protocol decoder (mirrors the reverse-engineered binary) ------
function crc16X25(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return (~crc) & 0xffff;
}

// Undo the on-the-wire byte-stuffing: the first byte is literal; after that a
// 0x1b escape byte means "take the next byte verbatim".
function unescape(bytes) {
  if (!bytes.length) return [];
  const out = [bytes[0]];
  for (let i = 1; i < bytes.length; i += 1) {
    if (bytes[i] === 0x1b) { i += 1; if (i < bytes.length) out.push(bytes[i]); }
    else out.push(bytes[i]);
  }
  return out;
}

const COMMANDS = {
  'ff,f3,00': (b) => `SWITCH  switch=${b[3]} button=${b[4]} (b5=${b[5]})`,
  'ff,f3,02': (b) => `CMD_02  args=[${b.slice(3).join(',')}]`,
  'ff,f3,04': (b) => `DIM     channel=${b[3]} level=${b[4]}% fade=${b[5]}`,
  'ff,f3,05': () => 'PERIOD_FLAGS request',
  'ff,f3,06': (b) => `CMD_06  args=[${b.slice(3).join(',')}]`,
  'ff,f1,00': (b) => `PROFILE_00 args=[${b.slice(3).join(',')}]`,
  'ff,f1,01': (b) => `PROFILE_01 args=[${b.slice(3).join(',')}]`,
};

function decodeFrame(raw) {
  // raw = escaped bytes as seen on the wire (one logical frame)
  const frame = unescape(raw);
  if (frame.length < 5 || frame[0] !== 0xff) return null;
  const body = frame.slice(0, frame.length - 2);
  const crcLo = frame[frame.length - 2];
  const crcHi = frame[frame.length - 1];
  const wireCrc = crcLo | (crcHi << 8);
  const calcCrc = crc16X25(body);
  const key = `${body[0].toString(16).padStart(2, '0')},${body[1].toString(16).padStart(2, '0')},${(body[2] || 0).toString(16).padStart(2, '0')}`;
  const decoder = COMMANDS[key];
  const label = decoder ? decoder(body) : `UNKNOWN header=${key} body=[${body.slice(3).join(',')}]`;
  const crcOk = wireCrc === calcCrc;
  return `${label}  | crc ${crcOk ? 'OK' : `BAD wire=${wireCrc.toString(16)} calc=${calcCrc.toString(16)}`}`;
}

function hex(bytes) {
  return Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
function ascii(bytes) {
  return Array.prototype.map.call(bytes, (b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
}

// ---- Peer address resolution ------------------------------------------------
const getpeername = new NativeFunction(Module.getExportByName(null, 'getpeername'), 'int', ['int', 'pointer', 'pointer']);

function peerOf(fd) {
  try {
    const addr = Memory.alloc(128);
    const len = Memory.alloc(4);
    len.writeU32(128);
    if (getpeername(fd, addr, len) !== 0) return null;
    const family = addr.add(1).readU8();
    if (family === 2) { // AF_INET
      const port = (addr.add(2).readU8() << 8) | addr.add(3).readU8();
      const ip = `${addr.add(4).readU8()}.${addr.add(5).readU8()}.${addr.add(6).readU8()}.${addr.add(7).readU8()}`;
      return { ip, port };
    }
  } catch (e) { /* not a socket / not connected */ }
  return null;
}

function isController(peer) {
  return peer && (CONTROLLER_PORTS.includes(peer.port) || DUMP_ALL);
}

function ts() {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

function report(dir, fd, peer, bytes) {
  const tag = peer ? `${peer.ip}:${peer.port}` : `fd${fd}`;
  const arrow = dir === 'TX' ? '→' : '←';
  console.log(`\n[${ts()}] ${arrow} ${dir} ${tag}  (${bytes.length} bytes)`);
  console.log(`  hex : ${hex(bytes)}`);
  console.log(`  txt : ${ascii(bytes)}`);
  const decoded = decodeFrame(bytes);
  if (decoded) console.log(`  ►►► ${decoded}`);
}

// ---- BSD socket hooks -------------------------------------------------------
function hookIO(name, fdArg, bufArg, dir, retIsLen) {
  const addr = Module.findExportByName(null, name);
  if (!addr) return;
  Interceptor.attach(addr, {
    onEnter(args) {
      this.fd = args[fdArg].toInt32();
      this.buf = args[bufArg];
      this.dir = dir;
    },
    onLeave(retval) {
      const n = retIsLen ? retval.toInt32() : this.declaredLen;
      if (!this.buf || n <= 0) return;
      const peer = peerOf(this.fd);
      if (!isController(peer)) return;
      const bytes = new Uint8Array(this.buf.readByteArray(n));
      report(this.dir, this.fd, peer, bytes);
    },
  });
}

// send(fd, buf, len, flags) / recv(fd, buf, len, flags): retval is byte count
hookIO('send', 0, 1, 'TX', true);
hookIO('write', 0, 1, 'TX', true);
hookIO('recv', 0, 1, 'RX', true);
hookIO('read', 0, 1, 'RX', true);

// sendto / recvfrom carry an explicit address argument
for (const [name, dir] of [['sendto', 'TX'], ['recvfrom', 'RX']]) {
  const addr = Module.findExportByName(null, name);
  if (!addr) continue;
  Interceptor.attach(addr, {
    onEnter(args) { this.fd = args[0].toInt32(); this.buf = args[1]; this.dir = dir; },
    onLeave(retval) {
      const n = retval.toInt32();
      if (!this.buf || n <= 0) return;
      let peer = peerOf(this.fd);
      if (!isController(peer) && !DUMP_ALL) return;
      const bytes = new Uint8Array(this.buf.readByteArray(n));
      report(this.dir, this.fd, peer, bytes);
    },
  });
}

// connect(fd, sockaddr, len): log every outbound connection attempt
const connectAddr = Module.findExportByName(null, 'connect');
if (connectAddr) {
  Interceptor.attach(connectAddr, {
    onEnter(args) {
      const sa = args[1];
      const family = sa.add(1).readU8();
      if (family === 2) {
        const port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
        const ip = `${sa.add(4).readU8()}.${sa.add(5).readU8()}.${sa.add(6).readU8()}.${sa.add(7).readU8()}`;
        console.log(`\n[${ts()}] ⇢ connect() fd${args[0].toInt32()} → ${ip}:${port}`);
      }
    },
  });
}

// ---- High-level Objective-C context hooks -----------------------------------
function hookObjC(cls, sel, describe) {
  try {
    const method = ObjC.classes[cls] && ObjC.classes[cls][sel];
    if (!method) return;
    Interceptor.attach(method.implementation, {
      onEnter(args) {
        try { console.log(`\n[${ts()}] ·· -[${cls} ${sel}]  ${describe ? describe(args) : ''}`); } catch (e) {}
      },
    });
  } catch (e) { /* class not loaded yet */ }
}

if (ObjC.available) {
  // The comms methods live on JCLAppDelegate in this build.
  const argInt = (args, i) => args[i].toInt32();
  hookObjC('JCLAppDelegate', '- sendDiMessage:brightness:transition:', (a) => `channel=${argInt(a, 2)} level=${argInt(a, 3)} fade=${argInt(a, 4)}`);
  hookObjC('JCLAppDelegate', '- sendSwMessage:button:', (a) => `switch=${argInt(a, 2)} button=${argInt(a, 3)}`);
  hookObjC('JCLAppDelegate', '- initTCPto:onPort:', (a) => {
    try { return `host=${new ObjC.Object(a[2]).toString()} port=${a[3].toInt32()}`; } catch (e) { return ''; }
  });
  hookObjC('JCLAppDelegate', '- openConnection:siteID:connect:', (a) => {
    try { return `arg=${new ObjC.Object(a[2]).toString()} siteID=${new ObjC.Object(a[3]).toString()} connect=${a[4].toInt32()}`; } catch (e) { return ''; }
  });
  hookObjC('JCLAppDelegate', '- enableBroadcast:error:');
  console.log('[flexidim-trace] Objective-C hooks installed on JCLAppDelegate.');
} else {
  console.log('[flexidim-trace] ObjC runtime not available; socket-level hooks only.');
}

console.log('[flexidim-trace] Ready. Watching ports', CONTROLLER_PORTS.join(', '), DUMP_ALL ? '(DUMP_ALL on)' : '');
