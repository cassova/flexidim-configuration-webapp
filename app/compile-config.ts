/**
 * Rebuild of the iOS app's `-[JCLFDConfig compileConfig]`.
 *
 * The Scene Controller is not sent the configuration file. It is sent a flat
 * binary image built from it, and the four-digit code the app shows next to a
 * configuration is a CRC-16/X25 over that image. To show the same code the web
 * app has to build a byte-identical image, so this file reproduces the layout
 * rather than approximating it.
 *
 * Everything here was recovered by running the real app's compiler on a known
 * configuration, changing one field at a time, and observing which bytes moved.
 * `work/binary-findings.md` Q25/Q26 records each mapping and how it was proven.
 *
 * VERIFIED. The ignored private-reference oracle and controlled mutations
 * produce byte-identical images to the original compiler. Exact private image
 * lengths and checksums stay outside Git-visible source.
 *
 * `compileConfig` still reports `complete`, because one detail is only partly
 * decoded: see NEXT_SCENE_MODE_CODES. A configuration that trips it returns
 * `complete: false`, and its checksum must not be shown or transferred.
 */

import type { AppData, Channel, Period, Scene } from "./fd4cfg";
import { buildSunTable, SUN_RECORD_BYTES, SUN_TABLE_DAYS } from "./sun-table.ts";

/** Bytes of the image, before the trailing all-zero block. */
const HEADER_POINTERS = 9;
const HEADER_BYTES = HEADER_POINTERS * 3;

/**
 * The first block is a fixed size regardless of how large the configuration is —
 * confirmed by compiling configurations with 1, 41 and 82 scenes and seeing the
 * second pointer stay at 0x5440 in all three.
 */
const SCENE_BLOCK_END = 0x5440;

/** Scene records start here, immediately after a 37-byte preamble. */
const SCENE_TABLE_START = 0x40;
const SCENE_RECORD_BYTES = 16;

/**
 * The scene table is 1024 slots; the 320 slots after it describe wall switch
 * action groups using the same record shape. Their unused pattern differs from
 * the scene one, so they cannot share a fill.
 */
const SCENE_TABLE_SLOTS = 1024;
const SWITCH_GROUP_SLOTS = 320;
const EMPTY_SWITCH_GROUP_RECORD = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] as const;

/**
 * Group slots are numbered from the start of the whole fixed block, where slot
 * 4 is the first switch-group slot. Subtract that to index the switch table.
 */
const SWITCH_GROUP_SLOT_BIAS = 4;

/**
 * The next-scene link at +0x02 is (target slot + 1) * 8 — a slot offset with
 * stride eight, one past the target, not a scene id. +0x08 carries a fixed
 * marker alongside it.
 */
const NEXT_SCENE_STRIDE = 8;
const NEXT_SCENE_MARKER = 0x7f;

/**
 * The flag byte beside a next-scene link: a fixed 0x10, the scene's own 0x80
 * flag, and a code for the sequence mode.
 *
 * ONLY THREE MODES HAVE BEEN OBSERVED. The reference configuration exercises
 * modes 1, 2 and 5 and nothing else, and the codes are not a linear function of
 * the mode (1 -> 2 but 2 -> 4), so the rule for other modes cannot be inferred.
 * A configuration using an unmapped mode is reported through `unmappedModes`
 * and leaves `complete` false rather than guessing a code — a wrong byte here
 * would produce a wrong image that still looks plausible.
 */
const NEXT_SCENE_FLAG_BASE = 0x10;
const NEXT_SCENE_MODE_CODES: Record<number, number> = { 1: 0x02, 2: 0x04, 5: 0x07 };

/** Used scene slots carry this in their last byte. */
const SCENE_RECORD_TRAILER = 1;

/**
 * An unused scene slot is not zero-filled — it carries this pattern, so the
 * table has to be pre-filled with it rather than left blank.
 */
const EMPTY_SCENE_RECORD = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0, 1,
] as const;

/**
 * The action table is a single shared list of five-byte entries — a channel, a
 * level, and two bytes not yet decoded, ending in a marker (0x0f or 0xa4).
 * Scenes occupy the first part of it and index in by byte offset; wall switches
 * occupy the remainder. In the reference configuration that is 283 scene entries
 * followed by 230 switch entries, 513 in total.
 *
 * The switch half is NOT yet generated, which is why the image we build is
 * currently short by exactly those 230 entries.
 */
const SCENE_LEVEL_BYTES = 5;

/**
 * The five actions a wall switch contributes to the action table. "Lower" is
 * "raise" with the relative bit set, the same convention the scene levels use.
 */
const SWITCH_ON_LEVEL = 100;
const SWITCH_RAISE_LEVEL = 1;
const SWITCH_LOWER_LEVEL = SWITCH_RAISE_LEVEL | 0x80;
const SWITCH_LEVEL_FLAGS = 0x0f;
const SWITCH_DIM_FLAGS = 0xa4;

/** Fixed 128 x 32 block that follows the scene level table. */
const BLOCK_128x32 = 128 * 32;
const BLOCK_128_RECORD_BYTES = 32;

/** Button slots in a switch's assignment record. */
const BUTTONS_PER_SWITCH = 16;

/** Bus addresses the switch index covers: one odd record each, 1 to 64. */
const SWITCH_INDEX_ADDRESSES = 64;

/** Slot numbers in the fixed block are addresses from here. */
const SWITCH_GROUP_BASE = 0x4000;

/**
 * Fixed-size block. It opens with the year of sunrise and sunset times the
 * controller needs to resolve "before sunset"-style period edges, and the period
 * table itself sits at offset 0x5d4 within it.
 */
const PERIOD_BLOCK_BYTES = 1572;
const PERIOD_TABLE_OFFSET = 0x5d4;
const PERIOD_RECORD_BYTES = 8;
/** The controller image has room for ten periods, not the app's full list. */
const PERIOD_SLOTS = 10;

/** 128 channel slots of 8 bytes, indexed by controller address minus one. */
const CHANNEL_SLOTS = 128;
const CHANNEL_RECORD_BYTES = 8;
const CHANNEL_MAXIMUM_OFFSET = 3;
/** Every unused channel slot still carries a maximum of 100. */
const DEFAULT_CHANNEL_MAXIMUM = 100;

/** Trailing block that is zero in every image observed. */
const TRAILING_BYTES = 8192;

/** The seventh pointer is always this far past the end of the image. */
const POINTER_SIX_BIAS = 5124;

function writePointer(image: Uint8Array, index: number, value: number): void {
  const at = index * 3;
  image[at] = value & 0xff;
  image[at + 1] = (value >>> 8) & 0xff;
  image[at + 2] = (value >>> 16) & 0xff;
}

function writeU16(image: Uint8Array, at: number, value: number): void {
  image[at] = value & 0xff;
  image[at + 1] = (value >>> 8) & 0xff;
}

/** "05:07" becomes 307. The controller stores times as minutes since midnight. */
export function minutesSinceMidnight(time: string | undefined): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Scenes are laid out in the order the archive stored them. */
function orderedScenes(scenes: Scene[]): Scene[] {
  return [...scenes].sort((a, b) => (a.legacyKey ?? a.id) - (b.legacyKey ?? b.id));
}

/**
 * The channel ids of a scene, in the order the controller image expects. Falls
 * back to key order for scenes built in the web app, which have no archive
 * ordering of their own yet.
 */
function sceneChannelOrder(scene: Scene): number[] {
  if (scene.channelOrder?.length) return scene.channelOrder;
  return Object.keys(scene.levels ?? {}).map(Number);
}

function addressedChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.controllerChannel != null);
}

export type CompileResult = {
  image: Uint8Array;
  /** CRC-16/X25 over the whole image — the code the app displays. */
  checksum: number;
  /**
   * Which byte ranges this build actually generates. Anything outside them is
   * zero fill standing in for a section that has not been decoded.
   */
  generated: Array<{ from: number; to: number; what: string }>;
  /**
   * True when every byte was generated from the configuration. False only when
   * something in it fell outside what has been decoded — see `unmappedModes`.
   */
  complete: boolean;
  /**
   * Scene sequence modes this build did not have a code for. Non-empty means the
   * image is wrong and its checksum must not be shown or transferred.
   */
  unmappedModes: number[];
};

/**
 * Build the controller image for a configuration.
 *
 * `sunTableYear` exists because the sunrise/sunset table is computed for the
 * current year, so a checksum is only comparable with another from the same
 * year. Pass an explicit year to reproduce an older one.
 *
 * Check `complete` before presenting the checksum or sending the image.
 */
export function compileConfig(data: AppData, sunTableYear = new Date().getUTCFullYear()): CompileResult {
  const scenes = orderedScenes(data.scenes ?? []);
  const channels = addressedChannels(data.channels ?? []);
  const periods = data.periods ?? [];

  // Scene levels are variable length, so the sections after them shift.
  const levelCounts = scenes.map((scene) => sceneChannelOrder(scene).length);
  const switchEntryCount = (data.switches ?? []).reduce((total, wallSwitch) => {
    const ids = wallSwitch.basic?.channelIds ?? [];
    const on = (id: number) => wallSwitch.basic?.channelSettings?.[id];
    return (
      total +
      ids.filter((id) => on(id)?.assignOn).length +
      ids.filter((id) => on(id)?.assignOff).length +
      ids.filter((id) => on(id)?.assignDimming).length +
      ids.filter((id) => on(id)?.assignChannelDimming).length +
      ids.length
    );
  }, 0);
  const levelTableBytes =
    levelCounts.reduce((total, n) => total + n * SCENE_LEVEL_BYTES, 0) +
    switchEntryCount * SCENE_LEVEL_BYTES;

  const levelTableStart = SCENE_BLOCK_END;
  const block128Start = levelTableStart + levelTableBytes;
  const periodBlockStart = block128Start + BLOCK_128x32;
  const periodTableStart = periodBlockStart + PERIOD_TABLE_OFFSET;
  const channelTableStart = periodBlockStart + PERIOD_BLOCK_BYTES;
  const trailingStart = channelTableStart + CHANNEL_SLOTS * CHANNEL_RECORD_BYTES;
  const length = trailingStart + TRAILING_BYTES;

  const image = new Uint8Array(length);

  writePointer(image, 0, periodTableStart);
  writePointer(image, 1, levelTableStart);
  writePointer(image, 2, block128Start);
  writePointer(image, 3, periodBlockStart);
  writePointer(image, 4, channelTableStart);
  writePointer(image, 5, trailingStart);
  writePointer(image, 6, length + POINTER_SIX_BIAS);
  writePointer(image, 7, length - 1);
  writePointer(image, 8, channelTableStart - 1);

  // Preamble, 0x1b-0x40. Three of its fields are derived from the layout; the
  // 0x0040 / 0x0080 pair and the trailing 10 00 01 are observed constants whose
  // meaning is not yet established (work/binary-findings.md Q36 B).
  image[0x1b] = SCENE_TABLE_START;
  writeU16(image, 0x1c, SCENE_TABLE_START);
  writeU16(image, 0x20, 0x0040);
  writeU16(image, 0x22, 0x0080);
  writeU16(image, 0x24, SCENE_TABLE_SLOTS);
  writeU16(image, 0x28, channelTableStart);
  image[0x3d] = 0x10;
  image[0x3f] = 0x01;

  // The fixed block holds TWO tables of the same 16-byte record. The first 1024
  // slots are scenes; the 320 after them describe each wall switch's action
  // groups. Both point into the action table by byte offset and entry count.
  const sceneSlots = SCENE_TABLE_SLOTS;
  for (let slot = 0; slot < sceneSlots; slot += 1) {
    const at = SCENE_TABLE_START + slot * SCENE_RECORD_BYTES;
    image.set(EMPTY_SCENE_RECORD, at);
  }

  const unmappedModes = new Set<number>();
  let levelOffset = 0;
  scenes.forEach((scene, index) => {
    if (index >= sceneSlots) return;
    const at = SCENE_TABLE_START + index * SCENE_RECORD_BYTES;
    image.set(EMPTY_SCENE_RECORD, at);
    writeU16(image, at + 0x00, scene.previousSceneId ?? 0);
    // The next-scene link is a SLOT OFFSET with stride 8, not a scene id: the
    // target scene's position in this table times eight.
    const nextSlot = scene.nextSceneId
      ? scenes.findIndex((other) => other.id === scene.nextSceneId)
      : -1;
    if (nextSlot >= 0) writeU16(image, at + 0x02, (nextSlot + 1) * NEXT_SCENE_STRIDE);
    writeU16(image, at + 0x04, scene.extenderSceneId ?? 0);
    writeU16(image, at + 0x06, scene.nextSceneTime ?? 0);
    if (nextSlot >= 0) image[at + 0x08] = NEXT_SCENE_MARKER;
    // Where this scene's actions begin, as a byte offset into the action table.
    writeU16(image, at + 0x09, levelOffset);
    image[at + 0x0b] = levelCounts[index] ?? 0;
    image[at + 0x0c] = scene.period1 ?? 0;
    // The slot still holds the unused pattern, whose +0x0d is 0x10.
    image[at + 0x0d] = 0;
    if (nextSlot >= 0) {
      const modeCode = NEXT_SCENE_MODE_CODES[scene.nextSceneMode ?? 0];
      if (modeCode === undefined) unmappedModes.add(scene.nextSceneMode ?? 0);
      image[at + 0x0d] =
        NEXT_SCENE_FLAG_BASE |
        ((scene.flags ?? 0) & 0x80) |
        (modeCode ?? 0);
    }
    image[at + 0x0e] = scene.period2 ?? 0;
    image[at + 0x0f] = SCENE_RECORD_TRAILER;
    levelOffset += (levelCounts[index] ?? 0) * SCENE_LEVEL_BYTES;
  });

  // Action table, scene half. One five-byte entry per channel a scene drives:
  //   [controller channel, level, fade, delay, flags]
  // The fade byte is twice the scene channel's fadeTime; flags comes straight
  // from the channel's settings and reads 0x0f throughout the reference site.
  //
  // Entries follow the archive's own `ch0, ch1, ...` order, which is why the
  // scene carries `channelOrder` — reading the order off `levels` would give
  // channel-id order instead and put every entry in the wrong place.
  let cursor = levelTableStart;
  for (const scene of scenes) {
    for (const channelId of sceneChannelOrder(scene)) {
      const channel = channels.find((c) => c.id === channelId);
      const settings = scene.channelSettings?.[channelId];
      image[cursor] = channel?.controllerChannel ?? 0;
      // A relative-percent channel carries bit 7 set on its level. The model
      // splits that out into `relativePercent`, so it has to go back on here.
      const level = (scene.levels?.[channelId] ?? 0) & 0x7f;
      image[cursor + 1] = settings?.relativePercent ? level | 0x80 : level;
      image[cursor + 2] = (settings?.fadeTime ?? 0) * 2;
      image[cursor + 3] = (settings?.delay ?? 0) * 2;
      image[cursor + 4] = settings?.flags ?? 0x0f;
      cursor += SCENE_LEVEL_BYTES;
    }
  }

  // The 128 x 32 block. Its odd records are a fixed lookup, not configuration:
  // record 2N-1 names the four action-group slots belonging to bus address N,
  // written as image addresses and in the order (3rd, 4th, 2nd, 1st). Verified
  // against all 64 of them. The even records are configuration-dependent and are
  // NOT yet decoded — see work/binary-findings.md Q36.
  for (let address = 1; address <= SWITCH_INDEX_ADDRESSES; address += 1) {
    const at = block128Start + (2 * address - 1) * BLOCK_128_RECORD_BYTES;
    const slotAddress = (slot: number) => SWITCH_GROUP_BASE + 16 * slot;
    writeU16(image, at + 0x00, slotAddress(5 * address - 2));
    writeU16(image, at + 0x04, slotAddress(5 * address - 1));
    writeU16(image, at + 0x0c, slotAddress(5 * address - 3));
    writeU16(image, at + 0x0e, slotAddress(5 * address - 4));
  }

  // Even records of the same block are the button-to-scene assignments for the
  // switch at bus address N. Sixteen u16 slots; index j is BUTTON j+1, holding
  // the target scene's slot plus one, times sixteen. Zero means unassigned.
  for (const wallSwitch of data.switches ?? []) {
    const address = wallSwitch.number ?? 0;
    if (address < 1 || address > SWITCH_INDEX_ADDRESSES) continue;
    const at = block128Start + (2 * address - 2) * BLOCK_128_RECORD_BYTES;
    for (const assignment of data.assignments ?? []) {
      if (assignment.switchId !== wallSwitch.id || !assignment.sceneId) continue;
      const button = assignment.button - 1;
      if (button < 0 || button >= BUTTONS_PER_SWITCH) continue;
      const slot = scenes.findIndex((scene) => scene.id === assignment.sceneId);
      if (slot < 0) continue;
      writeU16(image, at + button * 2, (slot + 1) * SCENE_RECORD_BYTES);
    }
  }

  // Sunrise and sunset table for the site, one record per day.
  const latitude = Number((data.site as Record<string, unknown> | undefined)?.latitude ?? NaN);
  const longitude = Number((data.site as Record<string, unknown> | undefined)?.longitude ?? NaN);
  const haveCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  if (haveCoordinates) {
    image.set(buildSunTable(latitude, longitude, sunTableYear), periodBlockStart);
  }

  // Switch group slots: one record per action group, in the same order the
  // groups are written into the action table below.
  const switchGroupStart = SCENE_TABLE_START + SCENE_TABLE_SLOTS * SCENE_RECORD_BYTES;
  for (let slot = 0; slot < SWITCH_GROUP_SLOTS; slot += 1)
    image.set(EMPTY_SWITCH_GROUP_RECORD, switchGroupStart + slot * SCENE_RECORD_BYTES);

  // Action table, switch half. Each switch contributes five groups, and a
  // channel only appears in a group if its own assignment flag says it responds
  // to that action — a switch's channels do NOT all answer every button.
  // Switches are laid out in bus-address order (`number`), not id order.
  const switchesByAddress = [...(data.switches ?? [])].sort(
    (a, b) => (a.number ?? 0) - (b.number ?? 0),
  );
  for (const wallSwitch of switchesByAddress) {
    // Group slots are indexed by the switch's bus address, not packed in order:
    // slot = 5 * number - 1, five consecutive slots per switch. Sites with high
    // addresses therefore leave large gaps, which stay at the unused pattern.
    let groupSlot = 5 * (wallSwitch.number ?? 0) - 1 - SWITCH_GROUP_SLOT_BIAS;
    const ids = wallSwitch.basic?.channelIds ?? [];
    const settingsFor = (id: number) => wallSwitch.basic?.channelSettings?.[id];
    const emit = (
      selected: number[],
      level: number,
      fade: (id: number) => number,
      flags: number,
    ) => {
      const slot = switchGroupStart + groupSlot * SCENE_RECORD_BYTES;
      image.set(EMPTY_SWITCH_GROUP_RECORD, slot);
      writeU16(image, slot + 0x09, cursor - levelTableStart);
      image[slot + 0x0b] = selected.length;
      groupSlot += 1;
      for (const id of selected) {
        const channel = channels.find((c) => c.id === id);
        image[cursor] = channel?.controllerChannel ?? 0;
        image[cursor + 1] = level;
        image[cursor + 2] = fade(id);
        image[cursor + 3] = 0;
        image[cursor + 4] = flags;
        cursor += SCENE_LEVEL_BYTES;
      }
    };
    const onFade = (id: number) => (settingsFor(id)?.onFade ?? 0) * 2;
    const offFade = (id: number) => (settingsFor(id)?.offFade ?? 0) * 2;
    emit(ids.filter((id) => settingsFor(id)?.assignOn), SWITCH_ON_LEVEL, onFade, SWITCH_LEVEL_FLAGS);
    emit(ids.filter((id) => settingsFor(id)?.assignOff), 0, offFade, SWITCH_LEVEL_FLAGS);
    emit(ids.filter((id) => settingsFor(id)?.assignDimming), SWITCH_RAISE_LEVEL, onFade, SWITCH_DIM_FLAGS);
    emit(
      ids.filter((id) => settingsFor(id)?.assignChannelDimming),
      SWITCH_LOWER_LEVEL,
      onFade,
      SWITCH_DIM_FLAGS,
    );
    emit(ids, 0, () => 0, 0);
  }

  // Period table.
  periods.slice(0, PERIOD_SLOTS).forEach((period: Period, index) => {
    const at = periodTableStart + index * PERIOD_RECORD_BYTES;
    writeU16(image, at + 0, minutesSinceMidnight(period.start));
    image[at + 2] = period.startMode ?? 0;
    writeU16(image, at + 4, minutesSinceMidnight(period.end));
    image[at + 6] = period.endMode ?? 0;
  });

  // Channel table. Unused slots still carry the default maximum.
  for (let slot = 0; slot < CHANNEL_SLOTS; slot += 1) {
    image[channelTableStart + slot * CHANNEL_RECORD_BYTES + CHANNEL_MAXIMUM_OFFSET] =
      DEFAULT_CHANNEL_MAXIMUM;
  }
  for (const channel of channels) {
    const slot = (channel.controllerChannel ?? 0) - 1;
    if (slot < 0 || slot >= CHANNEL_SLOTS) continue;
    const at = channelTableStart + slot * CHANNEL_RECORD_BYTES;
    image[at + CHANNEL_MAXIMUM_OFFSET] = channel.maximum ?? DEFAULT_CHANNEL_MAXIMUM;
  }

  return {
    image,
    checksum: crc16X25(image),
    generated: [
      { from: 0, to: HEADER_BYTES, what: "section pointers" },
      { from: SCENE_TABLE_START, to: SCENE_TABLE_START + sceneSlots * SCENE_RECORD_BYTES, what: "scene records" },
      { from: levelTableStart, to: block128Start, what: "scene levels (channel and level only)" },
      ...(haveCoordinates
        ? [{ from: periodBlockStart, to: periodBlockStart + SUN_TABLE_DAYS * SUN_RECORD_BYTES, what: "sunrise/sunset table" }]
        : []),
      { from: periodTableStart, to: periodTableStart + PERIOD_SLOTS * PERIOD_RECORD_BYTES, what: "periods" },
      { from: channelTableStart, to: trailingStart, what: "channel maxima" },
      { from: trailingStart, to: length, what: "trailing zero block" },
    ],
    complete: unmappedModes.size === 0 && haveCoordinates,
    unmappedModes: [...unmappedModes],
  };
}

/** The same CRC the wire protocol uses. Kept here so the app has no bridge import. */
export function crc16X25(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}

export function formatChecksum(value: number): string {
  return value.toString(16).padStart(4, "0");
}
