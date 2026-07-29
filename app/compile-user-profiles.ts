import type { AppData, Configuration, FlexUser, Room, WallSwitch } from "./fd4cfg";
import { foundationDictionaryOrder } from "./foundation-dictionary-order.ts";

export type UserProfileCompileResult = {
  payloads: Uint8Array[];
  complete: boolean;
  problems: string[];
};

const BUTTON_SCENE_SLOTS = 24;

/**
 * The archive key (`ky`) each user is stored under, mirroring the exporter:
 * an imported user keeps its key, and anything else takes the lowest unused
 * one. This is the dictionary key the original app orders users by.
 */
function userArchiveKeys(users: FlexUser[]): number[] {
  const used = new Set(
    users.flatMap((user) =>
      typeof user.legacyKey === "number" && user.legacyKey > 0
        ? [user.legacyKey]
        : [],
    ),
  );
  let next = 1;
  return users.map((user) => {
    if (typeof user.legacyKey === "number" && user.legacyKey > 0)
      return user.legacyKey;
    while (used.has(next)) next += 1;
    used.add(next);
    return next;
  });
}

/**
 * User indices in the order the original app transmits profiles.
 *
 * `JCLFDConfig.users` is an NSMutableDictionary keyed by the decimal string of
 * each user's `ky`, and the sender walks the list built from enumerating it —
 * so the wire index of a profile follows Darwin's hash-bucket order, not the
 * archive's slot order. Proven with tools/oracle/private/user_order.m: five
 * users keyed 501..505 enumerate as 504, 501, 505, 502, 503, exactly as
 * `foundationDictionaryOrder` predicts. Up to three users the order is the
 * identity, which is why smaller configurations never revealed this.
 */
export function userProfileSendOrder(users: FlexUser[] = []): number[] {
  return foundationDictionaryOrder(userArchiveKeys(users));
}

function channelProfileSuffix(
  hardwareType: number | undefined,
  accessoryType: number | undefined,
): string[] | undefined {
  if (hardwareType === 0) return [];
  if (hardwareType === 1) return [accessoryType === 1 ? "0" : "1"];
  if (hardwareType !== undefined && hardwareType >= 2 && hardwareType <= 6)
    return ["0"];
  // Exhaustive synthetic mutation of the one-byte hardware field established
  // that every value 7..255 emits only name/address, with no suffix.
  if (
    hardwareType !== undefined &&
    Number.isInteger(hardwareType) &&
    hardwareType >= 7 &&
    hardwareType <= 0xff
  )
    return [];
  return undefined;
}

function iconIndex(room: Room) {
  const match = /\/(\d+)\.png$/.exec(room.icon);
  return match ? Number(match[1]) : 0;
}

function configurationFor(data: AppData): Configuration | undefined {
  return (
    data.configurations?.find(
      (configuration) => configuration.id === data.activeConfigId,
    ) ?? data.configurations?.[0]
  );
}

function accessEntries(data: AppData, user: FlexUser) {
  const raw = (user.roomAccess ?? []).map((entry) =>
    entry
      .split("|")
      .map(Number)
      .filter(Number.isFinite),
  );
  if (user.roomIds === undefined || user.switchIds === undefined) return raw;
  const roomIdByKey = new Map(
    data.rooms.flatMap((room) =>
      room.legacyKey === undefined ? [] : [[room.legacyKey, room.id] as const]),
  );
  const switchIdByKey = new Map(
    data.switches.flatMap((wallSwitch) =>
      wallSwitch.legacyKey === undefined
        ? []
        : [[wallSwitch.legacyKey, wallSwitch.id] as const]),
  );
  const rawRoomIds = raw.flatMap(([roomKey]) => {
    const id = roomIdByKey.get(roomKey);
    return id === undefined ? [] : [id];
  });
  const rawSwitchIds = raw.flatMap(([, ...switchKeys]) =>
    switchKeys.flatMap((key) => {
      const id = switchIdByKey.get(key);
      return id === undefined ? [] : [id];
    }),
  );
  const sameIds = (left: number[], right: number[]) =>
    left.length === right.length &&
    left.every((value) => right.includes(value));
  if (
    sameIds(rawRoomIds, user.roomIds) &&
    sameIds(rawSwitchIds, user.switchIds)
  )
    return raw;

  return data.rooms.flatMap((room) => {
    const selectedSwitches = data.switches.filter(
      (wallSwitch) =>
        wallSwitch.roomId === room.id &&
        user.switchIds?.includes(wallSwitch.id),
    );
    if (!user.roomIds?.includes(room.id) && !selectedSwitches.length) return [];
    if (room.legacyKey === undefined) return [[]];
    return [[
      room.legacyKey,
      ...selectedSwitches.flatMap((wallSwitch) =>
        wallSwitch.legacyKey === undefined ? [] : [wallSwitch.legacyKey]),
    ]];
  });
}

function buttonSceneNames(data: AppData, wallSwitch: WallSwitch) {
  const names = Array.from({ length: BUTTON_SCENE_SLOTS }, () => "");
  for (const assignment of data.assignments) {
    if (
      assignment.switchId !== wallSwitch.id ||
      assignment.button < 1 ||
      assignment.button > BUTTON_SCENE_SLOTS ||
      !assignment.sceneId
    )
      continue;
    const scene = data.scenes.find((candidate) => candidate.id === assignment.sceneId);
    if (scene)
      names[assignment.button - 1] = scene.shortName ?? scene.name;
  }

  // JCLFDSwitch.buttonScenes exposes the three built-in basic-assignment
  // actions in these logical slots. The oracle shows them for both recovered
  // scene-switch families (types 13 and 15).
  if (wallSwitch.basic?.channelIds.length) {
    if (!names[16]) names[16] = "Up";
    if (!names[18]) names[18] = "Down";
    if (!names[22]) names[22] = "On Off";
  }
  return names;
}

/**
 * Reproduce the UTF-8 `JCLFDUser.uData` strings built by the original iOS
 * `initUserData` method before its F2 transfer phase.
 *
 * This is intentionally narrower than the editor's model and fails closed
 * when required legacy profile fields are missing or outside the one-byte
 * hardware domain proven by the oracle.
 */
export function compileUserProfiles(data: AppData): UserProfileCompileResult {
  const problems: string[] = [];
  const configuration = configurationFor(data);
  const controllerCode = configuration?.controllerCode ?? "";
  if (!/^[A-Za-z0-9]{8}$/.test(controllerCode))
    problems.push("active configuration must have an eight-character controller code");
  for (const channel of data.channels) {
    if (channel.legacyKey !== undefined && channel.profileOrder === undefined)
      problems.push(
        `imported channel ${channel.id} is missing its retained profile order`,
      );
  }

  const roomsByKey = new Map(
    data.rooms.flatMap((room) =>
      room.legacyKey === undefined ? [] : [[room.legacyKey, room] as const]),
  );
  const switchesByKey = new Map(
    data.switches.flatMap((wallSwitch) =>
      wallSwitch.legacyKey === undefined
        ? []
        : [[wallSwitch.legacyKey, wallSwitch] as const]),
  );

  const payloads = data.users.map((user, userIndex) => {
    const securityCode = user.securityCode ?? user.key;
    if (securityCode.length !== 16)
      problems.push(`user ${userIndex + 1} must have a 16-character security code`);
    if (
      user.profileStatus === "imported" &&
      user.roomAccess?.length &&
      !(user.roomIds?.length || user.switchIds?.length)
    )
      problems.push(
        `imported user ${userIndex + 1} has unresolved room and switch access`,
      );

    const entries = accessEntries(data, user);
    const floorNames: string[] = [];
    for (const entry of entries) {
      const floorName = String(roomsByKey.get(entry[0])?.legacy?.fn ?? "");
      if (
        !floorNames.some(
          (candidate) => candidate.toUpperCase() === floorName.toUpperCase(),
        )
      )
        floorNames.push(floorName);
    }
    const fields = [
      securityCode,
      user.name,
      controllerCode.length === 8
        ? `${controllerCode.slice(0, 4)}:${controllerCode.slice(4)}`
        : "",
      String(floorNames.length),
      ...floorNames,
      String(entries.length),
    ];

    entries.forEach((entry, entryIndex) => {
      const room = roomsByKey.get(entry[0]);
      if (!room) {
        problems.push(`user ${userIndex + 1} access entry ${entryIndex + 1} has an unknown room key`);
        return;
      }
      const selectedSwitches = entry.slice(1).flatMap((key) => {
        const wallSwitch = switchesByKey.get(key);
        if (!wallSwitch || wallSwitch.roomId !== room.id) {
          problems.push(
            `user ${userIndex + 1} access entry ${entryIndex + 1} has an unknown switch key`,
          );
          return [];
        }
        return [wallSwitch];
      });
      // Hardware type 0 is "not used" in the type-0 sender and is omitted from
      // both the room channel count and the following channel records.
      const channels = data.channels.filter(
        (channel) => channel.roomId === room.id && channel.hardwareType !== 0,
      ).sort(
        (left, right) =>
          (left.displayRank ?? left.id) - (right.displayRank ?? right.id) ||
          (left.profileOrder ?? left.id) - (right.profileOrder ?? right.id),
      );

      fields.push(
        room.shortName ?? room.name,
        String(iconIndex(room)),
        String(
          floorNames.findIndex(
            (floorName) =>
              floorName.toUpperCase() ===
              String(room.legacy?.fn ?? "").toUpperCase(),
          ),
        ),
        String(selectedSwitches.length),
        String(channels.length),
      );

      for (const wallSwitch of selectedSwitches) {
        const switchNumber = wallSwitch.number ?? 0;
        fields.push(
          wallSwitch.name,
          String(switchNumber),
          switchNumber === 0
            ? "9"
            : wallSwitch.hardwareType === 15 || wallSwitch.type === 15
              ? "0"
              : "1",
          ...buttonSceneNames(data, wallSwitch),
        );
      }

      for (const channel of channels) {
        fields.push(channel.name, String(channel.controllerChannel ?? 0));
        const suffix = channelProfileSuffix(
          channel.hardwareType,
          channel.accessoryType,
        );
        if (suffix) fields.push(...suffix);
        else
          problems.push(
            `channel ${channel.id} user-profile suffix for hardware type ${channel.hardwareType ?? 0} is not oracle-proven`,
          );
      }
    });

    return new TextEncoder().encode(`${fields.join("|")}|`);
  });

  return {
    payloads: userProfileSendOrder(data.users).map((index) => payloads[index]),
    complete: problems.length === 0,
    problems: [...new Set(problems)],
  };
}
