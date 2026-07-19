// Controller-to-client records observed on an authenticated local connection.
// f2 is the continuous four-byte channel-level scan; f4/f5 are five-byte
// command/state notifications. Keep incomplete records buffered across TCP
// chunks because socket data events do not preserve message boundaries.
export function parseControllerReplies(buffer) {
  const statuses = [];
  const visible = [];
  let offset = 0;

  while (offset < buffer.length) {
    const kind = buffer[offset];
    const length = kind === 0xf2 ? 4 : kind === 0xf4 || kind === 0xf5 ? 5 : 0;
    if (!length) {
      // Unknown reply shape: keep it visible rather than silently discarding it.
      visible.push(buffer.subarray(offset));
      offset = buffer.length;
      break;
    }
    if (offset + length > buffer.length) break;
    const record = buffer.subarray(offset, offset + length);
    if (kind === 0xf2) {
      statuses.push({
        // Status addresses are zero-based; webapp/controller TX addresses are
        // one-based (f2 address 0x10 reports TX channel 17).
        channel: record[1] + 1,
        level: record[2],
      });
    } else {
      visible.push(record);
    }
    offset += length;
  }

  return { statuses, visible, rest: buffer.subarray(offset) };
}
