import { parse } from "@plist/binary.parse";
import { controllerChannelAddress } from "./flexidim-addressing.mjs";

export type Room = {
  id: number;
  name: string;
  floor: string;
  icon: string;
  parentId?: number | null;
  shortName?: string;
  areaType?: "Floor" | "Area" | "Room";
  legacyKey?: number;
  displayRank?: number;
  hardwareType?: number;
  hardwareIndex?: number;
  legacy?: Record<string, unknown>;
};
export type Channel = {
  id: number;
  name: string;
  roomId: number;
  module: string;
  kind: string;
  level: number;
  moduleId?: number;
  moduleIndex?: number;
  // The byte the Scene Controller addresses this channel by: the module's
  // ordinal in the high nibble, the channel index (1-8) in the low nibble.
  controllerChannel?: number;
  accessoryModule?: string;
  minimum?: number;
  maximum?: number;
  defaultLevel?: number;
  maximumPermissible?: number;
  accessoryType?: number;
  shortName?: string;
  displayRank?: number;
  hardwareType?: number;
  channelIndex?: number;
  dimmable?: boolean;
  hardwareChanged?: boolean;
  legacyKey?: number;
  legacy?: Record<string, unknown>;
};
export type WallSwitch = {
  id: number;
  name: string;
  roomId: number;
  kind: string;
  buttons: number;
  type?: number;
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
  shortName?: string;
  displayRank?: number;
  hardwareType?: number;
  legacyKey?: number;
  legacy?: Record<string, unknown>;
};
export type FlexModule = {
  id: number;
  name: string;
  bus: "A" | "B";
  enabled: boolean;
  pending: boolean;
  position?: number;
  legacy?: Record<string, unknown>;
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
  color?: { red: number; green: number; blue: number };
  kelvin?: number;
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
  legacyKey?: number;
  displayRank?: number;
  locked?: boolean;
  sceneType?: number;
  period1Mode?: "always" | "during" | "not-during";
  period2Mode?: "none" | "and" | "or";
  stateFlagAction?: "none" | "set" | "clear" | "require-set" | "require-clear";
  legacy?: Record<string, unknown>;
};
export type Period = {
  id: number;
  name: string;
  start: string;
  end: string;
  days: string[];
  enabled: boolean;
  startMode?: number;
  endMode?: number;
  legacyIndex?: number;
  legacy?: Record<string, unknown>;
};
export type FlexUser = {
  id: number;
  name: string;
  remote: boolean;
  changes: boolean;
  key: string;
  legacyKey?: number;
  securityCode?: string;
  roomIds?: number[];
  switchIds?: number[];
  // Raw room/switch access entries (archive keys rm0..rmN). Their internal
  // encoding is not yet decoded, so they are preserved verbatim rather than
  // resolved to room IDs. accessCount mirrors the archive `rc` field.
  roomAccess?: string[];
  accessCount?: number;
  profileData?: string;
  profileVersion?: number;
  profileStatus?: "current" | "pending" | "imported";
  legacy?: Record<string, unknown>;
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
  routerPort?: number;
  description: string;
  address: string;
  contact?: string;
  email?: string;
  phone?: string;
  latitude?: string;
  longitude?: string;
  timezone: string;
  dst: string;
  remote: boolean;
  remoteServer?: string;
  securityCode?: string;
  autoDetect?: boolean;
  addressLines?: string[];
  siteType?: number;
  routerInbound?: boolean;
  wirelessGateways?: { address: string; count: number }[];
  moduleOrderA?: number[];
  moduleOrderB?: number[];
  updatedAt?: string;
  legacy?: Record<string, unknown>;
  bridgeUrl?: string;
  bridgeToken?: string;
};

export type ControllerConnectionRequest = {
  type: "discover" | "connect";
  host: string;
  port: number;
  securityCode?: string;
};

/**
 * Resolve the actual controller target from the site's connection mode.
 * Type-0 is the local controller protocol. Preserve the committed connection
 * behavior: Auto Detect chooses discovery versus a direct connection, but
 * archived remote/router metadata never changes the local target.
 */
export function controllerConnectionRequest(
  site: Site,
): ControllerConnectionRequest {
  if ((site.siteType ?? 0) !== 0) {
    throw new Error(
      "Remote and encrypted controller sessions are not enabled until their protocol profile is verified",
    );
  }
  const host = site.ip.trim();
  const port = site.port;
  if (!host)
    throw new Error("Enter the controller IP address or enable Auto Detect");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Enter a controller port between 1 and 65535");

  if (site.autoDetect !== false) {
    return {
      type: "discover",
      host,
      port,
      securityCode: site.securityCode,
    };
  }

  return {
    type: "connect",
    host,
    port,
    securityCode: site.securityCode,
  };
}

function isIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Convert legacy numeric/invalid timezone values into a render-safe IANA ID. */
export function normalizeSiteTimeZone(
  value: unknown,
  dst: string,
  fallback = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate && isIanaTimeZone(candidate)) return candidate;
  if (/uk|europe/i.test(dst)) return "Europe/London";
  if (/no daylight|none/i.test(dst) && Number(candidate) === 0) return "UTC";
  return fallback && isIanaTimeZone(fallback) ? fallback : "UTC";
}

/** Serialize imported configuration data, including BigInts from binary plists. */
export function stringifyConfiguration(value: unknown, space?: number) {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item !== "bigint") return item;
      const numeric = Number(item);
      return Number.isSafeInteger(numeric) ? numeric : item.toString();
    },
    space,
  );
}

const validControllerSecurityCode = (value?: string) =>
  typeof value === "string" && /^[\x20-\x7e]{16}$/.test(value);

/**
 * Merge an imported iOS site with the browser's existing site record.
 * Controller credentials come from the valid record and must not be lost when
 * the user elects to retain newer local site details. Bridge connection values
 * are browser-local and are therefore always retained from the current site.
 */
export function mergeImportedSite(
  current: Site,
  imported: Site,
  useImportedDetails: boolean,
): Site {
  const merged = useImportedDetails ? { ...imported } : { ...current };
  // The running app may have learned a newer controller address through
  // discovery than the archived backup contains. Re-importing configuration
  // content must not discard that known-working local endpoint.
  if (current.ip?.trim()) merged.ip = current.ip.trim();
  if (
    Number.isInteger(current.port) &&
    current.port >= 1 &&
    current.port <= 65535
  )
    merged.port = current.port;
  merged.autoDetect = current.autoDetect;
  if (!validControllerSecurityCode(merged.securityCode)) {
    const fallback = useImportedDetails ? current.securityCode : imported.securityCode;
    if (validControllerSecurityCode(fallback)) merged.securityCode = fallback;
  }
  merged.bridgeUrl = current.bridgeUrl ?? imported.bridgeUrl;
  merged.bridgeToken = current.bridgeToken ?? imported.bridgeToken;
  return merged;
}

/** Compare only portable site fields; ignore timestamps, raw archive and local bridge settings. */
export function siteImportDetailsEqual(left: Site, right: Site) {
  const comparable = (site: Site) => ({
    name: site.name,
    id: site.id,
    ip: site.ip,
    port: site.port,
    routerPort: site.routerPort ?? null,
    description: site.description,
    address: site.address,
    contact: site.contact ?? "",
    email: site.email ?? "",
    phone: site.phone ?? "",
    latitude: site.latitude ?? "",
    longitude: site.longitude ?? "",
    timezone: site.timezone,
    dst: site.dst,
    remote: site.remote,
    remoteServer: site.remoteServer ?? "",
    securityCode: site.securityCode ?? "",
    autoDetect: site.autoDetect ?? true,
    addressLines: site.addressLines ?? [],
    siteType: site.siteType ?? 0,
    routerInbound: site.routerInbound ?? false,
    wirelessGateways: site.wirelessGateways ?? [],
    moduleOrderA: site.moduleOrderA ?? [],
    moduleOrderB: site.moduleOrderB ?? [],
  });
  return stringifyConfiguration(comparable(left)) === stringifyConfiguration(comparable(right));
}
// The editable logical model that belongs to one configuration. A site can
// hold several configurations; the active one's content lives at the top level
// of AppData, and the others are snapshotted into Configuration.content.
export type ConfigContent = {
  rooms: Room[];
  channels: Channel[];
  switches: WallSwitch[];
  sceneGroups: SceneGroup[];
  scenes: Scene[];
  deletedScenes: Scene[];
  periods: Period[];
  users: FlexUser[];
  assignments: Assignment[];
  modules: FlexModule[];
  deletedItems: DeletedItem[];
};

export type ConfigEntityType =
  | "room"
  | "channel"
  | "switch"
  | "module"
  | "scene"
  | "period"
  | "user";

/**
 * Report every dangling or cyclic reference in one configuration. This is
 * deliberately independent of the UI so imports, migrations and destructive
 * editor actions can all apply the same rules.
 */
export function validateConfigContent(content: ConfigContent): string[] {
  const issues: string[] = [];
  const ids = <T extends { id: number }>(items: T[]) =>
    new Set(items.map((item) => item.id));
  const roomIds = ids(content.rooms);
  const channelIds = ids(content.channels);
  const switchIds = ids(content.switches);
  const moduleIds = ids(content.modules);
  const sceneIds = ids(content.scenes);
  const periodIds = ids(content.periods);

  const duplicateIds = <T extends { id: number }>(label: string, items: T[]) => {
    const seen = new Set<number>();
    for (const item of items) {
      if (seen.has(item.id)) issues.push(`${label} ${item.id} has a duplicate ID`);
      seen.add(item.id);
    }
  };
  duplicateIds("Room", content.rooms);
  duplicateIds("Channel", content.channels);
  duplicateIds("Switch", content.switches);
  duplicateIds("Module", content.modules);
  duplicateIds("Scene", content.scenes);
  duplicateIds("Period", content.periods);
  duplicateIds("User", content.users);

  const roomById = new Map(content.rooms.map((room) => [room.id, room]));
  for (const room of content.rooms) {
    if (room.parentId != null && !roomIds.has(room.parentId))
      issues.push(`Room ${room.id} references missing parent room ${room.parentId}`);
    const ancestors = new Set([room.id]);
    let parentId = room.parentId;
    while (parentId != null) {
      if (ancestors.has(parentId)) {
        issues.push(`Room ${room.id} has a cyclic parent hierarchy`);
        break;
      }
      ancestors.add(parentId);
      parentId = roomById.get(parentId)?.parentId;
    }
  }

  for (const channel of content.channels) {
    if (!roomIds.has(channel.roomId))
      issues.push(`Channel ${channel.id} references missing room ${channel.roomId}`);
    if (channel.moduleId != null && !moduleIds.has(channel.moduleId))
      issues.push(`Channel ${channel.id} references missing module ${channel.moduleId}`);
  }
  for (const wallSwitch of content.switches) {
    if (!roomIds.has(wallSwitch.roomId))
      issues.push(`Switch ${wallSwitch.id} references missing room ${wallSwitch.roomId}`);
    for (const channelId of wallSwitch.basic?.channelIds ?? []) {
      if (!channelIds.has(channelId))
        issues.push(`Switch ${wallSwitch.id} references missing basic channel ${channelId}`);
    }
    for (const channelId of Object.keys(wallSwitch.basic?.channelSettings ?? {})) {
      if (!channelIds.has(Number(channelId)))
        issues.push(`Switch ${wallSwitch.id} has settings for missing channel ${channelId}`);
    }
  }
  for (const scene of content.scenes) {
    for (const channelId of new Set([
      ...Object.keys(scene.levels),
      ...Object.keys(scene.channelSettings ?? {}),
    ])) {
      if (!channelIds.has(Number(channelId)))
        issues.push(`Scene ${scene.id} references missing channel ${channelId}`);
    }
    for (const [field, targetId] of [
      ["next", scene.nextSceneId],
      ["previous", scene.previousSceneId],
      ["extender", scene.extenderSceneId],
    ] as const) {
      if (targetId != null && !sceneIds.has(targetId))
        issues.push(`Scene ${scene.id} references missing ${field} scene ${targetId}`);
    }
    for (const [field, periodId] of [
      ["period 1", scene.period1],
      ["period 2", scene.period2],
    ] as const) {
      if (periodId != null && periodId !== 0 && !periodIds.has(periodId))
        issues.push(`Scene ${scene.id} references missing ${field} ${periodId}`);
    }
  }
  for (const assignment of content.assignments) {
    if (!switchIds.has(assignment.switchId))
      issues.push(`Assignment references missing switch ${assignment.switchId}`);
    for (const sceneId of [assignment.sceneId, assignment.secondSceneId]) {
      if (sceneId != null && !sceneIds.has(sceneId))
        issues.push(`Assignment references missing scene ${sceneId}`);
    }
    for (const channelId of [
      assignment.channelId,
      assignment.secondChannelId,
      ...(assignment.channelIds ?? []),
    ]) {
      if (channelId != null && !channelIds.has(channelId))
        issues.push(`Assignment references missing channel ${channelId}`);
    }
  }
  for (const user of content.users) {
    for (const roomId of user.roomIds ?? []) {
      if (!roomIds.has(roomId))
        issues.push(`User ${user.id} references missing room ${roomId}`);
    }
    for (const switchId of user.switchIds ?? []) {
      if (!switchIds.has(switchId))
        issues.push(`User ${user.id} references missing switch ${switchId}`);
    }
  }
  return issues;
}

/**
 * Delete one model entity and clean every dependent reference. Rooms and
 * modules with owned children are refused because silently re-homing physical
 * equipment would change controller semantics.
 */
export function deleteConfigEntity(
  content: ConfigContent,
  type: ConfigEntityType,
  id: number,
): ConfigContent {
  if (
    type === "room" &&
    (content.rooms.some((room) => room.parentId === id) ||
      content.channels.some((channel) => channel.roomId === id) ||
      content.switches.some((wallSwitch) => wallSwitch.roomId === id))
  ) {
    throw new Error("Move the child rooms, channels and switches before deleting this area.");
  }
  if (
    type === "module" &&
    content.channels.some((channel) => channel.moduleId === id)
  ) {
    throw new Error("Move this module's channels before deleting it.");
  }

  const withoutChannel = (values: number[] | undefined) =>
    values?.filter((value) => value !== id);
  const assignments = content.assignments.flatMap((assignment) => {
    if (type === "switch" && assignment.switchId === id) return [];
    if (type === "channel") {
      if (
        assignment.channelId === id ||
        assignment.secondChannelId === id ||
        assignment.channelIds?.includes(id)
      ) return [];
    }
    return [{
      ...assignment,
      sceneId:
        type === "scene" && assignment.sceneId === id
          ? undefined
          : assignment.sceneId,
      secondSceneId:
        type === "scene" && assignment.secondSceneId === id
          ? undefined
          : assignment.secondSceneId,
    }];
  });

  return {
    ...content,
    rooms: type === "room" ? content.rooms.filter((item) => item.id !== id) : content.rooms,
    channels: type === "channel" ? content.channels.filter((item) => item.id !== id) : content.channels,
    switches: (type === "switch"
      ? content.switches.filter((item) => item.id !== id)
      : content.switches).map((wallSwitch) =>
        type === "channel" && wallSwitch.basic
          ? {
              ...wallSwitch,
              basic: {
                ...wallSwitch.basic,
                channelIds: withoutChannel(wallSwitch.basic.channelIds) ?? [],
                channelSettings: Object.fromEntries(
                  Object.entries(wallSwitch.basic.channelSettings ?? {})
                    .filter(([channelId]) => Number(channelId) !== id),
                ),
              },
            }
          : wallSwitch,
      ),
    modules: type === "module" ? content.modules.filter((item) => item.id !== id) : content.modules,
    scenes: (type === "scene"
      ? content.scenes.filter((item) => item.id !== id)
      : content.scenes).map((scene) => {
        if (type === "channel") {
          const levels = { ...scene.levels };
          const channelSettings = { ...scene.channelSettings };
          delete levels[id];
          delete channelSettings[id];
          return { ...scene, levels, channelSettings };
        }
        if (type === "scene") {
          return {
            ...scene,
            nextSceneId: scene.nextSceneId === id ? undefined : scene.nextSceneId,
            previousSceneId: scene.previousSceneId === id ? undefined : scene.previousSceneId,
            extenderSceneId: scene.extenderSceneId === id ? undefined : scene.extenderSceneId,
          };
        }
        if (type === "period") {
          return {
            ...scene,
            period1: scene.period1 === id ? undefined : scene.period1,
            period2: scene.period2 === id ? undefined : scene.period2,
          };
        }
        return scene;
      }),
    periods: type === "period" ? content.periods.filter((item) => item.id !== id) : content.periods,
    users: type === "user"
      ? content.users.filter((item) => item.id !== id)
      : content.users.map((user) => {
          if (type === "room" && user.roomIds?.includes(id))
            return updateUserProfile(user, {
              roomIds: withoutChannel(user.roomIds),
            });
          if (type === "switch" && user.switchIds?.includes(id))
            return updateUserProfile(user, {
              switchIds: withoutChannel(user.switchIds),
            });
          return user;
        }),
    assignments,
  };
}

export type Configuration = {
  id: number;
  siteId: string;
  name: string;
  description: string;
  lastUpdated: string;
  content?: ConfigContent;
  legacy?: Record<string, unknown>;
};

export type OwnedConfiguration = Omit<Configuration, "siteId" | "content"> & {
  content: ConfigContent;
};

/** Canonical persisted owner: configuration content is nested beneath its site. */
export type OwnedSite = Site & {
  configurations: OwnedConfiguration[];
};

export type FlexiDimWorkspace = {
  activeSiteId: string;
  activeConfigId: number;
  sites: OwnedSite[];
};

export const CONFIG_CONTENT_KEYS = [
  "rooms",
  "channels",
  "switches",
  "sceneGroups",
  "scenes",
  "deletedScenes",
  "periods",
  "users",
  "assignments",
  "modules",
  "deletedItems",
] as const;

export type AppData = {
  site: Site;
  sites?: Site[];
  configurations?: Configuration[];
  activeConfigId?: number;
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

export function emptyConfigContent(): ConfigContent {
  return {
    rooms: [],
    channels: [],
    switches: [],
    sceneGroups: [],
    scenes: [],
    deletedScenes: [],
    periods: [],
    users: [],
    assignments: [],
    modules: [],
    deletedItems: [],
  };
}

export function snapshotConfigContent(source: AppData): ConfigContent {
  return Object.fromEntries(
    CONFIG_CONTENT_KEYS.map((key) => [key, source[key] ?? []]),
  ) as unknown as ConfigContent;
}

/** Build the versioned web-native representation of an editable user profile. */
export function buildUserProfileData(user: FlexUser): string {
  return stringifyConfiguration({
    format: "FlexiDim Web User Profile",
    version: 1,
    user: {
      id: user.id,
      name: user.name,
      securityCode: user.securityCode ?? user.key,
      remote: user.remote,
      changes: user.changes,
      roomIds: user.roomIds ?? [],
      switchIds: user.switchIds ?? [],
    },
  });
}

/** Apply a profile-significant edit and mark the local profile for transfer. */
export function updateUserProfile(
  user: FlexUser,
  patch: Partial<FlexUser>,
): FlexUser {
  const next = {
    ...user,
    ...patch,
    profileVersion: (user.profileVersion ?? 0) + 1,
    profileStatus: "pending" as const,
  };
  return { ...next, profileData: buildUserProfileData(next) };
}

/** Selected access entries first in their explicit user-defined order. */
export function orderUserAccess<T extends { id: number }>(
  items: T[],
  selectedIds: number[] = [],
): T[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const selected = selectedIds.flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });
  const selectedSet = new Set(selected.map((item) => item.id));
  return [...selected, ...items.filter((item) => !selectedSet.has(item.id))];
}

export function isFlexiDimWorkspace(value: unknown): value is FlexiDimWorkspace {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FlexiDimWorkspace>;
  const structurallyValid =
    typeof candidate.activeSiteId === "string" &&
    Number.isInteger(candidate.activeConfigId) &&
    Array.isArray(candidate.sites) &&
    candidate.sites.length > 0 &&
    candidate.sites.every(
      (site) =>
        site &&
        typeof site === "object" &&
        typeof site.id === "string" &&
        Array.isArray(site.configurations) &&
        site.configurations.length > 0 &&
        site.configurations.every(
          (configuration) =>
            configuration &&
            typeof configuration === "object" &&
            Number.isInteger(configuration.id) &&
            configuration.content &&
            typeof configuration.content === "object" &&
            CONFIG_CONTENT_KEYS.every((key) =>
              Array.isArray(configuration.content[key]),
            ),
        ),
    );
  if (!structurallyValid) return false;
  const workspace = candidate as FlexiDimWorkspace;
  const siteIds = workspace.sites.map((site) => site.id);
  const configurationIds = workspace.sites.flatMap((site) =>
    site.configurations.map((configuration) => configuration.id),
  );
  if (
    new Set(siteIds).size !== siteIds.length ||
    new Set(configurationIds).size !== configurationIds.length
  )
    return false;
  const activeSite = workspace.sites.find(
    (site) => site.id === workspace.activeSiteId,
  );
  return Boolean(
    activeSite?.configurations.some(
      (configuration) => configuration.id === workspace.activeConfigId,
    ),
  );
}

/**
 * Carry forward only the connection details proven by the browser-local app.
 * Configuration content and site metadata remain authoritative on the server.
 */
export function mergeLegacyBrowserConnectionState(
  server: FlexiDimWorkspace,
  browser: FlexiDimWorkspace,
): FlexiDimWorkspace {
  const browserSites = new Map(browser.sites.map((site) => [site.id, site]));
  return {
    ...server,
    sites: server.sites.map((site) => {
      const local = browserSites.get(site.id);
      if (!local) return site;
      const ip = local.ip?.trim();
      const port = local.port;
      return {
        ...site,
        ...(ip ? { ip } : {}),
        ...(Number.isInteger(port) && port >= 1 && port <= 65535
          ? { port }
          : {}),
        autoDetect: local.autoDetect,
        ...(validControllerSecurityCode(local.securityCode)
          ? { securityCode: local.securityCode }
          : {}),
      };
    }),
  };
}

/**
 * Migrate the editor's legacy active-content projection into the canonical
 * Site → Configuration → ConfigContent ownership tree.
 */
export function canonicalizeAppData(data: AppData): FlexiDimWorkspace {
  const sourceSites = data.sites?.length ? data.sites : [data.site];
  const sites = sourceSites.some((site) => site.id === data.site.id)
    ? sourceSites
    : [...sourceSites, data.site];
  const configurations = data.configurations?.length
    ? [...data.configurations]
    : [{
        id: data.activeConfigId ?? 1,
        siteId: data.site.id,
        name: data.site.name,
        description: data.site.description,
        lastUpdated: data.site.updatedAt ?? "",
      }];
  let nextConfigurationId =
    Math.max(0, ...configurations.map((configuration) => configuration.id)) + 1;
  for (const site of sites) {
    if (
      !configurations.some((configuration) => configuration.siteId === site.id)
    ) {
      configurations.push({
        id: nextConfigurationId++,
        siteId: site.id,
        name: `${site.name} configuration`,
        description: site.description,
        lastUpdated: site.updatedAt ?? "",
        content: emptyConfigContent(),
      });
    }
  }
  const activeConfigId =
    data.activeConfigId &&
    configurations.some(
      (configuration) =>
        configuration.id === data.activeConfigId &&
        configuration.siteId === data.site.id,
    )
      ? data.activeConfigId
      : configurations.find(
          (configuration) => configuration.siteId === data.site.id,
        )?.id ?? configurations[0].id;
  const activeContent = snapshotConfigContent(data);

  const ownedSites: OwnedSite[] = sites.map((site) => {
    const ownedConfigurations = configurations
      .filter((configuration) => configuration.siteId === site.id)
      .map((configuration) => {
        const owned = { ...configuration } as Partial<Configuration>;
        delete owned.siteId;
        delete owned.content;
        return {
          ...owned,
          content:
            site.id === data.site.id && configuration.id === activeConfigId
              ? activeContent
              : (configuration.content ?? emptyConfigContent()),
        } as OwnedConfiguration;
      });
    return { ...site, configurations: ownedConfigurations };
  });

  return {
    activeSiteId: data.site.id,
    activeConfigId,
    sites: ownedSites,
  };
}

/**
 * Materialize the active configuration for the existing editor controls. The
 * returned top-level arrays are a view; the workspace remains the owner.
 */
export function materializeAppData(workspace: FlexiDimWorkspace): AppData {
  const activeSite =
    workspace.sites.find((site) => site.id === workspace.activeSiteId) ??
    workspace.sites[0];
  if (!activeSite) throw new Error("The workspace has no sites");
  const activeConfiguration =
    activeSite.configurations.find(
      (configuration) => configuration.id === workspace.activeConfigId,
    ) ?? activeSite.configurations[0];
  if (!activeConfiguration)
    throw new Error(`Site ${activeSite.id} has no configurations`);
  const sites: Site[] = workspace.sites.map((ownedSite) => {
    const site = { ...ownedSite } as Partial<OwnedSite>;
    delete site.configurations;
    return site as Site;
  });
  const configurations: Configuration[] = workspace.sites.flatMap((site) =>
    site.configurations.map(({ content, ...configuration }) => ({
      ...configuration,
      siteId: site.id,
      content:
        site.id === activeSite.id && configuration.id === activeConfiguration.id
          ? undefined
          : content,
    })),
  );
  return {
    site: sites.find((site) => site.id === activeSite.id)!,
    sites,
    configurations,
    activeConfigId: activeConfiguration.id,
    ...activeConfiguration.content,
  };
}

/** True only for the untouched demo site created before a real import. */
export function isStarterSite(
  site: Site,
  configurations: Configuration[],
) {
  const siteConfigurations = configurations.filter(
    (configuration) => configuration.siteId === site.id,
  );
  return (
    site.id === "FD4-0001" &&
    site.name === "Home" &&
    site.description === "FlexiDim lighting system" &&
    !site.securityCode &&
    !site.legacy &&
    siteConfigurations.length === 1 &&
    siteConfigurations[0].name === "Home"
  );
}

/** Replace a same-site, same-name import and collapse duplicates from older builds. */
export function upsertImportedConfiguration(
  configurations: Configuration[],
  imported: Configuration,
  activeConfigId?: number,
) {
  const matching = configurations.filter(
    (configuration) =>
      configuration.siteId === imported.siteId &&
      configuration.name === imported.name,
  );
  const configurationId =
    matching.find((configuration) => configuration.id === activeConfigId)?.id ??
    matching[0]?.id ??
    Math.max(0, ...configurations.map((configuration) => configuration.id)) + 1;
  return {
    configurationId,
    configurations: [
      ...configurations.filter(
        (configuration) =>
          !(
            configuration.siteId === imported.siteId &&
            configuration.name === imported.name
          ),
      ),
      { ...imported, id: configurationId },
    ],
  };
}

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
  const topNumber = (key: string) => number(dereference(top[key]));
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
      shortName: string(item.sn) || string(item.nm) || `Area ${index + 1}`,
      displayRank: number(item.ra, index),
      hardwareType: number(item.hw),
      hardwareIndex: number(item.ix),
      legacyKey: number(item.ky),
      legacy: { ...item },
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
  // The iOS app's moduleForModuleNumber: searches the site's stored module
  // array and sendDiM: addresses a channel as `index + modulePosition * 8`.
  // Module identifiers happen to be ordered at many sites, but sorting them is
  // not protocol-correct: the archive order is the source of truth.
  const archivedModuleCount = Math.max(0, topNumber("modc"));
  const archivedModules = Array.from(
    { length: archivedModuleCount },
    (_, moduleIndex) => number(topString(`$${30 + moduleIndex}`), -1),
  ).filter((moduleNumber) => moduleNumber >= 0);
  const encounteredModules = channelHardware
    .map((item) => number(item.md, -1))
    .filter((moduleNumber) => moduleNumber >= 0);
  const orderedModules = [...new Set([...archivedModules, ...encounteredModules])];
  const channels: Channel[] = channelHardware.map((item, index) => {
    const moduleNumber = number(item.md, -1);
    const channelIndex = number(item.ix);
    const modulePosition = orderedModules.indexOf(moduleNumber);
    const controllerChannel = controllerChannelAddress(
      modulePosition,
      channelIndex,
    );
    return {
      id: index + 1,
      name: string(item.nm) || `Channel ${index + 1}`,
      roomId: parentRoomId(item),
      module:
        moduleNumber >= 0
          ? `Module ${moduleNumber} / Ch${channelIndex}`
          : `Channel ${channelIndex}`,
      kind: `FlexiDim type ${number(item.hw)}`,
      level: 0,
      moduleId: moduleNumber >= 0 ? moduleNumber : undefined,
      moduleIndex: channelIndex,
      channelIndex,
      controllerChannel,
      // Archive keys recovered from the iOS binary and validated against a real
      // archive: ac accessory type, mi/mx min/max, mp max-permissible, df
      // default, di dimmable, ch changed, ra rank. (Earlier guesses at/mn/dm/hc
      // /dr do not exist in a real `.fd4cfg` and silently defaulted.)
      accessoryModule: "None",
      accessoryType: number(item.ac),
      minimum: number(item.mi),
      maximum: number(item.mx, 100),
      maximumPermissible: number(item.mp, 100),
      defaultLevel: number(item.df, 100),
      shortName: string(item.sn) || string(item.nm),
      displayRank: number(item.ra, index),
      hardwareType: number(item.hw),
      dimmable: item.di === true || number(item.di) > 0,
      hardwareChanged: item.ch === true || number(item.ch) > 0,
      legacyKey: number(item.ky),
      legacy: { ...item },
    };
  });
  const modules: FlexModule[] = orderedModules.map((moduleId, position) => ({
    id: moduleId,
    name: `Module ${moduleId}`,
    bus: "A",
    enabled: true,
    pending: false,
    position,
  }));

  // Recovered from the iOS binary: "Type 15 = 8 scene : Type 13 = 4 scene :
  // Type 2 = 2 channel opto : Type 8 = 8 channel opto". The type also names the
  // switchPic_<type> face image. buttons is the physical button count.
  const switchTypes: Record<number, { name: string; buttons: number }> = {
    15: { name: "8 scene", buttons: 11 },
    13: { name: "4 scene", buttons: 7 },
    8: { name: "8 channel opto", buttons: 8 },
    2: { name: "2 channel opto", buttons: 2 },
  };
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
    const type = number(item.hw);
    const typeInfo = switchTypes[type];
    // The archive always carries a fixed block of button-scene slots, so their
    // count is not the physical button count — that comes from the hardware
    // type. Fall back to a capped assignment count only for unknown types.
    const buttons =
      typeInfo?.buttons ?? Math.min(11, Math.max(4, ...archivedButtons));
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
      kind: typeInfo?.name ?? `${buttons} button`,
      buttons,
      type,
      // sendSwMessage: receives JCLFDHardware.index, not the switch's
      // position in the configuration's logical list.
      number: number(item.ix, index + 1),
      shortName: string(item.sn) || string(item.nm),
      // Switch hardware is a JCLFDHardware object: rank is `ra` (not the `dr`
      // used by JCLFDScene).
      displayRank: number(item.ra, index),
      hardwareType: type,
      legacyKey: number(item.ky),
      legacy: { hardware: { ...item }, settings: settings ? { ...settings } : undefined },
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
      legacyKey: number(item.ky),
      displayRank: number(item.dr, index),
      locked: number(item.lk) > 0,
      sceneType: number(item.ty),
      legacy: { ...item },
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
      // Each slot is one logical button holding a single scene. Consecutive
      // logical buttons pair up on the plate as the first-press / second-press
      // of one physical button (physical P → logical 2P-1 and 2P).
      const rawButton = settings[`bu${index}`];
      const sceneKey =
        typeof rawButton === "number"
          ? rawButton
          : number(string(rawButton) || rawButton || "");
      const sceneId = sceneKey > 0 ? sceneIdByKey.get(sceneKey) : undefined;
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
        // The archive keys are st/et for time and sm/em for the independent
        // sunrise/sunset/absolute modes. Older builds accidentally treated
        // the mode values as clock minutes.
        start: minutes(item.st),
        end: minutes(item.et),
        days: allDays,
        enabled: true,
        startMode: number(item.sm),
        endMode: number(item.em),
        legacyIndex: number(item.ix, index),
        legacy: { ...item },
      },
    ];
  });

  const users: FlexUser[] = instances("JCLFDUser").map((item, index) => {
    // Archive keys recovered from the iOS binary and validated against a real
    // archive: sk 16-character security key, ve profile version, rc access-entry
    // count, rm0..rmN the access entries (strings, not room-key references).
    const accessCount = number(item.rc);
    const roomAccess = Object.keys(item)
      .filter((key) => /^rm\d+$/.test(key))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
      .map((key) => string(item[key]))
      .filter((entry) => entry.length > 0);
    return {
      id: index + 1,
      name: string(item.nm) || `User ${index + 1}`,
      remote: false,
      changes: true,
      key: string(item.sk),
      securityCode: string(item.sk),
      legacyKey: number(item.ky),
      // The rm entries are not room-key references, so no room IDs are resolved
      // until their encoding is decoded; the raw entries are preserved instead.
      roomIds: [],
      switchIds: [],
      roomAccess,
      accessCount,
      profileVersion: number(item.ve),
      profileStatus: "imported",
      legacy: { ...item },
    };
  });

  // Site fields are stored as positional NSKeyedArchiver entries ($1..$N) in
  // the app's encode order, recovered from the iOS binary:
  //   $1 name  $2-$5 address lines  $6 contact  $7 phone  $8 email
  //   $9 siteID  $10 security code  $11 IP  $12 auto-detect  $14 last updated
  //   $15 longitude  $16 latitude  $17 time zone  $18 router-inbound flag
  //   $19 DST rules  $29 remote server
  const addressLines = ["$2", "$3", "$4", "$5"].map((key) => topString(key));
  const address = addressLines
    .filter(Boolean)
    .join(", ");
  const dstRaw = topString("$19");
  const dstByIndex = ["No daylight saving", "UK / Europe", "USA"];
  const dst = /uk|europe/i.test(dstRaw)
    ? "UK / Europe"
    : /usa|us\b/i.test(dstRaw)
      ? "USA"
      : /no daylight|none/i.test(dstRaw)
        ? "No daylight saving"
        : dstByIndex[topNumber("$19")] ?? "UK / Europe";
  const routerRaw = topString("$18");
  const routerPortValue = /^\d+$/.test(routerRaw)
    ? Number(routerRaw)
    : topNumber("$18");
  const remoteServer = topString("$29");
  const updatedRaw = topString("$14");
  const updatedDate = new Date(updatedRaw);
  const lastUpdated =
    updatedRaw && !Number.isNaN(updatedDate.getTime())
      ? updatedDate.toISOString()
      : "";
  const site: Site = {
    name: topString("$1") || "Imported FlexiDim site",
    id: topString("$9") || "FD4",
    ip: topString("$11") || "192.168.1.50",
    port: 15273,
    // Real archives store a boolean-like router setting at $18. Preserve a
    // plausible legacy port from older fixtures, but never turn 0/1 into a TCP
    // destination.
    routerPort: routerPortValue >= 1024 ? routerPortValue : 15273,
    description: "Imported from FlexiDim Configuration for iOS",
    address,
    contact: topString("$6"),
    email: topString("$8"),
    phone: topString("$7"),
    latitude: topString("$16"),
    longitude: topString("$15"),
    timezone: normalizeSiteTimeZone(topString("$17"), dst),
    dst,
    // A remembered remote server is present even on local type-0 sites. Only
    // non-local site types should select that transport automatically.
    remote: topNumber("$13") !== 0 && Boolean(remoteServer),
    remoteServer,
    securityCode: topString("$10"),
    autoDetect: topString("$12") !== "0" && topNumber("$12") !== 0,
    addressLines,
    siteType: topNumber("$13"),
    routerInbound: Boolean(routerPortValue),
    wirelessGateways: [0, 1, 2, 3].flatMap((index) => {
      const address = topString(`$${20 + index * 2}`);
      const count = topNumber(`$${21 + index * 2}`);
      return address ? [{ address, count }] : [];
    }),
    moduleOrderA: archivedModules,
    moduleOrderB: [],
    updatedAt: lastUpdated,
    legacy: { top: { ...top } },
  };
  return {
    site,
    configurations: [
      {
        id: 1,
        siteId: site.id,
        name: site.name,
        description: site.description,
        lastUpdated,
      },
    ],
    activeConfigId: 1,
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
