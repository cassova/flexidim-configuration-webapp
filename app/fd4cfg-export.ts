import type {
  AppData,
  Assignment,
  Channel,
  FlexUser,
  Period,
  StateFlag,
  Room,
  Scene,
  SceneChannelSettings,
  SceneGroup,
  Site,
  WallSwitch,
} from "./fd4cfg";
import { normalizePeriodTables } from "./fd4cfg.ts";

/**
 * Binary `.fd4cfg` exporter.
 *
 * Regenerates an original-format FlexiDim iOS document: an Apple binary
 * property list containing an NSKeyedArchiver object graph whose `$top`
 * dictionary uses the recovered positional `$0..$N` encode layout:
 *
 *   $0 format marker, $1..$29 site scalars, bus-A module IDs, bus-B module
 *   IDs, JCLFDHardware objects, four post-hardware fields, then each object
 *   section (switches, scenes, periods, users) preceded by its count string,
 *   plus the integer keys hwc/modc/modcB.
 *
 * Fidelity strategy: every imported entity carries a dereferenced `legacy`
 * bag of its original archive fields. Export starts from that bag and
 * overwrites only the fields the web model owns, so unknown/unmodeled fields
 * survive an import → export → import round-trip unchanged.
 */

// ---------------------------------------------------------------------------
// Binary property list writer (bplist00)
// ---------------------------------------------------------------------------

/** NSKeyedArchiver cross-object pointer (bplist UID type). */
export class PlistUid {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Marker for a real (double) so integers like 0 can be forced to doubles. */
export class PlistReal {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | PlistUid
  | PlistReal
  | PlistValue[]
  | { [key: string]: PlistValue };

function isPlainObject(value: PlistValue): value is { [key: string]: PlistValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PlistUid) &&
    !(value instanceof PlistReal)
  );
}

/** Serialize a value tree into a standalone bplist00 document. */
export function writeBinaryPlist(root: PlistValue): Uint8Array {
  // Flatten the tree; every node becomes one object-table entry. Equal
  // primitive strings are deduplicated like Apple's writer does.
  const objects: PlistValue[] = [];
  const stringIndex = new Map<string, number>();
  const flatten = (value: PlistValue): number => {
    if (typeof value === "string") {
      const existing = stringIndex.get(value);
      if (existing !== undefined) return existing;
      const index = objects.length;
      objects.push(value);
      stringIndex.set(value, index);
      return index;
    }
    const index = objects.length;
    objects.push(value);
    if (Array.isArray(value)) {
      const refs = value.map(flatten);
      objects[index] = { __arrayRefs: refs } as unknown as PlistValue;
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const keyRefs = keys.map((key) => flatten(key));
      const valueRefs = keys.map((key) => flatten(value[key]));
      objects[index] = {
        __dictRefs: { keyRefs, valueRefs },
      } as unknown as PlistValue;
    }
    return index;
  };
  const topIndex = flatten(root);

  const refSize = objects.length < 0x100 ? 1 : objects.length < 0x10000 ? 2 : 4;
  const chunks: number[] = [];
  const push = (...bytes: number[]) => chunks.push(...bytes);
  const pushRef = (ref: number) => {
    for (let shift = (refSize - 1) * 8; shift >= 0; shift -= 8)
      push((ref >> shift) & 0xff);
  };
  const pushIntHeader = (marker: number, count: number) => {
    if (count < 15) {
      push(marker | count);
    } else {
      push(marker | 0x0f);
      pushInteger(count);
    }
  };
  const pushInteger = (value: number | bigint) => {
    const big = BigInt(value);
    if (big < 0n) {
      push(0x13);
      for (let shift = 56n; shift >= 0n; shift -= 8n)
        push(Number((big >> shift) & 0xffn));
      return;
    }
    if (big < 0x100n) {
      push(0x10, Number(big));
    } else if (big < 0x10000n) {
      push(0x11, Number(big >> 8n), Number(big & 0xffn));
    } else if (big < 0x100000000n) {
      push(0x12);
      for (let shift = 24n; shift >= 0n; shift -= 8n)
        push(Number((big >> shift) & 0xffn));
    } else {
      push(0x13);
      for (let shift = 56n; shift >= 0n; shift -= 8n)
        push(Number((big >> shift) & 0xffn));
    }
  };
  const pushDouble = (value: number) => {
    push(0x23);
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setFloat64(0, value, false);
    for (let index = 0; index < 8; index += 1) push(buffer.getUint8(index));
  };

  const offsets: number[] = [];
  for (const entry of objects) {
    offsets.push(chunks.length);
    if (entry === null || entry === undefined) {
      push(0x00);
    } else if (typeof entry === "boolean") {
      push(entry ? 0x09 : 0x08);
    } else if (typeof entry === "number" || typeof entry === "bigint") {
      if (typeof entry === "number" && !Number.isInteger(entry))
        pushDouble(entry);
      else pushInteger(entry);
    } else if (entry instanceof PlistReal) {
      pushDouble(entry.value);
    } else if (entry instanceof PlistUid) {
      // UID marker 0x80 | (byte length - 1)
      const bytes =
        entry.value < 0x100 ? 1 : entry.value < 0x10000 ? 2 : 4;
      push(0x80 | (bytes - 1));
      for (let shift = (bytes - 1) * 8; shift >= 0; shift -= 8)
        push((entry.value >> shift) & 0xff);
    } else if (typeof entry === "string") {
      if (/^[\x00-\x7f]*$/.test(entry)) {
        pushIntHeader(0x50, entry.length);
        for (let index = 0; index < entry.length; index += 1)
          push(entry.charCodeAt(index));
      } else {
        pushIntHeader(0x60, entry.length);
        for (let index = 0; index < entry.length; index += 1) {
          const code = entry.charCodeAt(index);
          push((code >> 8) & 0xff, code & 0xff);
        }
      }
    } else if ("__arrayRefs" in (entry as Record<string, unknown>)) {
      const refs = (entry as unknown as { __arrayRefs: number[] }).__arrayRefs;
      pushIntHeader(0xa0, refs.length);
      for (const ref of refs) pushRef(ref);
    } else {
      const { keyRefs, valueRefs } = (
        entry as unknown as {
          __dictRefs: { keyRefs: number[]; valueRefs: number[] };
        }
      ).__dictRefs;
      pushIntHeader(0xd0, keyRefs.length);
      for (const ref of keyRefs) pushRef(ref);
      for (const ref of valueRefs) pushRef(ref);
    }
  }

  const header = "bplist00";
  const offsetTableStart = header.length + chunks.length;
  const offsetSize =
    offsetTableStart < 0x100 ? 1 : offsetTableStart < 0x10000 ? 2 : 4;
  const output = new Uint8Array(
    header.length + chunks.length + offsets.length * offsetSize + 32,
  );
  for (let index = 0; index < header.length; index += 1)
    output[index] = header.charCodeAt(index);
  output.set(chunks, header.length);
  let cursor = header.length + chunks.length;
  for (const offset of offsets) {
    const absolute = offset + header.length;
    for (let shift = (offsetSize - 1) * 8; shift >= 0; shift -= 8) {
      output[cursor] = (absolute >> shift) & 0xff;
      cursor += 1;
    }
  }
  // 32-byte trailer
  const trailer = new DataView(output.buffer, output.byteLength - 32, 32);
  trailer.setUint8(6, offsetSize);
  trailer.setUint8(7, refSize);
  trailer.setBigUint64(8, BigInt(objects.length), false);
  trailer.setBigUint64(16, BigInt(topIndex), false);
  trailer.setBigUint64(24, BigInt(offsetTableStart), false);
  return output;
}

// ---------------------------------------------------------------------------
// NSKeyedArchiver graph builder
// ---------------------------------------------------------------------------

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

class KeyedArchive {
  objects: PlistValue[] = ["$null"];
  private classUids = new Map<string, PlistUid>();
  private stringUids = new Map<string, PlistUid>();

  add(value: PlistValue): PlistUid {
    const uid = new PlistUid(this.objects.length);
    this.objects.push(value);
    return uid;
  }

  classUid(classname: string, classes: string[]): PlistUid {
    const existing = this.classUids.get(classname);
    if (existing) return existing;
    const uid = this.add({ $classname: classname, $classes: classes });
    this.classUids.set(classname, uid);
    return uid;
  }

  string(value: string): PlistUid {
    const existing = this.stringUids.get(value);
    if (existing) return existing;
    const uid = this.add(value);
    this.stringUids.set(value, uid);
    return uid;
  }

  mutableString(value: string): PlistUid {
    return this.add({
      "NS.string": value,
      $class: this.classUid("NSMutableString", [
        "NSMutableString",
        "NSString",
        "NSObject",
      ]),
    });
  }

  date(iso: string): PlistUid {
    const parsed = new Date(iso);
    const seconds = Number.isNaN(parsed.getTime())
      ? 0
      : (parsed.getTime() - APPLE_EPOCH_MS) / 1000;
    return this.add({
      "NS.time": new PlistReal(seconds),
      $class: this.classUid("NSDate", ["NSDate", "NSObject"]),
    });
  }
}

type LegacyBag = Record<string, unknown>;

function legacyBag(value: unknown): LegacyBag {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LegacyBag)
    : {};
}

function legacyNumber(bag: LegacyBag, key: string): number | undefined {
  const value = bag[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

function legacyString(bag: LegacyBag, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" ? value : undefined;
}

function legacyBool(bag: LegacyBag, key: string): boolean | undefined {
  const value = bag[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return undefined;
}

/** A dereferenced nested archive object stored by the importer ({$class: ...}). */
function legacyChild(bag: LegacyBag, key: string): LegacyBag | undefined {
  const value = bag[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value as LegacyBag;
    if (typeof child.$class === "string") return child;
  }
  return undefined;
}

function legacyDateIso(bag: LegacyBag, key: string): string | undefined {
  const value = bag[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const date = (value as { $date?: unknown }).$date;
    if (typeof date === "string") return date;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Model → archive conversion
// ---------------------------------------------------------------------------

// Archive DST rule strings as written by the iOS app ($20).
const DST_ARCHIVE_NAME: Record<string, string> = {
  "No daylight saving": "No Daylight Saving",
  "UK / Europe": "UK / Europe",
  USA: "USA",
};

type ArchiveEntity = {
  legacyKey?: number;
  legacy?: Record<string, unknown>;
};

/** Assign stable `ky` keys to entities created in the web app. */
function assignKeys(entities: ArchiveEntity[][]): Map<ArchiveEntity, number> {
  const used = new Set<number>();
  for (const list of entities)
    for (const entity of list)
      if (typeof entity.legacyKey === "number" && entity.legacyKey > 0)
        used.add(entity.legacyKey);
  let next = 1;
  const keys = new Map<ArchiveEntity, number>();
  for (const list of entities)
    for (const entity of list) {
      if (typeof entity.legacyKey === "number" && entity.legacyKey > 0) {
        keys.set(entity, entity.legacyKey);
        continue;
      }
      while (used.has(next)) next += 1;
      used.add(next);
      keys.set(entity, next);
    }
  return keys;
}

export function buildLegacyArchive(data: AppData): Uint8Array {
  const archive = new KeyedArchive();
  const site: Site = data.site;
  const siteLegacy = legacyBag(site.legacy);
  const rawTop = legacyBag(siteLegacy.top);
  const rawTopString = (slot: number) => legacyString(rawTop, `$${slot}`);

  const rooms: Room[] = data.rooms ?? [];
  const channels: Channel[] = data.channels ?? [];
  const switches: WallSwitch[] = data.switches ?? [];
  const sceneGroups: SceneGroup[] = data.sceneGroups ?? [];
  const scenes: Scene[] = data.scenes ?? [];
  const deletedScenes: Scene[] = data.deletedScenes ?? [];
  const { periods, stateFlags } = normalizePeriodTables(
    data.periods,
    data.stateFlags,
  );
  const users: FlexUser[] = data.users ?? [];
  const assignments: Assignment[] = data.assignments ?? [];

  const keys = assignKeys([
    rooms,
    channels,
    switches,
    sceneGroups as unknown as ArchiveEntity[],
    scenes,
    deletedScenes,
    users,
  ]);
  const entityKey = (entity: ArchiveEntity) => keys.get(entity) ?? 0;

  const roomKyById = new Map(rooms.map((room) => [room.id, entityKey(room)]));
  const switchKyById = new Map(
    switches.map((wallSwitch) => [wallSwitch.id, entityKey(wallSwitch)]),
  );
  const channelKyById = new Map(
    channels.map((channel) => [channel.id, entityKey(channel)]),
  );
  const groupKyById = new Map(
    sceneGroups.map((group) => [group.id, entityKey(group)]),
  );
  const sceneKyById = new Map(
    [...scenes, ...deletedScenes].map((scene) => [scene.id, entityKey(scene)]),
  );

  // Original archive hierarchy links, used to keep untouched parent chains
  // (including deleted-item roots such as ky -4) byte-faithful.
  const hardwareLegacyByKy = new Map<number, LegacyBag>();
  for (const room of rooms)
    hardwareLegacyByKy.set(entityKey(room), legacyBag(room.legacy));
  for (const channel of channels)
    hardwareLegacyByKy.set(entityKey(channel), legacyBag(channel.legacy));
  for (const wallSwitch of switches)
    hardwareLegacyByKy.set(
      entityKey(wallSwitch),
      legacyBag(legacyBag(wallSwitch.legacy).hardware),
    );
  const roomKys = new Set(rooms.map((room) => entityKey(room)));
  /** Nearest room ancestor of an original `pr` chain, as the importer sees it. */
  const originalRoomAncestor = (start: number | undefined): number | undefined => {
    let parentKey = start;
    const visited = new Set<number>();
    while (
      parentKey !== undefined &&
      parentKey !== 0 &&
      !visited.has(parentKey)
    ) {
      if (roomKys.has(parentKey)) return parentKey;
      visited.add(parentKey);
      parentKey = legacyNumber(hardwareLegacyByKy.get(parentKey) ?? {}, "pr");
    }
    return undefined;
  };

  /**
   * Keep the original `pr` when it still resolves to the model's parent, so
   * flattened import chains and deleted roots survive; otherwise use the
   * model's parent key.
   */
  const hardwareParent = (bag: LegacyBag, modelParentKy: number): number => {
    const original = legacyNumber(bag, "pr");
    if (original === undefined) return modelParentKy;
    if (original === modelParentKy) return original;
    const resolved = originalRoomAncestor(original);
    if (resolved !== undefined && resolved === modelParentKy) return original;
    if (resolved === undefined && modelParentKy === (roomKys.size ? [...roomKys][0] : 0)) {
      // Original chain never reached a room; the importer fell back to the
      // first room. Preserve the original link rather than rewriting it.
      return original;
    }
    return modelParentKy;
  };

  const string = (value: string | undefined) => archive.string(value ?? "");

  /**
   * Convert every dereferenced legacy field back to its archive value so
   * unknown/unmodeled keys survive an export. Known keys are overridden by
   * the callers after this baseline.
   */
  const bagFields = (
    bag: LegacyBag,
    skip?: RegExp,
  ): Record<string, PlistValue> => {
    const out: Record<string, PlistValue> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (key === "$class") continue;
      if (skip?.test(key)) continue;
      if (typeof value === "number" || typeof value === "boolean")
        out[key] = value;
      else if (typeof value === "string") out[key] = string(value);
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        const child = value as LegacyBag;
        if (typeof (child as { $date?: unknown }).$date === "string")
          out[key] = archive.date((child as { $date: string }).$date);
        else if (child.$class === "JCLFDChannel")
          out[key] = channelRecord(child, {});
      }
    }
    return out;
  };

  const hardwareObject = (
    bag: LegacyBag,
    fields: Record<string, PlistValue>,
  ): PlistUid => {
    const object: Record<string, PlistValue> = {
      ...bagFields(bag),
      // Baseline every JCLFDHardware field so hand-built sites archive the
      // complete recovered key set; the legacy bag then restores original
      // values and the model overrides what the editor owns.
      ix: legacyNumber(bag, "ix") ?? 0,
      ch: legacyBool(bag, "ch") ?? false,
      df: legacyNumber(bag, "df") ?? 100,
      sn: string(legacyString(bag, "sn")),
      ra: legacyNumber(bag, "ra") ?? 0,
      ri: legacyNumber(bag, "ri") ?? 0,
      nm: string(legacyString(bag, "nm")),
      mp: legacyNumber(bag, "mp") ?? 100,
      mx: legacyNumber(bag, "mx") ?? 100,
      di: legacyNumber(bag, "di") ?? 0,
      hw: legacyNumber(bag, "hw") ?? 0,
      mi: legacyNumber(bag, "mi") ?? 0,
      pr: legacyNumber(bag, "pr") ?? 0,
      ac: legacyNumber(bag, "ac") ?? 0,
      fn: string(legacyString(bag, "fn")),
      ky: legacyNumber(bag, "ky") ?? 0,
      ad: string(legacyString(bag, "ad")),
      ty: legacyNumber(bag, "ty") ?? 0,
      md: legacyNumber(bag, "md") ?? -1,
      ...fields,
      $class: archive.classUid("JCLFDHardware", ["JCLFDHardware", "NSObject"]),
    };
    return archive.add(object);
  };

  /** JCLFDChannel record (scene ch0..chN / switch bs0..bs7). */
  const channelRecord = (
    bag: LegacyBag | undefined,
    fields: Record<string, PlistValue>,
  ): PlistUid => {
    const source = bag ?? {};
    return archive.add({
      ...bagFields(source),
      ky: legacyNumber(source, "ky") ?? 0,
      t2: legacyNumber(source, "t2") ?? 0,
      de: legacyNumber(source, "de") ?? 0,
      br: legacyNumber(source, "br") ?? 100,
      fl: legacyNumber(source, "fl") ?? 0,
      ch: legacyBool(source, "ch") ?? false,
      t1: legacyNumber(source, "t1") ?? 0,
      ...fields,
      $class: archive.classUid("JCLFDChannel", ["JCLFDChannel", "NSObject"]),
    });
  };

  // --- hardware objects, in the original archive order where known ---------
  const hardwareEntries: { ky: number; uid: () => PlistUid }[] = [];
  for (const room of rooms) {
    const bag = legacyBag(room.legacy);
    const modelParent =
      room.parentId != null ? (roomKyById.get(room.parentId) ?? 0) : 0;
    hardwareEntries.push({
      ky: entityKey(room),
      uid: () =>
        hardwareObject(bag, {
          ky: entityKey(room),
          ty: 0,
          nm: string(room.name),
          sn: string(room.shortName ?? room.name),
          ra: room.displayRank ?? legacyNumber(bag, "ra") ?? 0,
          ri: Number(/rooms\/(\d+)\.png$/.exec(room.icon)?.[1] ?? legacyNumber(bag, "ri") ?? 0),
          pr: hardwareParent(bag, modelParent),
          hw: room.hardwareType ?? legacyNumber(bag, "hw") ?? 0,
          ix: room.hardwareIndex ?? legacyNumber(bag, "ix") ?? 0,
        }),
    });
  }
  for (const channel of channels) {
    const bag = legacyBag(channel.legacy);
    const modelParent = roomKyById.get(channel.roomId) ?? 0;
    hardwareEntries.push({
      ky: entityKey(channel),
      uid: () =>
        hardwareObject(bag, {
          ky: entityKey(channel),
          ty: 2,
          nm: string(channel.name),
          sn: string(channel.shortName ?? channel.name),
          ra: channel.displayRank ?? legacyNumber(bag, "ra") ?? 0,
          pr: hardwareParent(bag, modelParent),
          hw: channel.hardwareType ?? legacyNumber(bag, "hw") ?? 0,
          ix: channel.channelIndex ?? legacyNumber(bag, "ix") ?? 0,
          md: channel.moduleId ?? -1,
          mi: channel.minimum ?? legacyNumber(bag, "mi") ?? 0,
          mx: channel.maximum ?? legacyNumber(bag, "mx") ?? 100,
          mp: channel.maximumPermissible ?? legacyNumber(bag, "mp") ?? 100,
          df: channel.defaultLevel ?? legacyNumber(bag, "df") ?? 100,
          ac: channel.accessoryType ?? legacyNumber(bag, "ac") ?? 0,
          di: channel.dimmable === undefined
            ? (legacyNumber(bag, "di") ?? 0)
            : channel.dimmable
              ? 1
              : 0,
          ch: channel.hardwareChanged ?? legacyBool(bag, "ch") ?? false,
        }),
    });
  }
  for (const wallSwitch of switches) {
    const bag = legacyBag(legacyBag(wallSwitch.legacy).hardware);
    const modelParent = roomKyById.get(wallSwitch.roomId) ?? 0;
    hardwareEntries.push({
      ky: entityKey(wallSwitch),
      uid: () =>
        hardwareObject(bag, {
          ky: entityKey(wallSwitch),
          ty: 1,
          nm: string(wallSwitch.name),
          sn: string(wallSwitch.shortName ?? wallSwitch.name),
          ra: wallSwitch.displayRank ?? legacyNumber(bag, "ra") ?? 0,
          pr: hardwareParent(bag, modelParent),
          hw: wallSwitch.type ?? legacyNumber(bag, "hw") ?? 15,
          ix: wallSwitch.number ?? legacyNumber(bag, "ix") ?? 0,
        }),
    });
  }
  const hardwareOrder = Array.isArray(siteLegacy.hardwareOrder)
    ? (siteLegacy.hardwareOrder as number[])
    : [];
  const hardwareRank = new Map(hardwareOrder.map((ky, index) => [ky, index]));
  hardwareEntries.sort(
    (a, b) =>
      (hardwareRank.get(a.ky) ?? hardwareOrder.length) -
      (hardwareRank.get(b.ky) ?? hardwareOrder.length),
  );

  // --- switch settings objects ---------------------------------------------
  const switchObject = (wallSwitch: WallSwitch): PlistUid => {
    const settings = legacyBag(legacyBag(wallSwitch.legacy).settings);
    const object: Record<string, PlistValue> = {
      ...bagFields(settings, /^(bu|bs)\d+$/),
    };
    // Logical button slots: bu0..bu23 hold the scene ky as a string (empty when
    // unassigned). Slots whose original value points at a scene the web model
    // knows are reset first, so assignments removed in the editor do not
    // reappear; unknown raw values are kept verbatim.
    const knownSceneKys = new Set(sceneKyById.values());
    for (let slot = 0; slot < 24; slot += 1) {
      const raw = legacyString(settings, `bu${slot}`) ?? "";
      const rawKy = Number(raw);
      object[`bu${slot}`] = string(
        raw !== "" &&
          Number.isInteger(rawKy) &&
          rawKy > 0 &&
          knownSceneKys.has(rawKy)
          ? ""
          : raw,
      );
    }
    for (const assignment of assignments) {
      if (assignment.switchId !== wallSwitch.id) continue;
      const slot = assignment.button - 1;
      if (slot < 0 || slot > 23) continue;
      const sceneKy = assignment.sceneId
        ? sceneKyById.get(assignment.sceneId)
        : undefined;
      object[`bu${slot}`] = string(sceneKy === undefined ? "" : String(sceneKy));
    }
    // Basic Assignment records bs0..bsN in the stored channel order.
    const channelIds = wallSwitch.basic?.channelIds ?? [];
    const settingsById = wallSwitch.basic?.channelSettings ?? {};
    channelIds.forEach((channelId, index) => {
      const perChannel = settingsById[channelId];
      const original = legacyChild(settings, `bs${index}`);
      const flags = perChannel
        ? (perChannel.assignOn ? 1 : 0) |
          (perChannel.assignOff ? 2 : 0) |
          (perChannel.assignDimming ? 4 : 0) |
          (perChannel.assignChannelDimming ? 8 : 0) |
          ((legacyNumber(original ?? {}, "fl") ?? 0) & ~0x0f)
        : (legacyNumber(original ?? {}, "fl") ?? 0);
      object[`bs${index}`] = channelRecord(original, {
        ky: channelKyById.get(channelId) ?? 0,
        fl: flags,
        ...(perChannel
          ? {
              t1: Math.round(Math.max(0, perChannel.onFade) * 2),
              t2: Math.round(Math.max(0, perChannel.offFade) * 2),
            }
          : {}),
      });
    });
    const originalBsCount = [...Array(8).keys()].filter((index) =>
      legacyChild(settings, `bs${index}`),
    ).length;
    // Basic-assignment channels removed in the editor stay removed.
    for (let index = channelIds.length; index < 8; index += 1)
      delete object[`bs${index}`];
    object.bs =
      channelIds.length === originalBsCount
        ? (legacyNumber(settings, "bs") ?? channelIds.length)
        : channelIds.length;
    object.op =
      wallSwitch.basic?.onPriority ?? legacyBool(settings, "op") ?? false;
    object.ky = entityKey(wallSwitch);
    object.$class = archive.classUid("JCLFDSwitch", ["JCLFDSwitch", "NSObject"]);
    return archive.add(object);
  };

  // --- scene objects --------------------------------------------------------
  const sceneObject = (
    scene: Scene,
    role: "leaf" | "deleted",
  ): PlistUid => {
    const bag = legacyBag(scene.legacy);
    const object: Record<string, PlistValue> = {
      ...bagFields(bag, /^ch\d+$/),
      es: legacyNumber(bag, "es") ?? 0,
      re1: legacyNumber(bag, "re1") ?? 0,
      ns: legacyNumber(bag, "ns") ?? 0,
      sf: legacyNumber(bag, "sf") ?? 0,
      nt: legacyNumber(bag, "nt") ?? 0,
      nd: legacyNumber(bag, "nd") ?? 0,
      cc: 0,
      lk: legacyNumber(bag, "lk") ?? 0,
      fl: legacyNumber(bag, "fl") ?? 0,
      dr: legacyNumber(bag, "dr") ?? 0,
      gr: false,
      pr: legacyNumber(bag, "pr") ?? 0,
      p1: legacyNumber(bag, "p1") ?? 0,
      rm: legacyNumber(bag, "rm") ?? 0,
      ps: legacyNumber(bag, "ps") ?? 0,
      nsm: legacyNumber(bag, "nsm") ?? -1,
      p2: legacyNumber(bag, "p2") ?? 0,
      ty: legacyNumber(bag, "ty") ?? 0,
    };
    object.ky = entityKey(scene);
    object.nm = string(scene.name);
    object.sn = string(scene.shortName ?? scene.name);
    object.gr = false;
    // `dr` is the display rank (recovered from the iOS binary).
    object.dr = scene.displayRank ?? legacyNumber(bag, "dr") ?? 0;
    object.nsm = scene.nextSceneMode ?? -1;
    object.nt = scene.nextSceneTime ?? 0;
    object.nd = scene.nextSceneDay ?? 0;
    object.ns = scene.nextSceneId
      ? (sceneKyById.get(scene.nextSceneId) ?? 0)
      : 0;
    object.ps = scene.previousSceneId
      ? (sceneKyById.get(scene.previousSceneId) ?? 0)
      : 0;
    object.es = scene.extenderSceneId
      ? (sceneKyById.get(scene.extenderSceneId) ?? 0)
      : 0;
    object.re1 = scene.runExtenderFirst ? 1 : 0;
    object.p1 = scene.period1 ?? 0;
    object.p2 = scene.period2 ?? 0;
    object.sf = scene.stateFlag ?? 0;
    // Recompose the editable flag bits over the preserved remainder.
    const baseFlags = scene.flags ?? legacyNumber(bag, "fl") ?? 0;
    object.fl =
      (baseFlags & ~0xa0) |
      (scene.autoStart ? 0x80 : 0) |
      (scene.beginNewSequence ? 0x20 : 0);
    object.lk = scene.locked ? Math.max(1, legacyNumber(bag, "lk") ?? 1) : 0;
    object.ty = scene.sceneType ?? legacyNumber(bag, "ty") ?? 0;

    // Parent link: keep original chains (deleted roots included) when the
    // model still agrees, otherwise the model's group.
    const modelParent = scene.groupId
      ? (groupKyById.get(scene.groupId) ?? 0)
      : 0;
    const originalParent = legacyNumber(bag, "pr");
    if (role === "deleted") {
      object.pr = originalParent !== undefined ? originalParent : -4;
    } else if (scene.groupId) {
      object.pr =
        originalParent === modelParent ? originalParent : modelParent;
    } else {
      object.pr = originalParent ?? 0;
    }

    // Channel records: original slot order first, then newly added channels.
    const settingsById = scene.channelSettings ?? {};
    const orderedChannelIds: number[] = [];
    for (let slot = 0; slot < 19; slot += 1) {
      const original = legacyChild(bag, `ch${slot}`);
      if (!original) continue;
      const originalKy = legacyNumber(original, "ky");
      const channelId = [...channelKyById.entries()].find(
        ([, ky]) => ky === originalKy,
      )?.[0];
      if (
        channelId !== undefined &&
        settingsById[channelId] &&
        !orderedChannelIds.includes(channelId)
      )
        orderedChannelIds.push(channelId);
    }
    for (const channelId of Object.keys(settingsById).map(Number)) {
      if (!orderedChannelIds.includes(channelId))
        orderedChannelIds.push(channelId);
    }
    orderedChannelIds.forEach((channelId, index) => {
      const perChannel: SceneChannelSettings = settingsById[channelId];
      const originalSlot = [...Array(19).keys()].find((slot) => {
        const child = legacyChild(bag, `ch${slot}`);
        return (
          child !== undefined &&
          legacyNumber(child, "ky") === channelKyById.get(channelId)
        );
      });
      const original =
        originalSlot !== undefined
          ? legacyChild(bag, `ch${originalSlot}`)
          : undefined;
      const originalBr = legacyNumber(original ?? {}, "br");
      // Negative br encodes a relative percentage; the importer clamps the
      // displayed brightness, so keep the original byte when it still maps to
      // the model's brightness.
      const importedBr =
        originalBr !== undefined && originalBr >= 0 && originalBr <= 100
          ? originalBr
          : 100;
      const flags =
        (perChannel.flags & ~0x90) |
        (perChannel.relativePercent ? 0x80 : 0) |
        (perChannel.use100PercentTime ? 0x10 : 0);
      object[`ch${index}`] = channelRecord(original, {
        ky: channelKyById.get(channelId) ?? 0,
        br:
          importedBr === perChannel.brightness && originalBr !== undefined
            ? originalBr
            : perChannel.brightness,
        t1: Math.round(Math.max(0, perChannel.fadeTime) * 2),
        de: Math.round(Math.max(0, perChannel.delay) * 2),
        fl: flags,
      });
    });
    object.cc = orderedChannelIds.length;
    // Channels removed in the editor must not resurface from the legacy bag.
    for (let index = orderedChannelIds.length; index < 19; index += 1)
      delete object[`ch${index}`];
    object.$class = archive.classUid("JCLFDScene", ["JCLFDScene", "NSObject"]);
    return archive.add(object);
  };

  const groupObject = (group: SceneGroup): PlistUid => {
    const bag = legacyBag((group as unknown as ArchiveEntity).legacy);
    return archive.add({
      ...bagFields(bag),
      es: legacyNumber(bag, "es") ?? 0,
      re1: legacyNumber(bag, "re1") ?? 0,
      ns: legacyNumber(bag, "ns") ?? 0,
      sf: legacyNumber(bag, "sf") ?? 0,
      nt: legacyNumber(bag, "nt") ?? 0,
      nd: legacyNumber(bag, "nd") ?? 0,
      cc: legacyNumber(bag, "cc") ?? 0,
      lk: legacyNumber(bag, "lk") ?? 0,
      fl: legacyNumber(bag, "fl") ?? 0,
      dr: group.displayRank,
      gr: true,
      pr: group.parentId ? (groupKyById.get(group.parentId) ?? 0) : (legacyNumber(bag, "pr") ?? 0),
      p1: legacyNumber(bag, "p1") ?? 0,
      rm: Number(/rooms\/(\d+)\.png$/.exec(group.icon)?.[1] ?? legacyNumber(bag, "rm") ?? 0),
      ps: legacyNumber(bag, "ps") ?? 0,
      ky: entityKey(group as unknown as ArchiveEntity),
      nsm: legacyNumber(bag, "nsm") ?? -1,
      p2: legacyNumber(bag, "p2") ?? 0,
      ty: legacyNumber(bag, "ty") ?? 0,
      nm: string(group.name),
      sn: string(group.shortName ?? group.name),
      $class: archive.classUid("JCLFDScene", ["JCLFDScene", "NSObject"]),
    });
  };

  const periodObject = (period: Period): PlistUid => {
    const bag = legacyBag(period.legacy);
    const minutesOf = (value: string, fallback: number) => {
      const match = /^(\d+):(\d\d)$/.exec(value.trim());
      return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
    };
    return archive.add({
      ...bagFields(bag),
      nm: string(period.name),
      et: minutesOf(period.end, legacyNumber(bag, "et") ?? 0),
      sm: period.startMode ?? legacyNumber(bag, "sm") ?? 0,
      em: period.endMode ?? legacyNumber(bag, "em") ?? 0,
      st: minutesOf(period.start, legacyNumber(bag, "st") ?? 0),
      ix: period.legacyIndex ?? legacyNumber(bag, "ix") ?? 0,
      $class: archive.classUid("JCLFDPeriod", ["JCLFDPeriod", "NSObject"]),
    });
  };
  const stateFlagObject = (stateFlag: StateFlag): PlistUid => {
    const bag = legacyBag(stateFlag.legacy);
    return archive.add({
      ...bagFields(bag),
      nm: string(stateFlag.name),
      et: legacyNumber(bag, "et") ?? 0,
      sm: legacyNumber(bag, "sm") ?? 0,
      em: legacyNumber(bag, "em") ?? 0,
      st: legacyNumber(bag, "st") ?? 0,
      ix: stateFlag.legacyIndex ?? legacyNumber(bag, "ix") ?? 0,
      $class: archive.classUid("JCLFDPeriod", ["JCLFDPeriod", "NSObject"]),
    });
  };

  const userObject = (user: FlexUser): PlistUid => {
    const bag = legacyBag(user.legacy);
    const rawRoomAccess = user.roomAccess ?? [];
    const roomIdByKy = new Map(
      [...roomKyById].map(([id, key]) => [key, id]),
    );
    const switchIdByKy = new Map(
      [...switchKyById].map(([id, key]) => [key, id]),
    );
    const rawRoomIds = rawRoomAccess.flatMap((entry) => {
      const id = roomIdByKy.get(Number(entry.split("|")[0]));
      return id === undefined ? [] : [id];
    });
    const rawSwitchIds = rawRoomAccess.flatMap((entry) =>
      entry.split("|").slice(1).flatMap((value) => {
        const id = switchIdByKy.get(Number(value));
        return id === undefined ? [] : [id];
      }),
    );
    const sameIds = (left: number[], right: number[]) =>
      left.length === right.length &&
      left.every((value) => right.includes(value));
    const editableProjectionUnchanged =
      user.roomIds !== undefined &&
      user.switchIds !== undefined &&
      sameIds(rawRoomIds, user.roomIds) &&
      sameIds(rawSwitchIds, user.switchIds);
    const roomAccess =
      user.roomIds === undefined ||
      user.switchIds === undefined ||
      editableProjectionUnchanged
        ? rawRoomAccess
        : rooms.flatMap((room) => {
            const selectedSwitches = switches.filter(
              (wallSwitch) =>
                wallSwitch.roomId === room.id &&
                user.switchIds?.includes(wallSwitch.id),
            );
            if (!user.roomIds?.includes(room.id) && !selectedSwitches.length)
              return [];
            const roomKey = roomKyById.get(room.id);
            if (roomKey === undefined) return [];
            return [[
              roomKey,
              ...selectedSwitches.flatMap((wallSwitch) => {
                const key = switchKyById.get(wallSwitch.id);
                return key === undefined ? [] : [key];
              }),
            ].join("|")];
          });
    const object: Record<string, PlistValue> = {
      ...bagFields(bag, /^(rm\d+|sk)$/),
      ky: entityKey(user),
      nm: string(user.name),
      sk: archive.mutableString(user.securityCode ?? user.key ?? ""),
      rc: editableProjectionUnchanged
        ? (user.accessCount ?? roomAccess.length)
        : roomAccess.length,
      ve: user.profileVersion ?? legacyNumber(bag, "ve") ?? 0,
    };
    for (let index = 0; index < 32; index += 1) {
      if (index < roomAccess.length)
        object[`rm${index}`] = archive.mutableString(roomAccess[index]);
      else delete object[`rm${index}`];
    }
    object.$class = archive.classUid("JCLFDUser", ["JCLFDUser", "NSObject"]);
    return archive.add(object);
  };

  // --- assemble $top in the recovered positional encode order ---------------
  const top: Record<string, PlistValue> = {};
  let slot = 0;
  const emit = (uid: PlistUid) => {
    top[`$${slot}`] = uid;
    slot += 1;
  };
  const emitString = (value: string) => emit(string(value));

  const addressLines = site.addressLines ?? ["", "", "", ""];
  emitString(rawTopString(0) ?? "29"); // $0 format marker
  emitString(site.name); // $1
  for (let line = 0; line < 4; line += 1)
    emitString(addressLines[line] ?? ""); // $2..$5
  emitString(site.contact ?? ""); // $6
  emitString(site.phone ?? ""); // $7
  emitString(site.email ?? ""); // $8
  emitString(site.id); // $9
  emitString(site.securityCode ?? ""); // $10
  emitString(site.ip); // $11
  emitString(site.autoDetect === false ? "0" : "1"); // $12
  emitString(site.modulesChanged ? "1" : "0"); // $13 modules-changed flag
  emit(
    archive.date(
      site.updatedAt || legacyDateIso(rawTop, "$14") || "2001-01-01T00:00:00Z",
    ),
  ); // $14
  emitString(site.longitude ?? ""); // $15
  emitString(site.latitude ?? ""); // $16
  emitString(rawTopString(17) ?? "0"); // $17 raw legacy time zone value
  emitString(site.routerInbound ? "1" : "0"); // $18 router-inbound flag
  // $19 router-inbound port: keep the original slot when it still maps to the
  // model's port (the importer treats sub-1024 remnants as unset).
  {
    const raw = rawTopString(19);
    const rawPort = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
    const importedPort = rawPort >= 1024 ? rawPort : 15273;
    emitString(
      importedPort === (site.routerPort ?? 15273)
        ? (raw ?? "0")
        : String(site.routerPort ?? 0),
    );
  }
  // $20 DST rule string.
  {
    const raw = rawTopString(20);
    const rawImports = raw !== undefined
      ? /uk|europe/i.test(raw)
        ? "UK / Europe"
        : /usa|us\b/i.test(raw)
          ? "USA"
          : "No daylight saving"
      : undefined;
    emitString(
      rawImports === site.dst
        ? (raw as string)
        : (DST_ARCHIVE_NAME[site.dst] ?? site.dst),
    );
  }
  // $21..$24 wireless-gateway addresses and $25..$28 their counts.
  const gateways = site.wirelessGateways ?? [];
  const rawGatewayAddresses = [0, 1, 2, 3].map((index) =>
    rawTopString(21 + index),
  );
  const rawImportedGateways = rawGatewayAddresses.flatMap((address, index) =>
    address
      ? [{ address, count: Number(rawTopString(25 + index) ?? 0) || 0 }]
      : [],
  );
  const gatewaysUnchanged =
    JSON.stringify(rawImportedGateways) === JSON.stringify(gateways);
  for (let index = 0; index < 4; index += 1)
    emitString(
      gatewaysUnchanged
        ? (rawGatewayAddresses[index] ?? "")
        : (gateways[index]?.address ?? ""),
    );
  for (let index = 0; index < 4; index += 1)
    emitString(
      gatewaysUnchanged || !gateways[index]
        ? (rawTopString(25 + index) ?? "")
        : String(gateways[index].count),
    );
  emitString(site.remoteServer ?? ""); // $29

  const moduleOrderA = site.moduleOrderA ?? [];
  const moduleOrderB = site.moduleOrderB ?? [];
  for (const moduleId of moduleOrderA) emitString(String(moduleId));
  for (const moduleId of moduleOrderB) emitString(String(moduleId));

  for (const entry of hardwareEntries) emit(entry.uid());

  // Post-hardware site fields (three strings and an NSDate in the reference
  // archive). Their slots shift with the counts, so recompute the original
  // positions from the original counts before falling back to defaults.
  const originalModc = legacyNumber(rawTop, "modc") ?? moduleOrderA.length;
  const originalModcB = legacyNumber(rawTop, "modcB") ?? moduleOrderB.length;
  const originalHwc = legacyNumber(rawTop, "hwc") ?? hardwareEntries.length;
  const originalExtraBase = 30 + originalModc + originalModcB + originalHwc;
  // Post-hardware slots: configuration name, description, an eight-character
  // code (preserved verbatim) and the configuration's update date.
  const activeConfiguration =
    data.configurations?.find(
      (configuration) => configuration.id === data.activeConfigId,
    ) ?? data.configurations?.[0];
  {
    // Keep the raw slots when the model still shows what the importer derived
    // from them, so web-side fallbacks never leak into the archive.
    const rawName = rawTopString(originalExtraBase);
    const importedName = rawName || site.name;
    emitString(
      activeConfiguration && activeConfiguration.name !== importedName
        ? activeConfiguration.name
        : (rawName ?? activeConfiguration?.name ?? ""),
    );
    const rawDescription = rawTopString(originalExtraBase + 1);
    const importedDescription = rawDescription || site.description;
    emitString(
      activeConfiguration &&
        activeConfiguration.description !== importedDescription
        ? activeConfiguration.description
        : (rawDescription ?? activeConfiguration?.description ?? ""),
    );
  }
  {
    const rawControllerCode = rawTopString(originalExtraBase + 2) ?? "";
    emitString(
      activeConfiguration?.controllerCode !== undefined &&
        activeConfiguration.controllerCode !== rawControllerCode
        ? activeConfiguration.controllerCode
        : rawControllerCode,
    );
  }
  emit(
    archive.date(
      activeConfiguration?.lastUpdated ||
        legacyDateIso(rawTop, `$${originalExtraBase + 3}`) ||
        site.updatedAt ||
        "2001-01-01T00:00:00Z",
    ),
  );

  emitString(String(switches.length));
  for (const wallSwitch of switches) emit(switchObject(wallSwitch));

  // Scenes: groups and leaf/deleted scenes share one section, in the original
  // archive order where known.
  const sceneEntries: { ky: number; uid: () => PlistUid }[] = [
    ...sceneGroups.map((group) => ({
      ky: entityKey(group as unknown as ArchiveEntity),
      uid: () => groupObject(group),
    })),
    ...scenes.map((scene) => ({
      ky: entityKey(scene),
      uid: () => sceneObject(scene, "leaf" as const),
    })),
    ...deletedScenes.map((scene) => ({
      ky: entityKey(scene),
      uid: () => sceneObject(scene, "deleted" as const),
    })),
  ];
  const sceneOrder = Array.isArray(siteLegacy.sceneOrder)
    ? (siteLegacy.sceneOrder as number[])
    : [];
  const sceneRank = new Map(sceneOrder.map((ky, index) => [ky, index]));
  sceneEntries.sort(
    (a, b) =>
      (sceneRank.get(a.ky) ?? sceneOrder.length) -
      (sceneRank.get(b.ky) ?? sceneOrder.length),
  );
  emitString(String(sceneEntries.length));
  for (const entry of sceneEntries) emit(entry.uid());

  emitString(String(periods.length + stateFlags.length));
  for (const period of periods) emit(periodObject(period));
  for (const stateFlag of stateFlags) emit(stateFlagObject(stateFlag));

  emitString(String(users.length));
  for (const user of users) emit(userObject(user));

  // Preserve any trailing top-level fields beyond the recovered layout (a
  // future iOS build may append fields the web model does not understand).
  // The original end of the user section is recomputed from the original
  // count strings so trailing slots keep their relative position.
  const rawCount = (countSlot: number) => {
    const raw = rawTopString(countSlot);
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
  };
  let originalTrailingBase = Number.POSITIVE_INFINITY;
  const originalSwitchCountSlot = originalExtraBase + 4;
  const originalSwc = rawCount(originalSwitchCountSlot);
  if (originalSwc !== undefined) {
    const sceneCountSlot = originalSwitchCountSlot + 1 + originalSwc;
    const originalScc = rawCount(sceneCountSlot);
    if (originalScc !== undefined) {
      const periodCountSlot = sceneCountSlot + 1 + originalScc;
      const originalPec = rawCount(periodCountSlot);
      if (originalPec !== undefined) {
        const userCountSlot = periodCountSlot + 1 + originalPec;
        const originalUsc = rawCount(userCountSlot);
        if (originalUsc !== undefined)
          originalTrailingBase = userCountSlot + 1 + originalUsc;
      }
    }
  }
  const trailingSlots = Object.keys(rawTop)
    .map((key) => /^\$(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((index) => index >= originalTrailingBase)
    .sort((a, b) => a - b);
  for (const originalSlot of trailingSlots) {
    const raw = rawTop[`$${originalSlot}`];
    if (typeof raw === "string") emitString(raw);
    else if (typeof raw === "number") emit(archive.add(raw));
    else {
      const dateIso = legacyDateIso(rawTop, `$${originalSlot}`);
      if (dateIso !== undefined) emit(archive.date(dateIso));
    }
  }

  top.hwc = hardwareEntries.length;
  top.modc = moduleOrderA.length;
  top.modcB = moduleOrderB.length;

  const root: Record<string, PlistValue> = {
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: top,
    $objects: archive.objects,
  };
  return writeBinaryPlist(root);
}
