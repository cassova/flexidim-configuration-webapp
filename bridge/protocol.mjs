function crc16X25(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return (~crc) & 0xffff;
}

function packet(command, values = []) {
  const body = Buffer.from([0xff, 0xf3, command, ...values.map((value) => Math.max(0, Math.min(255, Number(value) || 0)))]);
  const crc = crc16X25(body);
  const complete = Buffer.concat([body, Buffer.from([crc & 0xff, crc >>> 8])]);
  const escaped = [complete[0]];
  for (const byte of complete.subarray(1)) {
    if (byte === 0x1b || byte >= 0xfd) escaped.push(0x1b);
    escaped.push(byte);
  }
  return Buffer.from(escaped);
}

export { crc16X25, packet };
