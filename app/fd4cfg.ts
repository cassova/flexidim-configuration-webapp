import { parseBinaryPlist } from "./binary-plist.ts";
import { channelTypeName } from "./channel-catalogue.ts";
import { controllerChannelAddress } from "./flexidim-addressing.mjs";
import { foundationDictionaryOrder } from "./foundation-dictionary-order.ts";

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
  /**
   * Which recovered channel-type family this channel's `hardwareType` should be
   * read against. Web-native only: the iOS archive does not store it, and the
   * selector the app uses was not recovered, so it is a display hint.
   */
  typeFamily?: string;
  channelIndex?: number;
  /** Final tie-break inherited from the iOS hardware NSDictionary. */
  profileOrder?: number;
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
  legacyKey?: number;
  legacy?: Record<string, unknown>;
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
  /**
   * Channel ids in the order the archive listed them (`ch0`, `ch1`, ...).
   *
   * `levels` cannot carry this: its keys are numeric, and JavaScript always
   * iterates integer-like keys in ascending order, so reading the order back off
   * it silently gives channel-id order instead. The Scene Controller image is
   * built in the archive's order, so it has to be kept separately.
   */
  channelOrder?: number[];
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
export type StateFlag = {
  id: number;
  name: string;
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
  // Raw room/switch access entries (archive keys rm0..rmN). Each is a
  // pipe-delimited legacy-key path: the owning room followed by one or more
  // switches. Keep the raw form for byte-faithful export; roomIds/switchIds are
  // the editable resolved projection.
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
  modulesChanged?: boolean;
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

/**
 * The iOS app derives the controller site type from the fifth character of
 * the site ID rather than a stored archive field. Type 0 is the verified
 * local plaintext protocol; types 1 and 2 are remote/encrypted generations.
 */
export function siteTypeFromSiteId(id: string): number {
  const character = (id ?? "").trim().charAt(4);
  return character >= "0" && character <= "2" ? Number(character) : 0;
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
/**
 * Order-insensitive serialisation, for COMPARISON and checksums only.
 *
 * `stringifyConfiguration` preserves insertion order because it also writes the
 * `.fd4web.json` backup, where a stable readable shape matters. That makes it
 * unsafe for equality: an import → export → import round trip reorders keys
 * inside the preserved `legacy` bags, so two structurally identical
 * configurations serialise differently. Using it for a change-detection
 * checksum meant the checksum could change when nothing had changed.
 *
 * Keys are sorted recursively; array order is preserved, because array order is
 * meaningful here (module order, compiled assignment order).
 */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (typeof item === "bigint") {
      const numeric = Number(item);
      return Number.isSafeInteger(numeric) ? numeric : item.toString();
    }
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      const source = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort())
        sorted[key] = canonical(source[key]);
      return sorted;
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

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
/**
 * The site fields an import compares, with the label shown to an installer.
 *
 * `ip` and `port` are deliberately ABSENT. They are the live connection
 * endpoint, owned by discovery: `autoDetect` rewrites them after every connect,
 * so a working site's address legitimately diverges from the address its archive
 * was saved with. Including them made a site permanently unequal to its own
 * backup, prompting on every re-import over a difference the user cannot act on
 * — `mergeImportedSite` preserves the running endpoint either way.
 */
const COMPARED_SITE_FIELDS: {
  key: keyof Site;
  label: string;
  read: (site: Site) => unknown;
}[] = [
  { key: "name", label: "Site name", read: (s) => s.name },
  { key: "id", label: "Site ID", read: (s) => s.id },
  { key: "routerPort", label: "Router port", read: (s) => s.routerPort ?? null },
  { key: "description", label: "Description", read: (s) => s.description },
  { key: "address", label: "Address", read: (s) => s.address },
  { key: "contact", label: "Contact", read: (s) => s.contact ?? "" },
  { key: "email", label: "Email", read: (s) => s.email ?? "" },
  { key: "phone", label: "Phone", read: (s) => s.phone ?? "" },
  { key: "latitude", label: "Latitude", read: (s) => s.latitude ?? "" },
  { key: "longitude", label: "Longitude", read: (s) => s.longitude ?? "" },
  { key: "timezone", label: "Time zone", read: (s) => s.timezone },
  { key: "dst", label: "Daylight saving rule", read: (s) => s.dst },
  { key: "remote", label: "Remote access", read: (s) => s.remote },
  { key: "remoteServer", label: "Remote server", read: (s) => s.remoteServer ?? "" },
  // Compared but never named in a prompt — see siteImportDifferences.
  { key: "securityCode", label: "Controller security code", read: (s) => s.securityCode ?? "" },
  { key: "autoDetect", label: "Auto-detect controller", read: (s) => s.autoDetect ?? true },
  { key: "addressLines", label: "Address lines", read: (s) => s.addressLines ?? [] },
  { key: "siteType", label: "Controller site type", read: (s) => s.siteType ?? 0 },
  { key: "routerInbound", label: "Router inbound", read: (s) => s.routerInbound ?? false },
  { key: "wirelessGateways", label: "Wireless gateways", read: (s) => s.wirelessGateways ?? [] },
  { key: "moduleOrderA", label: "Bus A module order", read: (s) => s.moduleOrderA ?? [] },
  { key: "moduleOrderB", label: "Bus B module order", read: (s) => s.moduleOrderB ?? [] },
];

/**
 * The labels of the site fields that differ between a saved site and an import.
 *
 * The security code is compared but reported only as the fact that it differs —
 * its value must never reach a dialog or a log.
 */
export function siteImportDifferences(left: Site, right: Site): string[] {
  return COMPARED_SITE_FIELDS.filter(
    (field) => canonicalJson(field.read(left)) !== canonicalJson(field.read(right)),
  ).map((field) => field.label);
}

export function siteImportDetailsEqual(left: Site, right: Site) {
  return siteImportDifferences(left, right).length === 0;
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
  stateFlags: StateFlag[];
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
  /**
   * The configuration's own eight-character controller identifier. This is a
   * separate archive field from the owning site's `site.id`; the original app
   * uses it while compiling user/profile transfer data.
   */
  controllerCode?: string;
  lastUpdated: string;
  content?: ConfigContent;
  legacy?: Record<string, unknown>;
};

export type OwnedConfiguration = Omit<Configuration, "siteId" | "content"> & {
  content: ConfigContent;
};

/**
 * Recover the configuration identifier from the exact retained positional
 * archive slot for workspaces saved by builds that preserved the archive but
 * did not yet model `controllerCode`.
 *
 * This is a data migration, not a guess from the site ID. It is deliberately
 * limited to the active configuration because the retained site archive
 * describes that imported configuration only.
 */
export function migrateWorkspaceControllerCode(
  workspace: FlexiDimWorkspace,
): FlexiDimWorkspace {
  const siteIndex = workspace.sites.findIndex(
    (site) => site.id === workspace.activeSiteId,
  );
  if (siteIndex < 0) return workspace;
  const site = workspace.sites[siteIndex];
  const configurationIndex = site.configurations.findIndex(
    (configuration) => configuration.id === workspace.activeConfigId,
  );
  if (configurationIndex < 0) return workspace;
  const configuration = site.configurations[configurationIndex];
  if (/^[A-Za-z0-9]{8}$/.test(configuration.controllerCode ?? ""))
    return workspace;

  const top = site.legacy?.top;
  const hardwareOrder = site.legacy?.hardwareOrder;
  if (
    !top ||
    typeof top !== "object" ||
    !Array.isArray(hardwareOrder)
  )
    return workspace;
  const extraBase =
    30 +
    (site.moduleOrderA?.length ?? 0) +
    (site.moduleOrderB?.length ?? 0) +
    hardwareOrder.length;
  const retained = (top as Record<string, unknown>)[`$${extraBase + 2}`];
  if (typeof retained !== "string" || !/^[A-Za-z0-9]{8}$/.test(retained))
    return workspace;

  const configurations = [...site.configurations];
  configurations[configurationIndex] = {
    ...configuration,
    controllerCode: retained,
  };
  const sites = [...workspace.sites];
  sites[siteIndex] = { ...site, configurations };
  return { ...workspace, sites };
}

/**
 * Older persisted workspaces retained each imported user's raw `rmN` access
 * paths but saved empty resolved room/switch selections. Restore that derived
 * projection only for untouched imported profiles. Pending/current profiles
 * may have been deliberately edited and must never be overwritten.
 */
export function migrateWorkspaceImportedUserAccess(
  workspace: FlexiDimWorkspace,
): FlexiDimWorkspace {
  let changed = false;
  const sites = workspace.sites.map((site) => {
    const configurations = site.configurations.map((configuration) => {
      const content = configuration.content;
      const roomIdByLegacyKey = new Map(
        content.rooms.flatMap((room) =>
          room.legacyKey === undefined ? [] : [[room.legacyKey, room.id] as const]),
      );
      const switchIdByLegacyKey = new Map(
        content.switches.flatMap((wallSwitch) =>
          wallSwitch.legacyKey === undefined
            ? []
            : [[wallSwitch.legacyKey, wallSwitch.id] as const]),
      );
      const users = content.users.map((user) => {
        if (
          user.profileStatus !== "imported" ||
          !user.roomAccess?.length ||
          (user.roomIds?.length ?? 0) > 0 ||
          (user.switchIds?.length ?? 0) > 0
        )
          return user;
        const roomIds = user.roomAccess.flatMap((entry) => {
          const id = roomIdByLegacyKey.get(Number(entry.split("|")[0]));
          return id === undefined ? [] : [id];
        }).filter((id, index, values) => values.indexOf(id) === index);
        const switchIds = user.roomAccess.flatMap((entry) =>
          entry.split("|").slice(1).flatMap((value) => {
            const id = switchIdByLegacyKey.get(Number(value));
            return id === undefined ? [] : [id];
          }),
        ).filter((id, index, values) => values.indexOf(id) === index);
        if (!roomIds.length && !switchIds.length) return user;
        changed = true;
        return { ...user, roomIds, switchIds };
      });
      return users === content.users || users.every((user, index) => user === content.users[index])
        ? configuration
        : { ...configuration, content: { ...content, users } };
    });
    return configurations.every(
      (configuration, index) => configuration === site.configurations[index],
    )
      ? site
      : { ...site, configurations };
  });
  return changed ? { ...workspace, sites } : workspace;
}

/**
 * Restore the CoreFoundation dictionary enumeration rank that older workspaces
 * did not persist on imported channels. The retained hardware order is the
 * original archive order used by the exporter; existing ranks are authoritative
 * and are never replaced.
 */
export function migrateWorkspaceChannelProfileOrder(
  workspace: FlexiDimWorkspace,
): FlexiDimWorkspace {
  let changed = false;
  const sites = workspace.sites.map((site) => {
    const hardwareOrder = site.legacy?.hardwareOrder;
    if (!Array.isArray(hardwareOrder)) return site;
    const insertionKeys = [-4, ...hardwareOrder.map(Number)];
    const rankByLegacyKey = new Map(
      foundationDictionaryOrder(insertionKeys).flatMap(
        (insertionIndex, profileIndex) =>
          insertionIndex === 0
            ? []
            : [[insertionKeys[insertionIndex], profileIndex] as const],
      ),
    );
    const configurations = site.configurations.map((configuration) => {
      const channels = configuration.content.channels.map((channel) => {
        if (channel.profileOrder !== undefined || channel.legacyKey === undefined)
          return channel;
        const profileOrder = rankByLegacyKey.get(channel.legacyKey);
        if (profileOrder === undefined) return channel;
        changed = true;
        return { ...channel, profileOrder };
      });
      return channels.every(
        (channel, index) => channel === configuration.content.channels[index],
      )
        ? configuration
        : {
            ...configuration,
            content: { ...configuration.content, channels },
          };
    });
    return configurations.every(
      (configuration, index) => configuration === site.configurations[index],
    )
      ? site
      : { ...site, configurations };
  });
  return changed ? { ...workspace, sites } : workspace;
}

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
  "stateFlags",
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
  stateFlags?: StateFlag[];
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
    stateFlags: [],
    users: [],
    assignments: [],
    modules: [],
    deletedItems: [],
  };
}

export function snapshotConfigContent(source: AppData): ConfigContent {
  const content = Object.fromEntries(
    CONFIG_CONTENT_KEYS.map((key) => [key, source[key] ?? []]),
  ) as unknown as ConfigContent;
  const tables = normalizePeriodTables(content.periods, content.stateFlags);
  return { ...content, ...tables };
}

const PERIOD_ROW_COUNT = 10;
const STATE_FLAG_COUNT = 25;

/**
 * The iOS model stores one 35-object JCLFDPeriod array, but its screen and
 * compiler give those objects two distinct jobs: ten period rows followed by
 * twenty-five state-flag labels. Older web workspaces exposed all 35 as periods,
 * so this also performs the persisted-data migration.
 */
export function normalizePeriodTables(
  rawPeriods: Period[] = [],
  rawStateFlags: StateFlag[] = [],
): { periods: Period[]; stateFlags: StateFlag[] } {
  const periodRows = rawPeriods.slice(0, PERIOD_ROW_COUNT);
  const legacyFlagRows =
    rawStateFlags.length > 0
      ? rawStateFlags
      : rawPeriods.slice(PERIOD_ROW_COUNT, PERIOD_ROW_COUNT + STATE_FLAG_COUNT);
  const periods = Array.from({ length: PERIOD_ROW_COUNT }, (_, index) => {
    const existing = periodRows[index];
    return existing
      ? { ...existing, id: index + 1 }
      : {
          id: index + 1,
          name: "",
          start: "00:00",
          end: "00:00",
          days: allDays,
          enabled: true,
          startMode: 0,
          endMode: 0,
          legacyIndex: index,
        };
  });
  const stateFlags = Array.from({ length: STATE_FLAG_COUNT }, (_, index) => {
    const existing = legacyFlagRows[index];
    return {
      id: index + 1,
      name: existing?.name ?? "",
      legacyIndex: existing?.legacyIndex ?? PERIOD_ROW_COUNT + index,
      ...(existing?.legacy ? { legacy: existing.legacy } : {}),
    };
  });
  return { periods, stateFlags };
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
              key === "stateFlags"
                ? configuration.content[key] == null ||
                  Array.isArray(configuration.content[key])
                : Array.isArray(configuration.content[key]),
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
              : {
                  ...(configuration.content ?? emptyConfigContent()),
                  ...normalizePeriodTables(
                    configuration.content?.periods,
                    configuration.content?.stateFlags,
                  ),
                },
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
  const activeContent = {
    ...activeConfiguration.content,
    ...normalizePeriodTables(
      activeConfiguration.content.periods,
      activeConfiguration.content.stateFlags,
    ),
  };
  return {
    site: sites.find((site) => site.id === activeSite.id)!,
    sites,
    configurations,
    activeConfigId: activeConfiguration.id,
    ...activeContent,
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

  // NSDate archives seconds relative to the Apple epoch (2001-01-01T00:00:00Z).
  const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
  const archivedDateIso = (value: unknown): string | undefined => {
    const resolved = object(value);
    if (!resolved || className(value) !== "NSDate") return undefined;
    const seconds = number(resolved["NS.time"], Number.NaN);
    if (!Number.isFinite(seconds)) return undefined;
    return new Date(APPLE_EPOCH_MS + seconds * 1000).toISOString();
  };

  // Legacy bags must survive JSON persistence and drive the binary exporter,
  // so archive values are dereferenced to plain data instead of keeping dead
  // CF$UID indices into a discarded object table.
  const plainValue = (value: unknown): unknown => {
    const resolved = dereference(value);
    if (resolved === null || resolved === undefined) return undefined;
    if (typeof resolved === "bigint") {
      const numeric = Number(resolved);
      return Number.isSafeInteger(numeric) ? numeric : resolved.toString();
    }
    if (
      typeof resolved === "number" ||
      typeof resolved === "string" ||
      typeof resolved === "boolean"
    )
      return resolved;
    if (typeof resolved === "object") {
      const name = className(value);
      if (name === "NSDate") return { $date: archivedDateIso(value) };
      if (name === "NSMutableString" || name === "NSString")
        return string(value);
      if (name) {
        const nested: Record<string, unknown> = { $class: name };
        for (const [key, entry] of Object.entries(
          resolved as ArchiveObject,
        )) {
          if (key === "$class") continue;
          nested[key] = plainValue(entry);
        }
        return nested;
      }
    }
    return undefined;
  };
  const plainLegacy = (item: ArchiveObject): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (key === "$class") continue;
      const resolved = plainValue(value);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  };

  const hardware = instances("JCLFDHardware");
  if (!hardware.length)
    throw new Error("No FlexiDim hardware was found in the archive");
  const hardwareByKey = new Map(
    hardware.map((item) => [number(item.ky), item]),
  );
  // importConfigFD4CFG: decodes the positional `$0`, `$1`, … stream, inserts
  // a synthetic root hardware object under "-4", and then each decoded
  // JCLFDHardware under a decimal NSString key. Later user-profile generation
  // inherits the resulting NSMutableDictionary bucket order for exact ties.
  const decodedHardwareKeys = Object.entries(top)
    .flatMap(([key, value]) => {
      const match = /^\$(\d+)$/.exec(key);
      return match && className(value) === "JCLFDHardware"
        ? [{ position: Number(match[1]), key: number(object(value)?.ky) }]
        : [];
    })
    .sort((left, right) => left.position - right.position)
    .map(({ key }) => key);
  const dictionaryInsertionKeys = [-4, ...decodedHardwareKeys];
  const hardwareProfileOrder = new Map(
    foundationDictionaryOrder(dictionaryInsertionKeys).flatMap(
      (insertionIndex, profileIndex) =>
        insertionIndex === 0
          ? []
          : [[dictionaryInsertionKeys[insertionIndex], profileIndex] as const],
    ),
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
      legacy: plainLegacy(item),
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
  // Modules are stored as two ordered buses, A then B, in slots $30 onward:
  // bus-A IDs occupy $30..$30+modc-1 and bus-B IDs follow immediately. The
  // slot order is the controller-address order and must never be re-sorted.
  const busACount = Math.max(0, topNumber("modc"));
  const busBCount = Math.max(0, topNumber("modcB"));
  const moduleIdAtSlot = (slot: number) => number(topString(`$${slot}`), -1);
  const busAModules = Array.from({ length: busACount }, (_, moduleIndex) =>
    moduleIdAtSlot(30 + moduleIndex),
  ).filter((moduleNumber) => moduleNumber >= 0);
  const busBModules = Array.from({ length: busBCount }, (_, moduleIndex) =>
    moduleIdAtSlot(30 + busACount + moduleIndex),
  ).filter(
    (moduleNumber) =>
      moduleNumber >= 0 && !busAModules.includes(moduleNumber),
  );
  const encounteredModules = channelHardware
    .map((item) => number(item.md, -1))
    .filter((moduleNumber) => moduleNumber >= 0);
  const orderedModules = [
    ...new Set([...busAModules, ...busBModules, ...encounteredModules]),
  ];
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
      // Name the output from the recovered catalogue so an imported channel
      // reads the way the original app shows it. An unrecognised code keeps its
      // numeric identity rather than being renamed to something plausible.
      kind:
        channelTypeName(number(item.hw)) ?? `FlexiDim type ${number(item.hw)}`,
      level: 0,
      moduleId: moduleNumber >= 0 ? moduleNumber : undefined,
      moduleIndex: channelIndex,
      channelIndex,
      profileOrder: hardwareProfileOrder.get(number(item.ky)),
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
      // Taken from the stored `di` flag, not derived from the catalogue: `di` is
      // what the controller actually holds, and re-deriving it here would make
      // the exporter write back a value the source archive never contained.
      dimmable: item.di === true || number(item.di) > 0,
      hardwareChanged: item.ch === true || number(item.ch) > 0,
      legacyKey: number(item.ky),
      legacy: plainLegacy(item),
    };
  });
  const busBSet = new Set(busBModules);
  const modules: FlexModule[] = orderedModules.map((moduleId, position) => ({
    id: moduleId,
    name: `Module ${moduleId}`,
    bus: busBSet.has(moduleId) ? "B" : "A",
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
      legacy: {
        hardware: plainLegacy(item),
        settings: settings ? plainLegacy(settings) : undefined,
      },
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
      legacyKey: number(item.ky),
      legacy: plainLegacy(item),
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
    const channelOrder: number[] = [];
    // The archive's dictionary does not come back in key order — a four-channel
    // scene arrives as ch2, ch3, ch0, ch1 — so the suffix is the only reliable
    // sequence, and the Scene Controller image is built in exactly that order.
    const orderedChannelKeys = Object.keys(item)
      .filter((key) => /^ch\d+$/.test(key))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    for (const key of orderedChannelKeys) {
      const value = item[key];
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
        channelOrder.push(channelId);
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
      channelOrder,
      // `dr` is the display rank (recovered from the iOS binary); the scene
      // has no separate whole-scene fade, its channels carry their own.
      fade: 0,
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
      legacy: plainLegacy(item),
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
  // Archive dictionaries carry no guaranteed key order, so keep the list
  // deterministic for comparisons and exports.
  assignments.sort(
    (a, b) => a.switchId - b.switchId || a.button - b.button,
  );

  // The iOS controller deliberately stores 35 JCLFDPeriod objects in one array,
  // but the UI splits them into ten actual periods and a 5×5 grid of state-flag
  // names. The latter are labels only; exposing all 35 as schedule periods was a
  // web importer bug.
  const archivedPeriodRows = instances("JCLFDPeriod");
  const periods: Period[] = archivedPeriodRows.slice(0, 10).map((item, index) => {
    const minutes = (value: unknown) =>
      `${String(Math.floor(number(value) / 60)).padStart(2, "0")}:${String(number(value) % 60).padStart(2, "0")}`;
    return {
      id: index + 1,
      name: string(item.nm).trim(),
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
      legacy: plainLegacy(item),
    };
  });
  const stateFlags: StateFlag[] = archivedPeriodRows
    .slice(10, 35)
    .map((item, index) => ({
      id: index + 1,
      name: string(item.nm).trim(),
      legacyIndex: number(item.ix, index + 10),
      legacy: plainLegacy(item),
    }));
  const normalizedPeriodTables = normalizePeriodTables(periods, stateFlags);

  const users: FlexUser[] = instances("JCLFDUser").map((item, index) => {
    // Archive keys recovered from the iOS binary and validated against a real
    // archive: sk 16-character security key, ve profile version, rc access-entry
    // count, rm0..rmN pipe-delimited room/switch legacy-key paths.
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
      roomIds: roomAccess.flatMap((entry) => {
        const roomKy = Number(entry.split("|")[0]);
        const room = rooms.find((candidate) => candidate.legacyKey === roomKy);
        return room ? [room.id] : [];
      }).filter((id, index, values) => values.indexOf(id) === index),
      switchIds: roomAccess.flatMap((entry) =>
        entry.split("|").slice(1).flatMap((value) => {
          const wallSwitch = switches.find(
            (candidate) => candidate.legacyKey === Number(value),
          );
          return wallSwitch ? [wallSwitch.id] : [];
        }),
      ).filter((id, index, values) => values.indexOf(id) === index),
      roomAccess,
      accessCount,
      profileVersion: number(item.ve),
      profileStatus: "imported",
      legacy: plainLegacy(item),
    };
  });

  // Site fields are stored as positional NSKeyedArchiver entries ($0..$N) in
  // the app's encode order, recovered from the iOS binary's getExportFileData:
  //   $0 format marker ("29")  $1 name  $2-$5 address lines  $6 contact
  //   $7 phone  $8 email  $9 siteID  $10 security code  $11 IP
  //   $12 auto-detect  $13 modules-changed flag  $14 last updated
  //   $15 longitude  $16 latitude  $17 time zone  $18 router-inbound flag
  //   $19 router-inbound port  $20 DST rules  $21-$24 wireless-gateway
  //   addresses  $25-$28 wireless-gateway counts  $29 remote server
  const addressLines = ["$2", "$3", "$4", "$5"].map((key) => topString(key));
  const address = addressLines
    .filter(Boolean)
    .join(", ");
  const dstRaw = topString("$20");
  const dst = /uk|europe/i.test(dstRaw)
    ? "UK / Europe"
    : /usa|us\b/i.test(dstRaw)
      ? "USA"
      : "No daylight saving";
  const routerInbound = topString("$18") !== "" && topString("$18") !== "0";
  const routerPortValue = topNumber("$19");
  const remoteServer = topString("$29");
  const updatedRaw = topString("$14") || archivedDateIso(top["$14"]) || "";
  const updatedDate = new Date(updatedRaw);
  const lastUpdated =
    updatedRaw && !Number.isNaN(updatedDate.getTime())
      ? updatedDate.toISOString()
      : "";
  // The iOS decoder derives the site type from the fifth character of the
  // site ID rather than a stored field; the reference site selects type 0.
  const siteId = topString("$9") || "FD4";
  const siteType = siteTypeFromSiteId(siteId);
  const site: Site = {
    name: topString("$1") || "Imported FlexiDim site",
    id: siteId,
    ip: topString("$11") || "192.168.1.50",
    port: 15273,
    // $19 is the router-inbound port. Never turn a boolean-like remnant into
    // a TCP destination.
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
    remote: siteType !== 0 && Boolean(remoteServer),
    remoteServer,
    securityCode: topString("$10"),
    autoDetect: topString("$12") !== "0" && topNumber("$12") !== 0,
    addressLines,
    siteType,
    // $13 is the modules-changed flag written by the iOS equipment editors.
    modulesChanged: topString("$13") !== "" && topString("$13") !== "0",
    routerInbound,
    // Four wireless-gateway address slots ($21..$24) and their counts
    // ($25..$28).
    wirelessGateways: [0, 1, 2, 3].flatMap((index) => {
      const address = topString(`$${21 + index}`);
      const count = topNumber(`$${25 + index}`);
      return address ? [{ address, count }] : [];
    }),
    moduleOrderA: busAModules,
    moduleOrderB: busBModules,
    updatedAt: lastUpdated,
    legacy: {
      // Dereferenced positional scalars (modeled object slots excluded) plus
      // the original archive ordering, so the binary exporter can reproduce
      // the exact iOS encode layout and unknown fields survive round-trips.
      top: Object.fromEntries(
        Object.entries(top).flatMap(([key, value]) => {
          if (className(value).startsWith("JCLFD")) return [];
          const resolved = plainValue(value);
          return resolved === undefined ? [] : [[key, resolved]];
        }),
      ),
      hardwareOrder: hardware.map((item) => number(item.ky)),
      sceneOrder: archivedScenes.map((item) => number(item.ky)),
    },
  };
  // The four post-hardware slots carry the configuration's own identity:
  // name, description, an eight-character code and its update date.
  const extraBase =
    30 + busACount + busBCount + Math.max(topNumber("hwc"), hardware.length);
  const configName = topString(`$${extraBase}`);
  const configDescription = topString(`$${extraBase + 1}`);
  const configControllerCode = topString(`$${extraBase + 2}`);
  const configUpdated = archivedDateIso(top[`$${extraBase + 3}`]) ?? "";
  return {
    site,
    configurations: [
      {
        id: 1,
        siteId: site.id,
        name: configName || site.name,
        description: configDescription || site.description,
        ...(configControllerCode ? { controllerCode: configControllerCode } : {}),
        lastUpdated: configUpdated || lastUpdated,
      },
    ],
    activeConfigId: 1,
    rooms,
    channels,
    switches,
    sceneGroups,
    scenes,
    deletedScenes,
    periods: normalizedPeriodTables.periods,
    stateFlags: normalizedPeriodTables.stateFlags,
    users,
    assignments,
    modules,
    deletedItems: [],
  };
}

export function parseLegacyFd4Config(buffer: ArrayBuffer): AppData {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  const signature = new TextDecoder().decode(bytes);
  if (signature.startsWith("bplist"))
    return convertLegacyArchive(parseBinaryPlist(buffer));
  // `.fd4xlt` translation documents are plain text, not keyed archives.
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  if (/^\s*#SWITCHES/m.test(text)) return parseFd4XltDocument(text);
  throw new Error(
    "The file is neither a FlexiDim binary configuration nor a translation document",
  );
}

/**
 * Parse a `.fd4xlt` translation document. Recovered from the iOS binary's
 * importConfigFD4XLT:: a CRLF-line text file with three sections —
 *   #SWITCHES <number>,<type>,<name>
 *   #CHANNELS <number>,<dimmable>,<name>
 *   #SWITCH-SCENES <switch>:<button>,<scene1>,<scene2>
 * Importing one creates a fresh starting-point configuration (no basic
 * assignments, periods or users), exactly like the original app.
 */
export function parseFd4XltDocument(text: string): AppData {
  const lines = text.split(/\r?\n/);
  let section: "switches" | "channels" | "switchScenes" | null = null;
  type XltSwitch = { number: number; type: number; name: string };
  type XltChannel = { number: number; dimmable: boolean; name: string };
  type XltAssignment = { switchNumber: number; button: number; scenes: string[] };
  const xltSwitches: XltSwitch[] = [];
  const xltChannels: XltChannel[] = [];
  const xltAssignments: XltAssignment[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#SWITCHES")) {
      section = "switches";
      continue;
    }
    if (line.startsWith("#CHANNELS")) {
      section = "channels";
      continue;
    }
    if (line.startsWith("#SWITCH-SCENES")) {
      section = "switchScenes";
      continue;
    }
    if (line.startsWith("#")) continue; // comment row
    const fields = line.split(/[|,]/).map((field) => field.trim());
    if (section === "switches" && fields.length >= 3) {
      const [numberField, typeField, ...nameFields] = fields;
      xltSwitches.push({
        number: number(numberField),
        type: number(typeField),
        name: nameFields.join(", ") || `Switch ${numberField}`,
      });
    } else if (section === "channels" && fields.length >= 3) {
      const [numberField, dimmableField, ...nameFields] = fields;
      xltChannels.push({
        number: number(numberField),
        dimmable: number(dimmableField) !== 0,
        name: nameFields.join(", ") || `Channel ${numberField}`,
      });
    } else if (section === "switchScenes" && fields.length >= 2) {
      const [slotField, ...sceneFields] = fields;
      const slot = /^(\d+):(\d+)$/.exec(slotField);
      if (!slot) continue;
      xltAssignments.push({
        switchNumber: Number(slot[1]),
        button: Number(slot[2]),
        scenes: sceneFields.filter((name) => name.length > 0),
      });
    }
  }
  if (!xltSwitches.length && !xltChannels.length)
    throw new Error("The translation document contains no equipment");

  const room: Room = {
    id: 1,
    name: "FlexiDim",
    floor: "FlexiDim",
    icon: "/flexidim/rooms/0.png",
    parentId: null,
    areaType: "Floor",
  };
  const switchTypeNames: Record<number, { name: string; buttons: number }> = {
    15: { name: "8 scene", buttons: 11 },
    13: { name: "4 scene", buttons: 7 },
    8: { name: "8 channel opto", buttons: 8 },
    2: { name: "2 channel opto", buttons: 2 },
  };
  const switches: WallSwitch[] = xltSwitches.map((item, index) => ({
    id: index + 1,
    name: item.name,
    roomId: room.id,
    kind: switchTypeNames[item.type]?.name ?? `${item.type} type`,
    buttons: switchTypeNames[item.type]?.buttons ?? 8,
    type: item.type,
    number: item.number,
    hardwareType: item.type,
  }));
  const channels: Channel[] = xltChannels.map((item, index) => ({
    id: index + 1,
    name: item.name,
    roomId: room.id,
    module: `Channel ${item.number}`,
    kind: item.dimmable ? "Dimmable" : "On/Off",
    level: 0,
    channelIndex: item.number,
    controllerChannel: item.number,
    dimmable: item.dimmable,
  }));

  // Scenes come only from the switch-scene rows; consecutive fields are the
  // first and second press of one physical button.
  const sceneIdByName = new Map<string, number>();
  const scenes: Scene[] = [];
  const assignments: Assignment[] = [];
  const switchIdByNumber = new Map(
    switches.map((item) => [item.number ?? item.id, item.id]),
  );
  for (const entry of xltAssignments) {
    const switchId = switchIdByNumber.get(entry.switchNumber);
    if (!switchId) continue;
    entry.scenes.forEach((sceneName, pressIndex) => {
      let sceneId = sceneIdByName.get(sceneName);
      if (!sceneId) {
        sceneId = scenes.length + 1;
        sceneIdByName.set(sceneName, sceneId);
        scenes.push({
          id: sceneId,
          name: sceneName,
          shortName: sceneName,
          group: "Scenes",
          folderPath: ["Scenes"],
          levels: {},
          channelSettings: {},
          fade: 0,
          enabled: true,
          days: allDays,
          time: "",
          displayRank: sceneId,
        });
      }
      assignments.push({
        switchId,
        button: (entry.button - 1) * 2 + pressIndex + 1,
        sceneId,
      });
    });
  }

  const site: Site = {
    name: "Imported FlexiDim site",
    id: "FD4",
    ip: "192.168.1.50",
    port: 15273,
    routerPort: 15273,
    description: "Created as starting point",
    address: "",
    timezone: normalizeSiteTimeZone("", "UK / Europe"),
    dst: "UK / Europe",
    remote: false,
    autoDetect: true,
    siteType: 0,
  };
  return {
    site,
    configurations: [
      {
        id: 1,
        siteId: site.id,
        name: "Initial import",
        description: "Created as starting point",
        lastUpdated: "",
      },
    ],
    activeConfigId: 1,
    rooms: [room],
    channels,
    switches,
    sceneGroups: [],
    scenes,
    deletedScenes: [],
    periods: [],
    users: [],
    assignments,
    modules: [],
    deletedItems: [],
  };
}

/** Build a `.fd4xlt` translation document from the current configuration. */
export function buildFd4XltDocument(data: AppData): string {
  const lines: string[] = [];
  lines.push("#SWITCHES <number> <Type> <name/location>");
  lines.push(
    "# Type 15 = 8 scene : Type 13 = 4 scene : Type 2 = 2 channel opto : Type 8 = 8 channel opto",
  );
  for (const wallSwitch of data.switches)
    lines.push(
      `${wallSwitch.number ?? wallSwitch.id},${wallSwitch.type ?? wallSwitch.hardwareType ?? 15},${wallSwitch.name}`,
    );
  lines.push("#CHANNELS <number> <dimmable> <name/location>");
  for (const channel of data.channels)
    lines.push(
      `${channel.controllerChannel ?? channel.channelIndex ?? channel.id},${channel.dimmable === false ? 0 : 1},${channel.name}`,
    );
  lines.push(
    "#SWITCH-SCENES <switch number:button number> <scene1 name/location> <scene2 name/location>",
  );
  const sceneById = new Map(data.scenes.map((scene) => [scene.id, scene]));
  const bySwitch = new Map<number, Map<number, string[]>>();
  for (const assignment of data.assignments) {
    if (!assignment.sceneId) continue;
    const scene = sceneById.get(assignment.sceneId);
    if (!scene) continue;
    const physical = Math.ceil(assignment.button / 2);
    const press = (assignment.button - 1) % 2;
    const wallSwitch = data.switches.find(
      (item) => item.id === assignment.switchId,
    );
    if (!wallSwitch) continue;
    const switchNumber = wallSwitch.number ?? wallSwitch.id;
    if (!bySwitch.has(switchNumber)) bySwitch.set(switchNumber, new Map());
    const buttons = bySwitch.get(switchNumber)!;
    if (!buttons.has(physical)) buttons.set(physical, []);
    buttons.get(physical)![press] = scene.name;
  }
  for (const [switchNumber, buttons] of [...bySwitch.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    for (const [button, presses] of [...buttons.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      lines.push(
        `${switchNumber}:${button},${presses[0] ?? ""},${presses[1] ?? ""}`,
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}
