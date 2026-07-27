/**
 * Minimal Apple binary property list (bplist00) reader for FlexiDim iOS
 * documents.
 *
 * Replaces the previous third-party parser, which read 1/2/4-byte integers
 * as signed values. Apple stores 1/2/4-byte integers unsigned (only the
 * 8-byte form is signed), so archives containing bytes 0x80..0xff in short
 * integer fields decoded as negative numbers and corrupted object keys.
 *
 * NSKeyedArchiver UID values are surfaced as `{ "CF$UID": n }` objects, the
 * shape the importer already understands.
 */

export type ParsedPlistValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Uint8Array
  | { [key: string]: ParsedPlistValue }
  | ParsedPlistValue[];

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function parseBinaryPlist(buffer: ArrayBuffer): ParsedPlistValue {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const header = new TextDecoder().decode(bytes.subarray(0, 8));
  if (!header.startsWith("bplist"))
    throw new Error("The file is not an Apple binary property list");
  if (bytes.length < 40)
    throw new Error("The binary property list is truncated");

  const trailerStart = bytes.length - 32;
  const offsetSize = view.getUint8(trailerStart + 6);
  const refSize = view.getUint8(trailerStart + 7);
  const objectCount = Number(view.getBigUint64(trailerStart + 8, false));
  const topIndex = Number(view.getBigUint64(trailerStart + 16, false));
  const offsetTableStart = Number(view.getBigUint64(trailerStart + 24, false));

  const readUint = (start: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index += 1)
      value = value * 256 + bytes[start + index];
    return value;
  };

  const offsets: number[] = [];
  for (let index = 0; index < objectCount; index += 1)
    offsets.push(readUint(offsetTableStart + index * offsetSize, offsetSize));

  const objects: (ParsedPlistValue | undefined)[] = new Array(objectCount);
  const parsing = new Set<number>();

  const readIntegerObject = (start: number, byteCount: number): number | bigint => {
    if (byteCount === 8) {
      const signed = view.getBigInt64(start, false);
      const asNumber = Number(signed);
      return Number.isSafeInteger(asNumber) ? asNumber : signed;
    }
    if (byteCount === 16) {
      // 128-bit integers: high quad then low quad, two's complement.
      const high = view.getBigInt64(start, false);
      const low = view.getBigUint64(start + 8, false);
      const combined = (high << 64n) | low;
      const asNumber = Number(combined);
      return Number.isSafeInteger(asNumber) ? asNumber : combined;
    }
    // 1/2/4-byte integers are unsigned in the format.
    return readUint(start, byteCount);
  };

  const readObject = (index: number): ParsedPlistValue => {
    if (index >= objectCount)
      throw new Error("The binary property list references a missing object");
    const existing = objects[index];
    if (existing !== undefined) return existing;
    if (parsing.has(index))
      throw new Error("The binary property list contains a reference cycle");
    parsing.add(index);
    try {
      const start = offsets[index];
      const marker = bytes[start];
      const kind = marker >> 4;
      const info = marker & 0x0f;

      const lengthAndStart = (): { length: number; dataStart: number } => {
        if (info !== 0x0f) return { length: info, dataStart: start + 1 };
        const intMarker = bytes[start + 1];
        if (intMarker >> 4 !== 0x1)
          throw new Error("The binary property list has a malformed length");
        const intSize = 1 << (intMarker & 0x0f);
        return {
          length: readUint(start + 2, intSize),
          dataStart: start + 2 + intSize,
        };
      };

      let value: ParsedPlistValue;
      switch (kind) {
        case 0x0: {
          if (info === 0x0) value = null;
          else if (info === 0x8) value = false;
          else if (info === 0x9) value = true;
          else if (info === 0xf) value = null; // fill byte
          else throw new Error("Unknown binary property list marker");
          break;
        }
        case 0x1: {
          value = readIntegerObject(start + 1, 1 << info);
          break;
        }
        case 0x2: {
          const size = 1 << info;
          value =
            size === 4
              ? view.getFloat32(start + 1, false)
              : view.getFloat64(start + 1, false);
          break;
        }
        case 0x3: {
          const seconds = view.getFloat64(start + 1, false);
          value = new Date(APPLE_EPOCH_MS + seconds * 1000);
          break;
        }
        case 0x4: {
          const { length, dataStart } = lengthAndStart();
          value = bytes.slice(dataStart, dataStart + length);
          break;
        }
        case 0x5: {
          const { length, dataStart } = lengthAndStart();
          let ascii = "";
          for (let i = 0; i < length; i += 1)
            ascii += String.fromCharCode(bytes[dataStart + i]);
          value = ascii;
          break;
        }
        case 0x6: {
          const { length, dataStart } = lengthAndStart();
          let utf16 = "";
          for (let i = 0; i < length; i += 1)
            utf16 += String.fromCharCode(
              view.getUint16(dataStart + i * 2, false),
            );
          value = utf16;
          break;
        }
        case 0x8: {
          value = { "CF$UID": readUint(start + 1, info + 1) };
          break;
        }
        case 0xa: {
          const { length, dataStart } = lengthAndStart();
          const array: ParsedPlistValue[] = [];
          for (let i = 0; i < length; i += 1)
            array.push(readObject(readUint(dataStart + i * refSize, refSize)));
          value = array;
          break;
        }
        case 0xc: {
          // Sets decode like arrays.
          const { length, dataStart } = lengthAndStart();
          const array: ParsedPlistValue[] = [];
          for (let i = 0; i < length; i += 1)
            array.push(readObject(readUint(dataStart + i * refSize, refSize)));
          value = array;
          break;
        }
        case 0xd: {
          const { length, dataStart } = lengthAndStart();
          const dict: { [key: string]: ParsedPlistValue } = {};
          for (let i = 0; i < length; i += 1) {
            const key = readObject(
              readUint(dataStart + i * refSize, refSize),
            );
            const entry = readObject(
              readUint(dataStart + (length + i) * refSize, refSize),
            );
            dict[typeof key === "string" ? key : String(key)] = entry;
          }
          value = dict;
          break;
        }
        default:
          throw new Error("Unknown binary property list marker");
      }
      objects[index] = value;
      return value;
    } finally {
      parsing.delete(index);
    }
  };

  return readObject(topIndex);
}
