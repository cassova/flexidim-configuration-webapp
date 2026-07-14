import { parse } from "@plist/binary.parse";

export type Room = {
  id: number;
  name: string;
  floor: string;
  icon: string;
  parentId?: number | null;
  shortName?: string;
  areaType?: "Floor" | "Area" | "Room";
};
export type Channel = {
  id: number;
  name: string;
  roomId: number;
  module: string;
  kind: string;
  level: number;
  moduleId?: number;
  accessoryModule?: string;
  minimum?: number;
  maximum?: number;
  defaultLevel?: number;
};
export type WallSwitch = {
  id: number;
  name: string;
  roomId: number;
  kind: string;
  buttons: number;
  basic?: {
    channelIds: number[];
    assignOn: boolean;
    assignOff?: boolean;
    assignDimming: boolean;
    assignChannelDimming: boolean;
    onTime: number;
    offTime: number;
    offPriority: number;
    onPriority?: boolean;
    channelSettings?: Record<
      number,
      {
        assignOn: boolean;
        assignOff: boolean;
        assignDimming: boolean;
        assignChannelDimming: boolean;
        onPriority: boolean;
        offPriority: boolean;
        onFade: number;
        offFade: number;
      }
    >;
  };
  number?: number;
  ledBrightness?: number;
  defaultBrightness?: number;
};
export type FlexModule = {
  id: number;
  name: string;
  bus: "A" | "B";
  enabled: boolean;
  pending: boolean;
};
export type SceneGroup = {
  id: number;
  name: string;
  shortName: string;
  parentId: number | null;
  icon: string;
  displayRank: number;
};
export type SceneChannelSettings = {
  brightness: number;
  fadeTime: number;
  relativePercent: boolean;
  use100PercentTime: boolean;
  delay: number;
  flags: number;
};
export type Scene = {
  id: number;
  name: string;
  shortName?: string;
  group: string;
  groupId?: number;
  folderPath?: string[];
  levels: Record<number, number>;
  channelSettings?: Record<number, SceneChannelSettings>;
  fade: number;
  enabled: boolean;
  days: string[];
  time: string;
  autoStart?: boolean;
  nextSceneId?: number;
  nextSceneMode?: number;
  nextSceneTime?: number;
  nextSceneDay?: number;
  previousSceneId?: number;
  extenderSceneId?: number;
  runExtenderFirst?: boolean;
  beginNewSequence?: boolean;
  period1?: number;
  period2?: number;
  stateFlag?: number;
  flags?: number;
  utility?: "extractor" | "security" | "simple";
};
export type Period = {
  id: number;
  name: string;
  start: string;
  end: string;
  days: string[];
  enabled: boolean;
};
export type FlexUser = {
  id: number;
  name: string;
  remote: boolean;
  changes: boolean;
  key: string;
};
export type Assignment = {
  switchId: number;
  button: number;
  sceneId?: number;
  channelId?: number;
  channelIds?: number[];
  secondSceneId?: number;
  secondChannelId?: number;
};
export type DeletedItem =
  | { key: string; type: "area"; item: Room }
  | { key: string; type: "switch"; item: WallSwitch }
  | { key: string; type: "light"; item: Channel }
  | { key: string; type: "module"; item: FlexModule };
export type Site = {
  name: string;
  id: string;
  ip: string;
  port: number;
  description: string;
  address: string;
  timezone: string;
  dst: string;
  remote: boolean;
};
export type AppData = {
  site: Site;
  sites?: Site[];
  rooms: Room[];
  channels: Channel[];
  switches: WallSwitch[];
  sceneGroups?: SceneGroup[];
  scenes: Scene[];
  deletedScenes?: Scene[];
  periods: Period[];
  users: FlexUser[];
  assignments: Assignment[];
  modules?: FlexModule[];
  deletedItems?: DeletedItem[];
};

type ArchiveObject = Record<string, unknown>;
type UID = { CF$UID?: number; UID?: number };

const allDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const roomIcons = [
  "/flexidim/room-0.png",
  "/flexidim/room-3.png",
  "/flexidim/room-10.png",
  "/flexidim/room-100.png",
];

function uid(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as UID;
  return Number.isInteger(candidate["CF$UID"])
    ? candidate["CF$UID"]
    : Number.isInteger(candidate.UID)
      ? candidate.UID
      : undefined;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Convert the original iOS NSKeyedArchiver document into the web app model. */
export function convertLegacyArchive(archive: unknown): AppData {
  if (!archive || typeof archive !== "object")
    throw new Error("The legacy configuration is not an archive");
  const root = archive as ArchiveObject;
  if (
    root.$archiver !== "NSKeyedArchiver" ||
    !Array.isArray(root.$objects) ||
    !root.$top ||
    typeof root.$top !== "object"
  ) {
    throw new Error("The file is not a FlexiDim iOS configuration");
  }

  const objects = root.$objects as unknown[];
  const top = root.$top as ArchiveObject;
  const dereference = (value: unknown): unknown => {
    const index = uid(value);
    return index === undefined ? value : objects[index];
  };
  const object = (value: unknown): ArchiveObject | undefined => {
    const resolved = dereference(value);
    return resolved && typeof resolved === "object" && !Array.isArray(resolved)
      ? (resolved as ArchiveObject)
      : undefined;
  };
  const className = (value: unknown): string => {
    const resolved = object(value);
    const classObject = resolved ? object(resolved.$class) : undefined;
    return typeof classObject?.$classname === "string"
      ? classObject.$classname
      : "";
  };
  const string = (value: unknown): string => {
    const resolved = dereference(value);
    if (typeof resolved === "string") return resolved;
    const wrapped = object(resolved);
    return typeof wrapped?.["NS.string"] === "string"
      ? wrapped["NS.string"]
      : "";
  };
  const topString = (key: string) => string(top[key]).trim();
  const instances = (name: string) =>
    Object.values(top)
      .filter((value) => className(value) === name)
      .map((value) => object(value)!)
      .filter(Boolean);

  const hardware = instances("JCLFDHardware");
  if (!hardware.length)
    throw new Error("No FlexiDim hardware was found in the archive");
  const hardwareByKey = new Map(
    hardware.map((item) => [number(item.ky), item]),
  );
  const roomHardware = hardware.filter((item) => number(item.ty) === 0);
  const roomIdByKey = new Map(
    roomHardware.map((item, index) => [number(item.ky), index + 1]),
  );
  const parentRoomId = (item: ArchiveObject): number => {
    let parentKey = number(item.pr);
    const visited = new Set<number>();
    while (parentKey && !visited.has(parentKey)) {
      visited.add(parentKey);
      const direct = roomIdByKey.get(parentKey);
      if (direct) return direct;
      parentKey = number(hardwareByKey.get(parentKey)?.pr);
    }
    return 1;
  };

  const rooms: Room[] = roomHardware.map((item, index) => {
    const parent = hardwareByKey.get(number(item.pr));
    return {
      id: index + 1,
      name: string(item.nm) || `Area ${index + 1}`,
      floor:
        parent && number(parent.ty) === 0
          ? string(parent.nm) || "FlexiDim"
          : "FlexiDim",
      icon: `/flexidim/rooms/${Math.max(0, number(item.ri))}.png`,
      parentId:
        parent && number(parent.ty) === 0
          ? (roomIdByKey.get(number(parent.ky)) ?? null)
          : null,
    };
  });
  if (!rooms.length)
    rooms.push({
      id: 1,
      name: "FlexiDim",
      floor: "FlexiDim",
      icon: roomIcons[0],
    });

  const channelHardware = hardware.filter((item) => number(item.ty) === 2);
  const channelIdByKey = new Map(
    channelHardware.map((item, index) => [number(item.ky), index + 1]),
  );
  const channels: Channel[] = channelHardware.map((item, index) => ({
    id: index + 1,
    name: string(item.nm) || `Channel ${index + 1}`,
    roomId: parentRoomId(item),
    module:
      number(item.md, -1) >= 0
        ? `Module ${number(item.md)} / Ch${number(item.ix) + 1}`
        : `Channel ${number(item.ix) + 1}`,
    kind: `FlexiDim type ${number(item.hw)}`,
    level: 0,
    moduleId: number(item.md, -1) >= 0 ? number(item.md) : undefined,
    accessoryModule: "None",
    minimum: 0,
    maximum: 100,
    defaultLevel: 100,
  }));
  const modules: FlexModule[] = [
    ...new Set(
      channelHardware
        .map((item) => number(item.md, -1))
        .filter((moduleId) => moduleId >= 0),
    ),
  ].map((moduleId) => ({
    id: moduleId,
    name: `Module ${moduleId}`,
    bus: "A",
    enabled: true,
    pending: false,
  }));

  const switchSettings = instances("JCLFDSwitch");
  const switchSettingsByKey = new Map(
    switchSettings.map((item) => [number(item.ky), item]),
  );
  const switchHardware = hardware.filter((item) => number(item.ty) === 1);
  const switchIdByKey = new Map(
    switchHardware.map((item, index) => [number(item.ky), index + 1]),
  );
  const switches: WallSwitch[] = switchHardware.map((item, index) => {
    const settings = switchSettingsByKey.get(number(item.ky));
    const archivedButtons = settings
      ? Object.keys(settings).flatMap((key) => {
          const match = /^bu(\d+)$/.exec(key);
          return match ? [Number(match[1]) + 1] : [];
        })
      : [];
    const buttons = Math.max(4, ...archivedButtons);
    const basicChannelIndexes = settings
      ? Object.keys(settings)
          .flatMap((key) => {
            const match = /^bs(\d+)$/.exec(key);
            return match ? [Number(match[1])] : [];
          })
          .sort((a, b) => a - b)
      : [];
    const basicChannels = basicChannelIndexes
      .map((channelIndex) => object(settings?.[`bs${channelIndex}`]))
      .filter((channel): channel is ArchiveObject => Boolean(channel));
    const channelIds = basicChannels.flatMap((channel) => {
      const channelId = channelIdByKey.get(number(channel.ky));
      return channelId ? [channelId] : [];
    });
    const onPriority = number(settings?.op) > 0;
    const channelSettings = Object.fromEntries(
      basicChannels.flatMap((channel) => {
        const channelId = channelIdByKey.get(number(channel.ky));
        if (!channelId) return [];
        const flags = number(channel.fl);
        return [
          [
            channelId,
            {
              assignOn: Boolean(flags & 1),
              assignOff: Boolean(flags & 2),
              assignDimming: Boolean(flags & 4),
              assignChannelDimming: Boolean(flags & 8),
              onPriority,
              offPriority: !onPriority,
              // The iOS archive stores half-second transition steps.
              onFade: Math.max(0, number(channel.t1)) / 2,
              offFade: Math.max(0, number(channel.t2)) / 2,
            },
          ],
        ];
      }),
    );
    const firstChannel = channelIds.length
      ? channelSettings[channelIds[0]]
      : undefined;
    return {
      id: index + 1,
      name: string(item.nm) || `Switch ${index + 1}`,
      roomId: parentRoomId(item),
      kind: `${buttons} scene`,
      buttons,
      basic: {
        channelIds,
        assignOn: firstChannel?.assignOn ?? false,
        assignOff: firstChannel?.assignOff ?? false,
        assignDimming: firstChannel?.assignDimming ?? false,
        assignChannelDimming: firstChannel?.assignChannelDimming ?? false,
        onTime: firstChannel?.onFade ?? 0,
        offTime: firstChannel?.offFade ?? 0,
        offPriority: firstChannel?.offPriority ? 1 : 0,
        onPriority: firstChannel?.onPriority ?? false,
        channelSettings,
      },
    };
  });

  const archivedScenes = instances("JCLFDScene");
  const sceneByKey = new Map(
    archivedScenes.map((item) => [number(item.ky), item]),
  );
  const isSceneGroup = (item: ArchiveObject) =>
    item.gr === true || number(item.gr) > 0;
  const isDeletedScene = (item: ArchiveObject) => {
    let parentKey = number(item.pr);
    const visited = new Set<number>();
    while (parentKey && !visited.has(parentKey)) {
      if (parentKey === -4) return true;
      visited.add(parentKey);
      parentKey = number(sceneByKey.get(parentKey)?.pr);
    }
    return false;
  };
  const archivedGroups = archivedScenes.filter(
    (item) => isSceneGroup(item) && !isDeletedScene(item),
  );
  const sceneGroupIdByKey = new Map(
    archivedGroups.map((item, index) => [number(item.ky), index + 1]),
  );
  const sceneGroups: SceneGroup[] = archivedGroups
    .map((item, index) => ({
      id: index + 1,
      name: string(item.nm) || `Scene group ${index + 1}`,
      shortName:
        string(item.sn) || string(item.nm) || `Scene group ${index + 1}`,
      parentId: sceneGroupIdByKey.get(number(item.pr)) ?? null,
      icon: `/flexidim/rooms/${Math.max(0, number(item.rm))}.png`,
      displayRank: number(item.dr, index),
    }))
    .sort((a, b) => a.displayRank - b.displayRank);
  const allLeafScenes = archivedScenes.filter((item) => !isSceneGroup(item));
  const leafScenes = allLeafScenes.filter((item) => !isDeletedScene(item));
  const deletedLeafScenes = allLeafScenes.filter(isDeletedScene);
  const sceneIdByKey = new Map(
    allLeafScenes.map((item, index) => [number(item.ky), index + 1]),
  );
  const mapScene = (item: ArchiveObject, index: number): Scene => {
    const levels: Record<number, number> = {};
    const channelSettings: Record<number, SceneChannelSettings> = {};
    for (const [key, value] of Object.entries(item)) {
      if (!/^ch\d+$/.test(key)) continue;
      const archivedChannel = object(value);
      const channelId = archivedChannel
        ? channelIdByKey.get(number(archivedChannel.ky))
        : undefined;
      const archivedBrightness = archivedChannel
        ? number(archivedChannel.br, 100)
        : 100;
      if (channelId && archivedChannel) {
        const brightness =
          archivedBrightness >= 0 && archivedBrightness <= 100
            ? archivedBrightness
            : 100;
        const channelFlags = number(archivedChannel.fl);
        levels[channelId] = brightness;
        channelSettings[channelId] = {
          brightness,
          fadeTime: Math.max(0, number(archivedChannel.t1)) / 2,
          relativePercent: Boolean(channelFlags & 0x80),
          use100PercentTime: Boolean(channelFlags & 0x10),
          delay: Math.max(0, number(archivedChannel.de)) / 2,
          flags: channelFlags,
        };
      }
    }
    const folderPath: string[] = [];
    let parent = sceneByKey.get(number(item.pr));
    const visited = new Set<number>();
    while (parent && isSceneGroup(parent) && !visited.has(number(parent.ky))) {
      visited.add(number(parent.ky));
      folderPath.unshift(string(parent.nm) || "Scenes");
      parent = sceneByKey.get(number(parent.pr));
    }
    return {
      id: sceneIdByKey.get(number(item.ky)) ?? index + 1,
      name: string(item.nm) || `Scene ${index + 1}`,
      shortName: string(item.sn) || string(item.nm) || `Scene ${index + 1}`,
      group: folderPath.at(-1) || "Scenes",
      groupId: sceneGroupIdByKey.get(number(item.pr)),
      folderPath: folderPath.length ? folderPath : ["Scenes"],
      levels,
      channelSettings,
      fade: Math.max(0, number(item.dr)),
      enabled: true,
      days: allDays,
      time: "",
      autoStart: Boolean(number(item.fl) & 0x80),
      nextSceneId: sceneIdByKey.get(number(item.ns)),
      nextSceneMode: number(item.nsm, -1),
      nextSceneTime: number(item.nt),
      nextSceneDay: number(item.nd),
      previousSceneId: sceneIdByKey.get(number(item.ps)),
      extenderSceneId: sceneIdByKey.get(number(item.es)),
      runExtenderFirst: item.re1 === true || number(item.re1) > 0,
      beginNewSequence: Boolean(number(item.fl) & 0x20),
      period1: number(item.p1),
      period2: number(item.p2),
      stateFlag: number(item.sf),
      flags: number(item.fl),
    };
  };
  const scenes: Scene[] = leafScenes.map(mapScene);
  const deletedScenes: Scene[] = deletedLeafScenes.map(mapScene);

  const assignments: Assignment[] = [];
  for (const settings of switchSettings) {
    const switchId = switchIdByKey.get(number(settings.ky));
    if (!switchId) continue;
    const buttonIndexes = Object.keys(settings).flatMap((key) => {
      const match = /^bu(\d+)$/.exec(key);
      return match ? [Number(match[1])] : [];
    });
    for (const index of buttonIndexes) {
      const archivedSceneKey = number(string(settings[`bu${index}`]));
      const sceneId = sceneIdByKey.get(archivedSceneKey);
      if (sceneId) assignments.push({ switchId, button: index + 1, sceneId });
    }
  }

  const periods: Period[] = instances("JCLFDPeriod").flatMap((item, index) => {
    const name = string(item.nm).trim();
    if (!name) return [];
    const minutes = (value: unknown) =>
      `${String(Math.floor(number(value) / 60)).padStart(2, "0")}:${String(number(value) % 60).padStart(2, "0")}`;
    return [
      {
        id: index + 1,
        name,
        start: minutes(item.sm),
        end: minutes(item.em),
        days: allDays,
        enabled: true,
      },
    ];
  });

  const users: FlexUser[] = instances("JCLFDUser").map((item, index) => ({
    id: index + 1,
    name: string(item.nm) || `User ${index + 1}`,
    remote: number(item.rc) > 0,
    changes: number(item.ve) > 0,
    key: string(item.sk),
  }));

  return {
    site: {
      name: topString("$1") || "Imported FlexiDim site",
      id: topString("$9") || "FD4",
      ip: topString("$11") || "192.168.1.50",
      port: 15273,
      description: "Imported from FlexiDim Configuration for iOS",
      address: "",
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London",
      dst: "UK / Europe",
      remote: false,
    },
    rooms,
    channels,
    switches,
    sceneGroups,
    scenes,
    deletedScenes,
    periods,
    users,
    assignments,
    modules,
    deletedItems: [],
  };
}

export function parseLegacyFd4Config(buffer: ArrayBuffer): AppData {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  const signature = new TextDecoder().decode(bytes);
  if (!signature.startsWith("bplist"))
    throw new Error("The .fd4cfg file is not an Apple binary property list");
  return convertLegacyArchive(parse(buffer));
}
