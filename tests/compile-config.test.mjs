// The Scene Controller is not sent the configuration file — it is sent a binary
// image built from it, and the four-digit code the app shows is a CRC over that
// image. These tests guard the rebuilt compiler.
//
// The definitive private-reference proof cannot live here. The ignored oracle
// compares the complete web image with the original compiler without printing
// site data or configuration fingerprints. Multiple controlled mutations also
// match byte for byte.
//
// What these tests do is pin the behaviour against silent drift, using only the
// synthetic fixture that can be committed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseLegacyFd4Config } from "../app/fd4cfg.ts";
import { compileConfig, formatChecksum, crc16X25 } from "../app/compile-config.ts";
import { buildSunTable, SUN_TABLE_DAYS } from "../app/sun-table.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "fixtures", "golden.fd4cfg"));
const model = parseLegacyFd4Config(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
);

const pointer = (image, index) =>
  image[index * 3] | (image[index * 3 + 1] << 8) | (image[index * 3 + 2] << 16);

test("the compiled image is laid out as the controller expects", () => {
  const { image } = compileConfig(model, 2026);

  // Nine three-byte pointers locate every section, and the image is variable
  // length, so these are the only reliable way to find anything in it.
  assert.equal(pointer(image, 1), 0x5440, "the fixed block is a constant size");
  assert.equal(pointer(image, 7), image.length - 1);
  assert.equal(pointer(image, 8), pointer(image, 4) - 1);
  // Pointer 6 is not an offset into the image at all.
  assert.equal(pointer(image, 6), image.length + 5124);

  // Section sizes that do not vary with the configuration.
  assert.equal(pointer(image, 3) - pointer(image, 2), 128 * 32);
  assert.equal(pointer(image, 4) - pointer(image, 3), 1572);
  assert.equal(pointer(image, 5) - pointer(image, 4), 128 * 8);
  assert.equal(image.length - pointer(image, 5), 8192);
});

test("every unused channel slot still carries a maximum of 100", () => {
  const { image } = compileConfig(model, 2026);
  const table = pointer(image, 4);
  const used = new Set(
    model.channels.filter((c) => c.controllerChannel != null).map((c) => c.controllerChannel),
  );
  for (let slot = 0; slot < 128; slot += 1) {
    if (used.has(slot + 1)) continue;
    assert.equal(image[table + slot * 8 + 3], 100, `slot ${slot} lost its default maximum`);
  }
});

test("periods are stored as minutes since midnight, little-endian", () => {
  const edited = structuredClone(model);
  edited.periods[0].start = "05:07";
  const { image } = compileConfig(edited, 2026);
  const at = pointer(image, 0);
  assert.equal(image[at] | (image[at + 1] << 8), 5 * 60 + 7);
});

test("the sunrise table covers a full year plus a week, wrapping to its own start", () => {
  const table = buildSunTable(51.5, -0.12, 2026);
  assert.equal(table.length, SUN_TABLE_DAYS * 4);
  // The trailing days repeat the table's first days rather than running on into
  // next January — getting this wrong shifts three sunset minutes by one.
  for (let index = 365; index < SUN_TABLE_DAYS; index += 1) {
    const from = (index - 365) * 4;
    assert.deepEqual(
      Array.from(table.subarray(index * 4, index * 4 + 4)),
      Array.from(table.subarray(from, from + 4)),
      `day ${index} should repeat day ${index - 365}`,
    );
  }
});

test("the sunrise table is computed for the year it is asked for", () => {
  // The table depends on the year, so a configuration's checksum legitimately
  // changes when the year turns. Two checksums only compare within one year.
  const a = buildSunTable(51.5, -0.12, 2025);
  const b = buildSunTable(51.5, -0.12, 2026);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test("the checksum is a CRC-16/X25 over the whole image, shown as four hex digits", () => {
  const { image, checksum } = compileConfig(model, 2026);
  assert.equal(checksum, crc16X25(image));
  assert.equal(formatChecksum(0xabcd), "abcd");
  // Reading it as decimal is what makes a correct value look wrong.
  assert.equal(formatChecksum(checksum).length, 4);
});

test("the same configuration and year always compile to the same bytes", () => {
  const first = compileConfig(model, 2026);
  const second = compileConfig(model, 2026);
  assert.deepEqual(Array.from(first.image), Array.from(second.image));
  assert.equal(first.checksum, second.checksum);
});

test("a scene mode we have no code for refuses to claim the image is finished", () => {
  const edited = structuredClone(model);
  const linked = edited.scenes.find((scene) => scene.nextSceneId);
  if (!linked) return; // fixture has no sequence chain to break
  linked.nextSceneMode = 9; // never observed, so no code is known for it
  const result = compileConfig(edited, 2026);
  assert.deepEqual(result.unmappedModes, [9]);
  assert.equal(result.complete, false, "an un-decoded mode must not report complete");
});
