// FlexiDim wire-protocol decoder — ground truth extracted from FlexiDim.app.
//
// Reused by the Frida trace, the controller emulator, and pcap post-processing.
// Import it, or run it directly against a hex string:
//   node tools/decode.mjs "ff f3 04 05 64 02 1b fd ab"
//   node tools/decode.mjs --pcap capture.pcap        (needs tshark on PATH)

export function crc16X25(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return (~crc) & 0xffff;
}

// Wire → logical: first byte literal; a 0x1b escape means "next byte verbatim".
export function unescape(bytes) {
  const b = Array.from(bytes);
  if (!b.length) return [];
  const out = [b[0]];
  for (let i = 1; i < b.length; i += 1) {
    if (b[i] === 0x1b) { i += 1; if (i < b.length) out.push(b[i]); }
    else out.push(b[i]);
  }
  return out;
}

// Logical → wire: byte-stuff 0x1b and >=0xfd, leaving the first byte literal.
export function escape(bytes) {
  const b = Array.from(bytes);
  if (!b.length) return [];
  const out = [b[0]];
  for (const byte of b.slice(1)) {
    if (byte === 0x1b || byte >= 0xfd) out.push(0x1b);
    out.push(byte);
  }
  return out;
}

// Build a complete escaped frame from a command + value bytes (matches -[appendCRC:length:]).
export function buildFrame(command, values = []) {
  const body = [0xff, 0xf3, command, ...values.map((v) => Math.max(0, Math.min(255, Number(v) || 0)))];
  const crc = crc16X25(body);
  return escape([...body, crc & 0xff, crc >>> 8]);
}

const COMMANDS = {
  'ff,f3,00': (b) => ({ name: 'SWITCH', switch: b[3], button: b[4], b5: b[5] }),
  'ff,f3,02': (b) => ({ name: 'CMD_02', args: b.slice(3) }),
  'ff,f3,04': (b) => ({ name: 'DIM', channel: b[3], level: b[4], fade: b[5] }),
  'ff,f3,05': () => ({ name: 'PERIOD_FLAGS' }),
  'ff,f3,06': (b) => ({ name: 'CMD_06', args: b.slice(3) }),
  'ff,f1,00': (b) => ({ name: 'PROFILE_00', args: b.slice(3) }),
  'ff,f1,01': (b) => ({ name: 'PROFILE_01', args: b.slice(3) }),
};

export function decodeFrame(wireBytes) {
  const frame = unescape(wireBytes);
  if (frame.length < 5 || frame[0] !== 0xff) {
    return { ok: false, reason: 'not a FlexiDim frame', raw: frame };
  }
  const body = frame.slice(0, frame.length - 2);
  const wireCrc = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  const calcCrc = crc16X25(body);
  const key = body.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join(',');
  const decoder = COMMANDS[key];
  return {
    ok: true,
    crcOk: wireCrc === calcCrc,
    wireCrc, calcCrc,
    header: key,
    body,
    decoded: decoder ? decoder(body) : { name: 'UNKNOWN', header: key, args: body.slice(3) },
  };
}

export function describe(wireBytes) {
  const r = decodeFrame(wireBytes);
  if (!r.ok) return `(${r.reason})`;
  const d = r.decoded;
  const detail = Object.entries(d).filter(([k]) => k !== 'name').map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v}]` : v}`).join(' ');
  return `${d.name} ${detail}  | crc ${r.crcOk ? 'OK' : `BAD(wire=${r.wireCrc.toString(16)} calc=${r.calcCrc.toString(16)})`}`;
}

// --- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--pcap') {
    // Extract TCP/UDP payloads from a pcap via tshark and decode each.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('tshark', ['-r', args[1], '-Y', 'tcp.port==15273 || udp.port==15270 || udp.port==15001',
      '-T', 'fields', '-e', 'frame.time_relative', '-e', 'ip.src', '-e', 'ip.dst', '-e', 'data.data'], { encoding: 'utf8' });
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [t, src, dst, data] = line.split('\t');
      if (!data) continue;
      const bytes = data.split(':').map((h) => parseInt(h, 16));
      console.log(`t=${t} ${src} → ${dst}  ${describe(bytes)}`);
    }
  } else {
    const bytes = args.join(' ').trim().split(/[\s,]+/).map((h) => parseInt(h, 16));
    console.log(describe(bytes));
  }
}
