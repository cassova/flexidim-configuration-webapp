"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  canonicalizeAppData,
  buildUserProfileData,
  controllerConnectionRequest,
  emptyConfigContent,
  isFlexiDimWorkspace,
  materializeAppData,
  mergeLegacyBrowserConnectionState,
  migrateWorkspaceControllerCode,
  migrateWorkspaceChannelProfileOrder,
  migrateWorkspaceImportedUserAccess,
  orderUserAccess,
  parseLegacyFd4Config,
  CONFIG_CONTENT_KEYS,
  deleteConfigEntity,
  type AppData,
  type Configuration,
  type ConfigContent,
  type DeletedItem,
  type FlexModule,
  type FlexiDimWorkspace,
  type Channel,
  type Room,
  type Scene,
  type SceneChannelSettings,
  type SceneGroup,
  type Site,
  type WallSwitch,
  mergeImportedSite,
  normalizeSiteTimeZone,
  stringifyConfiguration,
  isStarterSite,
  upsertImportedConfiguration,
  siteImportDetailsEqual,
  siteImportDifferences,
  updateUserProfile,
  validateConfigContent,
  siteTypeFromSiteId,
} from "./fd4cfg";
import { buildLegacyArchive } from "./fd4cfg-export";
import { transferReadiness } from "./transfer-readiness";
import { compileConfig, formatChecksum } from "./compile-config";
import { compileUserProfiles } from "./compile-user-profiles";
import { onOffPriority } from "./basic-assignment";
import {
  UTILITY_BUTTON_PROMPT,
  generateSceneUtility,
  type SceneUtility,
} from "./scene-utilities";
import {
  UNRECOVERED_SCENE_FLAGS,
  editScene,
  moveScene,
  moveSceneGroup,
  sceneIsLocked,
  switchesAffectedByScene,
  unknownSceneFlagBits,
} from "./scene-order";
import {
  controllerActionState,
  type ControllerActionState,
} from "./controller-actions";
import {
  ACCESSORY_TYPE_NAMES,
  DEFAULT_CHANNEL_TYPE_FAMILY,
  SWITCH_TYPES,
  channelSupportsColour,
  channelTypeFamily,
  isBlindControl,
  switchTypeByCode,
  switchTypeByName,
} from "./channel-catalogue";
import {
  controllerChannelAddress,
  controllerModuleNumber,
} from "./flexidim-addressing.mjs";
import { defaultOnOffCommands, rawControllerButton } from "./live-switch.mjs";
import { dstTransition, isDstActive, loadDstRuleSet, type DstYearRule } from "./dst-rules";
import { solarTimes } from "./solar";

/**
 * Site types are a protocol generation, not a preference: only type 0 (local
 * plaintext) is protocol-verified, so the other two are labelled as such.
 */
const SITE_TYPE_LABELS: Record<number, string> = {
  0: "Type 0 — local plaintext",
  1: "Type 1 — remote (not yet available)",
  2: "Type 2 — encrypted remote (not yet available)",
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function transferClock(now = new Date()) {
  const january = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const july = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    weekday: now.getDay(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
    dst: now.getTimezoneOffset() < Math.max(january, july),
  };
}

type Tab =
  | "Sites"
  | "Configurations"
  | "Equipment"
  | "Switches"
  | "Basic Assignments"
  | "Scenes"
  | "Scene to Button"
  | "Periods"
  | "Users"
  | "Trace";
type TraceItem = { at: string; text: string; tone?: "ok" | "warn" };
type TransferPreflight = {
  state: "passed" | "failed";
  message: string;
  imageChecksum?: string;
  imageBytes?: number;
  firstPassChecksum?: string;
  blockCount?: number;
  userCount?: number;
  userBytes?: number;
  frameCount?: number;
  runnerQualification?: {
    state: "passed";
    resetReconnectExercised: true;
    validatedStatusRecords: 10;
  };
  lifecycle?: string[];
  transcriptSha256?: string;
  comparison?: { fresh: boolean; bound: boolean; ageMs: number | null };
  eligibleAfterHardwareQualification?: boolean;
  liveWritesEnabled: boolean;
};
type TransferProgress = {
  state: string;
  message: string;
  blockNumber?: number;
  retry?: number;
};
type TransferResult = {
  state: "completed" | "failed";
  outcome: string;
  message: string;
  imageChecksum?: string;
  frameCount?: number;
};
type EquipmentSection = "areas" | "modules" | "switches" | "deleted";
type EquipmentSelection =
  | { type: "area"; id: number }
  | { type: "module"; id: number }
  | { type: "switch"; id: number }
  | { type: "light"; id: number }
  | null;

const tabs: { name: Tab; icon: string }[] = [
  { name: "Sites", icon: "/flexidim/sites.png" },
  { name: "Configurations", icon: "/flexidim/configurations.png" },
  { name: "Basic Assignments", icon: "/flexidim/switches.png" },
  { name: "Scenes", icon: "/flexidim/scenes.png" },
  { name: "Scene to Button", icon: "/flexidim/scene-button.png" },
  { name: "Users", icon: "/flexidim/users.png" },
  { name: "Periods", icon: "/flexidim/periods.png" },
  { name: "Equipment", icon: "/flexidim/equipment.png" },
  { name: "Trace", icon: "/flexidim/wireless.png" },
];

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sceneTimerModes = [
  "After delay of:",
  "At time:",
  "Before sunrise, offset:",
  "After sunrise, offset:",
  "Before sunset, offset:",
  "After sunset, offset:",
  "Cancel",
  "Cancel sequence",
  "Reset cycle",
];
const sceneTimerDays = [
  "Any day",
  "Sat / Sun",
  "Mon - Fri",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const periodModes = [
  "Before sunrise", "After sunrise", "Before sunset", "After sunset", "Absolute time",
];
const timerHours = Array.from({ length: 24 }, (_, value) => value);
const timerMinutes = Array.from({ length: 60 }, (_, value) => value);
const timerSeconds = Array.from({ length: 30 }, (_, value) => value * 2);
const twoDigits = (value: number) => String(value).padStart(2, "0");
const roomIcons = [
  "/flexidim/room-0.png",
  "/flexidim/room-3.png",
  "/flexidim/room-10.png",
  "/flexidim/room-100.png",
];
const areaIconChoices = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 96, 97, 98, 99, 100, 101, 102, 103,
].map((id) => `/flexidim/rooms/${id}.png`);

const initialData: AppData = {
  site: {
    name: "Home",
    id: "FD4-0001",
    ip: "192.168.1.50",
    port: 15273,
    routerPort: 15273,
    description: "FlexiDim lighting system",
    address: "",
    contact: "",
    email: "",
    phone: "",
    latitude: "",
    longitude: "",
    timezone: "Europe/London",
    dst: "UK / Europe",
    remote: false,
    remoteServer: "",
    securityCode: "",
    autoDetect: true,
    addressLines: ["", "", "", ""],
    siteType: 0,
    routerInbound: false,
    wirelessGateways: [],
    bridgeUrl: "/bridge",
    bridgeToken: "",
  },
  configurations: [
    {
      id: 1,
      siteId: "FD4-0001",
      name: "Home",
      description: "FlexiDim lighting system",
      lastUpdated: "2026-07-14T00:00:00.000Z",
    },
  ],
  activeConfigId: 1,
  rooms: [
    { id: 1, name: "Kitchen", floor: "Ground floor", icon: roomIcons[0] },
    { id: 2, name: "Living room", floor: "Ground floor", icon: roomIcons[3] },
    { id: 3, name: "Hall", floor: "Ground floor", icon: roomIcons[2] },
  ],
  channels: [
    {
      id: 1,
      name: "Kitchen pendants",
      roomId: 1,
      module: "Module 1 / Ch1",
      kind: "Trailing edge",
      level: 72,
    },
    {
      id: 2,
      name: "Worktop",
      roomId: 1,
      module: "Module 1 / Ch2",
      kind: "DALI",
      level: 48,
    },
    {
      id: 3,
      name: "Living room lamps",
      roomId: 2,
      module: "Module 1 / Ch3",
      kind: "Trailing edge",
      level: 35,
    },
    {
      id: 4,
      name: "Hall",
      roomId: 3,
      module: "Module 1 / Ch4",
      kind: "Relay",
      level: 100,
    },
  ],
  switches: [
    { id: 1, name: "Kitchen entrance", roomId: 1, kind: "4 scene", type: 13, buttons: 7 },
    { id: 2, name: "Living room", roomId: 2, kind: "8 scene", type: 15, buttons: 11 },
  ],
  scenes: [
    {
      id: 1,
      name: "All Off",
      group: "Whole house",
      levels: { 1: 0, 2: 0, 3: 0, 4: 0 },
      fade: 1,
      enabled: true,
      startMode: 4,
      endMode: 4,
      days: dayNames,
      time: "",
    },
    {
      id: 2,
      name: "Bright",
      group: "Kitchen",
      levels: { 1: 100, 2: 100 },
      fade: 2,
      enabled: true,
      days: dayNames,
      time: "",
    },
    {
      id: 3,
      name: "Evening",
      group: "Living room",
      levels: { 1: 25, 2: 35, 3: 28, 4: 15 },
      fade: 5,
      enabled: true,
      days: dayNames,
      time: "19:00",
    },
  ],
  periods: [
    {
      id: 1,
      name: "Evening",
      start: "18:00",
      end: "23:30",
      days: dayNames,
      enabled: true,
    },
  ],
  users: [
    {
      id: 1,
      name: "Home owner",
      remote: false,
      changes: true,
      key: "1234 5678 abcd efgh",
    },
  ],
  assignments: [
    { switchId: 1, button: 1, sceneId: 2 },
    { switchId: 1, button: 2, sceneId: 3 },
    { switchId: 1, button: 4, sceneId: 1 },
  ],
};

// FlexiDim switch types (recovered from the iOS binary). The name reflects the
// count of main scene buttons; the physical plate also carries a shifted column
// of three extra buttons, so an "8 scene" switch has 11 physical buttons.

// "When button pressed" test modes (recovered from the iOS binary, with the
// original option descriptions).
const BUTTON_PRESS_MODES = [
  {
    value: "none",
    label: "Don't send",
    help: "No switch press information is sent to the lighting system.",
  },
  {
    value: "latest",
    label: "Latest settings",
    help: "Switch press information is sent to the lighting system, which will interpret it based on the last configuration sent.",
  },
  {
    value: "live",
    label: "Live system",
    help: "Commands are sent to the lighting system to show the effect of the switch press based upon the current configuration.",
  },
] as const;
type ButtonPressMode = (typeof BUTTON_PRESS_MODES)[number]["value"];

// The three buttons in the shifted right-hand column carry built-in functions
// on their first press when no scene is assigned; their second press has none.
const SPECIAL_BUTTON_FUNCTIONS = [
  { name: "Manual raise", help: "Hold to make the lights gradually brighter." },
  { name: "Manual lower", help: "Hold to make the lights gradually dimmer." },
  {
    name: "Default on/off",
    help: "First press turns everything on; second press turns everything off.",
  },
];

// The built-in first-press function for a shifted-column button, or undefined
// for an ordinary button. position is the physical plate position (1-based).
function specialButtonDefault(
  buttons: number,
  position: number,
): { name: string; help: string } | undefined {
  if (buttons < 7 || buttons % 4 !== 3) return undefined;
  const ordinal = position - (buttons - 3);
  if (ordinal < 1 || ordinal > 3) return undefined;
  return SPECIAL_BUTTON_FUNCTIONS[ordinal - 1];
}

// Physical arrangement of the buttons on a FlexiDim wall switch. The plates in
// this range are built from full columns of four buttons plus a right-hand
// column that is shifted across and holds two buttons, a gap, then one more
// (e.g. 7 = 4 + [2,gap,1], 11 = 4 + 4 + [2,gap,1]). Buttons are numbered
// column-major: down each full column left-to-right, then the shifted column.
function switchButtonLayout(count: number): {
  cells: { button: number; column: number; row: number }[];
  columns: string;
} {
  const cells: { button: number; column: number; row: number }[] = [];
  if (count >= 7 && count % 4 === 3) {
    const fullColumns = (count - 3) / 4;
    let button = 1;
    for (let column = 1; column <= fullColumns; column++) {
      for (let row = 1; row <= 4; row++) cells.push({ button: button++, column, row });
    }
    // +1 for the narrow spacer column that produces the shift, +1 to land on it.
    const shiftedColumn = fullColumns + 2;
    for (const row of [1, 2, 4]) cells.push({ button: button++, column: shiftedColumn, row });
    return {
      cells,
      columns: `${"var(--sw-col) ".repeat(fullColumns)}var(--sw-gap) var(--sw-col)`.trim(),
    };
  }
  // Fallback for any other size: plain columns of four, filled top-to-bottom.
  const columnCount = Math.max(1, Math.ceil(count / 4));
  let button = 1;
  for (let column = 1; column <= columnCount && button <= count; column++) {
    for (let row = 1; row <= 4 && button <= count; row++) {
      cells.push({ button: button++, column, row });
    }
  }
  return { cells, columns: `repeat(${columnCount}, var(--sw-col))` };
}

function HelpTip({ label, help }: { label: string; help: string }) {
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );
  const show = (event: React.SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCoords({ left: rect.left + rect.width / 2, top: rect.top });
  };
  const hide = () => setCoords(null);
  return (
    <i
      className="help-icon"
      tabIndex={0}
      aria-label={`${label} help`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      ?
      {coords &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className="help-tooltip"
            role="tooltip"
            style={{ left: coords.left, top: coords.top }}
          >
            {help}
          </span>,
          document.body,
        )}
    </i>
  );
}

function Field({
  label,
  children,
  help,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <label className="field">
      <span className="option-label">
        {label}
        {help && <HelpTip label={String(label)} help={help} />}
      </span>
      {children}
    </label>
  );
}

/**
 * A controller action that is only offered when the active profile actually
 * supports it. When it does not, the button stays visible but disabled and
 * carries the specific missing evidence, so an installer can tell "not
 * implemented" apart from "not verified against hardware".
 */
function GatedAction({
  state,
  onClick,
  children,
}: {
  state: ControllerActionState;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span className="gated-action">
      <button
        disabled={!state.allowed}
        title={state.reason}
        aria-describedby={state.allowed ? undefined : "gated-reason"}
        onClick={onClick}
      >
        {children}
      </button>
      {!state.allowed && (
        <small className="gated-reason">{state.reason}</small>
      )}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  help,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <label className="toggle-row">
      <span className="option-label">
        {label}
        {help && <HelpTip label={label} help={help} />}
      </span>
      <button
        type="button"
        className={`ios-toggle ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        disabled={disabled}
      >
        <i />
      </button>
    </label>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span>＋</span>
      <p>{children}</p>
    </div>
  );
}

function newId(items: { id: number }[]) {
  return Math.max(0, ...items.map((item) => item.id)) + 1;
}
function now() {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function generateSecurityKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validControllerSecurityCode(value?: string) {
  return typeof value === "string" && /^[\x20-\x7e]{16}$/.test(value);
}

function restoreAreaHierarchy(data: AppData): AppData {
  const rooms = data.rooms.map((room) => {
    if (room.parentId) return room;
    const floor = room.floor?.trim().toLocaleLowerCase();
    if (!floor || floor === "flexidim") return room;
    const parent = data.rooms.find(
      (candidate) =>
        candidate.id !== room.id &&
        candidate.name.trim().toLocaleLowerCase() === floor,
    );
    return parent ? { ...room, parentId: parent.id } : room;
  });
  const normalizedRooms = rooms.map((room) => ({
    ...room,
    shortName: room.shortName ?? room.name,
    areaType:
      room.areaType ?? (room.parentId ? ("Room" as const) : ("Floor" as const)),
  }));
  const normalizedChannels = data.channels.map((channel) => {
    const moduleMatch = channel.module.match(/Module\s+(\d+)/i);
    return {
      ...channel,
      moduleId:
        channel.moduleId ??
        (moduleMatch ? Number(moduleMatch[1]) : undefined),
      accessoryModule: channel.accessoryModule ?? "None",
      minimum: channel.minimum ?? 0,
      maximum: channel.maximum ?? 100,
      defaultLevel: channel.defaultLevel ?? 100,
    };
  });
  const moduleIds = [
    ...new Set(
      normalizedChannels
        .map((channel) => channel.moduleId)
        .filter((id): id is number => id !== undefined),
    ),
  ];
  // Migrate data imported by the previous webapp build. That importer encoded
  // module position in a four-bit nibble. Detect that exact signature before
  // rewriting so correctly imported archives with a non-sorted module order
  // remain untouched.
  const legacyModuleOrder = [...moduleIds].sort((a, b) => a - b);
  const hasLegacyAddresses = normalizedChannels.some((channel) => {
    const position = legacyModuleOrder.indexOf(channel.moduleId ?? -1);
    return position > 0 && channel.moduleIndex != null &&
      channel.controllerChannel ===
        ((position << 4) | (channel.moduleIndex & 0x0f));
  });
  const channels = hasLegacyAddresses
    ? normalizedChannels.map((channel) => {
        const position = legacyModuleOrder.indexOf(channel.moduleId ?? -1);
        return position >= 0 && channel.moduleIndex != null
          ? {
              ...channel,
              controllerChannel: controllerChannelAddress(
                position,
                channel.moduleIndex,
              ),
            }
          : channel;
      })
    : normalizedChannels;
  const restoredSceneGroups: SceneGroup[] = data.sceneGroups?.length
    ? data.sceneGroups
    : [];
  const sceneGroupByPath = new Map<string, number>();
  const restoredScenes = data.scenes.map((scene) => {
    if (scene.groupId && restoredSceneGroups.some((group) => group.id === scene.groupId))
      return scene;
    const path = scene.folderPath?.length
      ? scene.folderPath
      : [scene.group || "Scenes"];
    let parentId: number | null = null;
    path.forEach((name, index) => {
      const pathKey = path.slice(0, index + 1).join("\u0000");
      let groupId = sceneGroupByPath.get(pathKey);
      if (!groupId) {
        groupId = Math.max(0, ...restoredSceneGroups.map((group) => group.id)) + 1;
        restoredSceneGroups.push({
          id: groupId,
          name,
          shortName: name,
          parentId,
          icon: roomIcons[index === 0 ? 0 : 3],
          displayRank: restoredSceneGroups.length,
        });
        sceneGroupByPath.set(pathKey, groupId);
      }
      parentId = groupId;
    });
    return { ...scene, groupId: parentId ?? undefined };
  });
  // The physical button count is fixed by the switch's hardware type. Older
  // data (and pre-fix imports) stored the archive's button-scene slot count
  // instead, so recompute from type when known and never keep an impossible
  // count (real FlexiDim plates top out at 11 buttons).
  const buttonsByType: Record<number, number> = { 15: 11, 13: 7, 8: 8, 2: 2 };
  const switches = data.switches.map((wallSwitch) => {
    const fromType =
      wallSwitch.type != null ? buttonsByType[wallSwitch.type] : undefined;
    const buttons =
      fromType ?? (wallSwitch.buttons > 11 ? 11 : wallSwitch.buttons);
    return buttons === wallSwitch.buttons
      ? wallSwitch
      : { ...wallSwitch, buttons };
  });
  // Ensure every site has at least one configuration (older data predates the
  // multi-configuration model).
  const configurations =
    data.configurations?.length
      ? data.configurations
      : [
          {
            id: 1,
            siteId: data.site.id,
            name: data.site.name,
            description: data.site.description,
            lastUpdated: "",
          },
        ];
  const activeConfigId =
    data.activeConfigId &&
    configurations.some((config) => config.id === data.activeConfigId)
      ? data.activeConfigId
      : configurations[0].id;
  return {
    ...data,
    configurations,
    activeConfigId,
    rooms: normalizedRooms,
    channels,
    switches,
    sceneGroups: restoredSceneGroups,
    scenes: restoredScenes,
    deletedScenes: data.deletedScenes ?? [],
    sites: data.sites?.length ? data.sites : [data.site],
    modules:
      data.modules?.length
        ? data.modules
        : moduleIds.map((id) => ({
            id,
            name: `Module ${id}`,
            bus: "A" as const,
            enabled: true,
            pending: false,
          })),
    deletedItems: data.deletedItems ?? [],
    site: {
      ...data.site,
      addressLines: data.site.addressLines?.length
        ? [...data.site.addressLines, "", "", "", ""].slice(0, 4)
        : [data.site.address ?? "", "", "", ""],
      siteType: data.site.siteType ?? 0,
      routerInbound: data.site.routerInbound ?? Boolean(data.site.routerPort),
      wirelessGateways: data.site.wirelessGateways ?? [],
      bridgeUrl: data.site.bridgeUrl ?? "/bridge",
      bridgeToken: data.site.bridgeToken ?? "",
      timezone: normalizeSiteTimeZone(data.site.timezone, data.site.dst),
    },
  };
}

function looksLikeAppData(value: unknown): value is AppData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppData>;
  return Boolean(candidate.site && Array.isArray(candidate.rooms) &&
    Array.isArray(candidate.channels) && Array.isArray(candidate.switches) &&
    Array.isArray(candidate.scenes) && Array.isArray(candidate.periods) &&
    Array.isArray(candidate.users) && Array.isArray(candidate.assignments));
}

export default function FlexiDimWeb() {
  const [workspace, setWorkspace] = useState<FlexiDimWorkspace>(() =>
    canonicalizeAppData(initialData),
  );
  const data = materializeAppData(workspace);
  const setData = (
    update: AppData | ((previous: AppData) => AppData),
  ) =>
    setWorkspace((previousWorkspace) => {
      const previous = materializeAppData(previousWorkspace);
      const next =
        typeof update === "function" ? update(previous) : update;
      return canonicalizeAppData(next);
    });
  const [tab, setTab] = useState<Tab>("Sites");
  const [selectedScene, setSelectedScene] = useState(2);
  const [selectedRoom, setSelectedRoom] = useState(1);
  const [selectedSwitch, setSelectedSwitch] = useState(1);
  const [areaMenuParent, setAreaMenuParent] = useState<number | null>(null);
  const [sceneGroupId, setSceneGroupId] = useState<number | null>(null);
  const [showDeletedScenes, setShowDeletedScenes] = useState(false);
  const [editingSceneGroupId, setEditingSceneGroupId] = useState<number | null>(null);
  const [selectedSceneChannelId, setSelectedSceneChannelId] = useState<number | null>(null);
  const [showSceneChannelPicker, setShowSceneChannelPicker] = useState(false);
  const [previewSceneChanges, setPreviewSceneChanges] = useState(false);
  const [sceneRulePanel, setSceneRulePanel] = useState<"rules" | "periods" | "flags">("rules");
  const [showSceneUtilities, setShowSceneUtilities] = useState(false);
  const [sceneButtonFloor, setSceneButtonFloor] = useState<number | null>(null);
  const [sceneButtonRoom, setSceneButtonRoom] = useState<number | null>(null);
  const [selectedButton, setSelectedButton] = useState(1);
  const [buttonPressMode, setButtonPressMode] = useState<ButtonPressMode>("none");
  // The logical button (2P-1 / 2P) whose scene is being chosen, and the scene
  // group the hierarchical picker is currently browsing (null = top level).
  const [scenePickerButton, setScenePickerButton] = useState<number | null>(null);
  const [scenePickerGroupId, setScenePickerGroupId] = useState<number | null>(
    null,
  );
  const [basicFloor, setBasicFloor] = useState<number | null>(null);
  const [basicRoom, setBasicRoom] = useState<number | null>(null);
  const [basicSwitchId, setBasicSwitchId] = useState<number | null>(null);
  const [basicChannelId, setBasicChannelId] = useState<number | null>(null);
  const [showBasicChannelPicker, setShowBasicChannelPicker] = useState(false);
  const [orderingBasicChannels, setOrderingBasicChannels] = useState(false);
  const [equipmentSection, setEquipmentSection] =
    useState<EquipmentSection>("areas");
  const [equipmentSelection, setEquipmentSelection] =
    useState<EquipmentSelection>(null);
  const [connection, setConnection] = useState<
    "offline" | "bridge" | "connecting" | "connected" | "error"
  >("offline");
  const [bridgeProfile, setBridgeProfile] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [comparisonState, setComparisonState] = useState<string | null>(null);
  const [comparisonMatch, setComparisonMatch] = useState<{
    localChecksum: string;
    controllerChecksum: string;
    version: string;
  } | null>(null);
  const [transferPreflight, setTransferPreflight] =
    useState<TransferPreflight | null>(null);
  const [transferProgress, setTransferProgress] =
    useState<TransferProgress | null>(null);
  const [transferDialog, setTransferDialog] = useState<
    "closed" | "warning" | "running" | "result"
  >("closed");
  const [transferResult, setTransferResult] =
    useState<TransferResult | null>(null);
  const [liveWritesEnabled, setLiveWritesEnabled] = useState(false);
  const [transferStopped, setTransferStopped] = useState(false);
  const [trace, setTrace] = useState<TraceItem[]>([
    { at: "—", text: "FlexiDim Web ready" },
  ]);
  const [installer, setInstaller] = useState(false);
  const [allowEquipment, setAllowEquipment] = useState(false);
  const [toasts, setToasts] = useState<
    { id: number; text: string; tone?: "ok" | "warn" }[]
  >([]);
  const toastId = useRef(0);
  const connectionRef = useRef(connection);
  const socket = useRef<WebSocket | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const serverReady = useRef(false);
  // Whether edits are actually reaching server storage. A transient toast is not
  // enough: if storage is unavailable the app keeps accepting edits that are
  // never persisted, so the state has to stay on screen.
  const [storageState, setStorageState] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const serverRevision = useRef(0);
  const lastSyncedWorkspace = useRef("");
  const pendingWorkspace = useRef<FlexiDimWorkspace | null>(null);
  const workspaceSaveInFlight = useRef(false);
  const workspaceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [dstYearRule, setDstYearRule] = useState<DstYearRule | null>(null);
  const addTrace = (text: string, tone?: "ok" | "warn") =>
    setTrace((items) => [{ at: now(), text, tone }, ...items].slice(0, 150));
  const showToast = (text: string, tone?: "ok" | "warn") => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list, { id, text, tone }]);
    window.setTimeout(
      () => setToasts((list) => list.filter((toast) => toast.id !== id)),
      4000,
    );
  };
  const dismissToast = (id: number) =>
    setToasts((list) => list.filter((toast) => toast.id !== id));
  // Record to the trace log and surface a toast for the same event.
  const notify = (text: string, tone?: "ok" | "warn") => {
    addTrace(text, tone);
    showToast(text, tone);
  };

  useEffect(() => {
    let active = true;
    let migrationWorkspace = workspace;
    let legacyBrowserWorkspace: FlexiDimWorkspace | undefined;
    const saved = localStorage.getItem("flexidim-web-data");
    if (saved)
      try {
        const stored = JSON.parse(saved);
        const value = stored?.format === "FlexiDim Web Local Data" ? stored.data : stored;
        const restored = isFlexiDimWorkspace(value)
          ? value
          : looksLikeAppData(value)
            ? canonicalizeAppData(restoreAreaHierarchy(value))
            : undefined;
        if (!restored) throw new Error("Invalid saved configuration");
        migrationWorkspace = restored;
        legacyBrowserWorkspace = restored;
      } catch {
        /* Ignore an invalid legacy browser copy and retain safe defaults. */
      }

    const loadWorkspace = async () => {
      try {
        const response = await fetch("/api/workspace", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(`Server returned ${response.status}`);
        const payload = await response.json();
        let authoritative = migrationWorkspace;
        let revision = Number(payload.revision) || 0;
        if (payload.workspace != null) {
          if (!isFlexiDimWorkspace(payload.workspace))
            throw new Error("The server returned an invalid workspace");
          const storedWorkspace = payload.workspace;
          authoritative = migrateWorkspaceImportedUserAccess(
            migrateWorkspaceChannelProfileOrder(
              migrateWorkspaceControllerCode(storedWorkspace),
            ),
          );
          if (legacyBrowserWorkspace) {
            authoritative = mergeLegacyBrowserConnectionState(
              authoritative,
              legacyBrowserWorkspace,
            );
          }
          if (
            stringifyConfiguration(authoritative) !==
            stringifyConfiguration(storedWorkspace)
          ) {
            const migrationResponse = await fetch("/api/workspace", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: stringifyConfiguration({
                workspace: authoritative,
                expectedRevision: revision,
              }),
            });
            const migrated = await migrationResponse.json();
            if (!migrationResponse.ok)
              throw new Error(
                migrated.error ??
                  "Could not migrate retained configuration metadata",
              );
            revision = Number(migrated.revision);
          }
        } else {
          const createResponse = await fetch("/api/workspace", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: stringifyConfiguration({
              workspace: migrationWorkspace,
              expectedRevision: 0,
            }),
          });
          const created = await createResponse.json();
          if (!createResponse.ok)
            throw new Error(created.error ?? "Could not create the server workspace");
          revision = Number(created.revision);
        }
        if (!active) return;
        serverRevision.current = revision;
        lastSyncedWorkspace.current = stringifyConfiguration(authoritative);
        setWorkspace(authoritative);
        serverReady.current = true;
        setStorageState("ready");
        setStorageLoaded(true);
        localStorage.removeItem("flexidim-web-data");
        if (payload.workspace != null)
          showToast("Configuration loaded from the server", "ok");
      } catch (error) {
        if (!active) return;
        setStorageState("unavailable");
        notify(
          `Server storage unavailable: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
          "warn",
        );
      }
    };
    void loadWorkspace();
    navigator.serviceWorker
      ?.register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => undefined);
    return () => {
      active = false;
      socket.current?.close();
    };
    // The initial workspace is intentionally captured once as a migration
    // candidate for installations upgrading from browser-only storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Confirm storage is reachable right now.
   *
   * `serverReady` is set once at startup and never falsifies on its own, so it
   * cannot be trusted to report success: killing the server after load left it
   * true, and an import reported success while the save that followed failed.
   */
  const storageReachable = async () => {
    try {
      const response = await fetch("/api/workspace", {
        method: "GET",
        cache: "no-store",
      });
      const ok = response.ok;
      setStorageState(ok ? "ready" : "unavailable");
      if (!ok) serverReady.current = false;
      return ok;
    } catch {
      setStorageState("unavailable");
      serverReady.current = false;
      return false;
    }
  };

  const flushWorkspaceToServer = async () => {
    if (workspaceSaveInFlight.current) return;
    // Storage was never reachable, so a save cannot even be attempted. Bailing
    // out silently here is what let an import report success while persisting
    // nothing.
    if (!serverReady.current) {
      setStorageState("unavailable");
      return;
    }
    const next = pendingWorkspace.current;
    if (!next) return;
    pendingWorkspace.current = null;
    const serialized = stringifyConfiguration(next);
    if (serialized === lastSyncedWorkspace.current) return;
    workspaceSaveInFlight.current = true;
    try {
      const response = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: stringifyConfiguration({
          workspace: next,
          expectedRevision: serverRevision.current,
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Another browser changed this configuration; reload before saving again"
            : (payload.error ?? `Server returned ${response.status}`),
        );
      serverRevision.current = Number(payload.revision);
      lastSyncedWorkspace.current = serialized;
      setStorageState("ready");
    } catch (error) {
      setStorageState("unavailable");
      notify(
        `Configuration not saved: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        "warn",
      );
    } finally {
      workspaceSaveInFlight.current = false;
      if (pendingWorkspace.current) void flushWorkspaceToServer();
    }
  };

  useEffect(() => {
    if (
      stringifyConfiguration(workspace) === lastSyncedWorkspace.current
    )
      return;
    // An edit was made. If storage is down, say so rather than dropping it.
    if (!serverReady.current) {
      setStorageState("unavailable");
      return;
    }
    pendingWorkspace.current = workspace;
    if (workspaceSaveTimer.current)
      window.clearTimeout(workspaceSaveTimer.current);
    workspaceSaveTimer.current = window.setTimeout(
      () => void flushWorkspaceToServer(),
      500,
    );
    return () => {
      if (workspaceSaveTimer.current)
        window.clearTimeout(workspaceSaveTimer.current);
    };
    // flushWorkspaceToServer deliberately reads the latest refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    let active = true;
    loadDstRuleSet(data.site.dst)
      .then((set) => {
        if (!active) return;
        const year = new Date().getUTCFullYear();
        setDstYearRule(set.rules.find((rule) => rule.year === year) ?? null);
      })
      .catch(() => active && setDstYearRule(null));
    return () => { active = false; };
  }, [data.site.dst]);

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const roomName = (id: number) =>
    data.rooms.find((room) => room.id === id)?.name ?? "Unassigned";
  const rootAreas = data.rooms.filter(
    (room) =>
      !room.parentId ||
      !data.rooms.some((candidate) => candidate.id === room.parentId),
  );
  const activeAreaId = data.rooms.some((room) => room.id === selectedRoom)
    ? selectedRoom
    : (rootAreas[0]?.id ?? 0);
  const areaDescendants = (id: number): number[] => {
    const children = data.rooms.filter((room) => room.parentId === id);
    return [id, ...children.flatMap((room) => areaDescendants(room.id))];
  };
  const scopedAreaIds = new Set(areaDescendants(activeAreaId));
  const scopedSwitches = data.switches.filter((item) =>
    scopedAreaIds.has(item.roomId),
  );
  const equipmentModules: FlexModule[] = data.modules?.length
    ? data.modules
    : [
        ...new Set(
          data.channels
            .map((channel) => {
              const match = channel.module.match(/Module\s+(\d+)/i);
              return channel.moduleId ?? (match ? Number(match[1]) : undefined);
            })
            .filter((id): id is number => id !== undefined),
        ),
      ].map((id) => ({
        id,
        name: `Module ${id}`,
        bus: "A",
        enabled: true,
        pending: false,
      }));
  const currentScene = data.scenes.find((scene) => scene.id === selectedScene);
  // Which wall switches run this scene, so an installer can see what a change
  // affects before making it.
  const sceneAffectedSwitches = currentScene
    ? switchesAffectedByScene(data, currentScene.id)
    : [];
  const sceneUnknownFlagBits = currentScene
    ? unknownSceneFlagBits(currentScene)
    : 0;
  const sceneGroups = data.sceneGroups ?? [];
  const currentSceneGroup = sceneGroups.find((group) => group.id === sceneGroupId);
  const editingSceneGroup = sceneGroups.find((group) => group.id === editingSceneGroupId);
  const visibleSceneGroups = (showDeletedScenes ? [] : sceneGroups)
    .filter((group) => group.parentId === sceneGroupId)
    .sort((a, b) => a.displayRank - b.displayRank);
  const visibleScenes = showDeletedScenes
    ? []
    : data.scenes.filter((scene) => scene.groupId === sceneGroupId);
  const assignedScene = (switchId: number, button: number) => {
    const id = data.assignments.find(
      (a) => a.switchId === switchId && a.button === button,
    )?.sceneId;
    return data.scenes.find((scene) => scene.id === id);
  };
  const buttonAssignment = (switchId: number, button: number) =>
    data.assignments.find(
      (assignment) =>
        assignment.switchId === switchId && assignment.button === button,
    );

  const send = (payload: object) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(payload));
    else addTrace("Command not sent — local bridge is offline", "warn");
  };

  /**
   * Open the bridge session and ask it for a controller connection.
   *
   * `auto` is the attempt the page makes for itself once the saved
   * configuration has loaded. It is deliberately quieter than a pressed
   * Connect: an unconfigured or misconfigured site is a normal state on a
   * fresh install, so it is traced rather than toasted, does not throw the
   * user onto the Sites tab, and leaves the status pill offline instead of
   * showing a failure nobody asked for.
   */
  const connect = ({ auto = false }: { auto?: boolean } = {}) => {
    /** Report a reason not to connect, unless this was the page's own attempt. */
    const refuse = (message: string, markFailed = true) => {
      if (auto) {
        addTrace(`Automatic connection skipped — ${message}`);
        // A refusal after the optimistic "connecting" state must not leave the
        // pill spinning on a session that was never opened.
        setConnection((state) => (state === "connecting" ? "offline" : state));
        return;
      }
      if (markFailed) setConnection("error");
      notify(message, "warn");
    };
    if (!storageLoaded) {
      refuse(
        "The saved configuration is still loading; try Connect again in a moment",
        false,
      );
      return;
    }
    if (!validControllerSecurityCode(data.site.securityCode)) {
      if (!auto) setTab("Sites");
      refuse("Enter the controller's 16-character ASCII security code in Sites → Network & Remote before connecting");
      return;
    }
    let controllerRequest;
    try {
      controllerRequest = controllerConnectionRequest(data.site);
    } catch (error) {
      refuse(
        error instanceof Error ? error.message : "Invalid controller connection settings",
      );
      return;
    }
    socket.current?.close();
    setConnection("connecting");
    const attempt =
      controllerRequest.type === "discover"
        ? `Searching the local network for a Scene Controller on port ${controllerRequest.port}…`
        : `Connecting to the Scene Controller at ${controllerRequest.host}:${controllerRequest.port}…`;
    if (auto) addTrace(attempt);
    else notify(attempt);
    let bridgeUrl: URL;
    try {
      const configuredBridgeUrl = (data.site.bridgeUrl || "").trim();
      const useServerBridge =
        !configuredBridgeUrl ||
        configuredBridgeUrl === "/bridge" ||
        configuredBridgeUrl === "ws://127.0.0.1:8765";
      bridgeUrl = useServerBridge
        ? new URL("/bridge", window.location.href)
        : new URL(configuredBridgeUrl);
      if (bridgeUrl.protocol === "http:") bridgeUrl.protocol = "ws:";
      if (bridgeUrl.protocol === "https:") bridgeUrl.protocol = "wss:";
      if (!/^wss?:$/.test(bridgeUrl.protocol)) throw new Error();
    } catch {
      refuse("Enter a valid ws:// or wss:// bridge address");
      return;
    }
    if (data.site.bridgeToken) bridgeUrl.searchParams.set("token", data.site.bridgeToken);
    const ws = new WebSocket(bridgeUrl);
    socket.current = ws;
    ws.onopen = () => {
      setConnection("bridge");
      ws.send(JSON.stringify(controllerRequest));
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "status") {
          setConnection(
            message.state === "connected"
              ? "connected"
              : message.state === "connecting" ||
                  message.state === "discovering"
                ? "connecting"
                : message.state === "bridge"
                  ? "bridge"
                  : "error",
          );
          const tone =
            message.state === "connected"
              ? ("ok" as const)
              : message.state === "error"
                ? ("warn" as const)
                : undefined;
          addTrace(message.message, tone);
          if (message.state === "connected")
            showToast("Connected to the Scene Controller", "ok");
          else if (message.state === "error")
            showToast(message.message, "warn");
        } else if (message.type === "discovered") {
          updateSite({ ip: message.host, port: Number(message.port) });
          addTrace(
            `Controller discovered at ${message.host}:${message.port}`,
            "ok",
          );
        } else if (message.type === "channelStatus" && message.levels) {
          const levels = message.levels as Record<string, number>;
          // Remember which controller addresses have actually reported. This is
          // the one stored-vs-controller comparison available without the
          // unverified block-read frames.
          for (const key of Object.keys(levels)) {
            const address = Number(key);
            if (!Number.isInteger(address)) continue;
            reportedAddresses.current.add(address);
            reportedLevels.current.set(address, Number(levels[key]));
          }
          setData((old) => ({
            ...old,
            channels: old.channels.map((channel) => {
              const level = levels[String(channel.controllerChannel ?? channel.id)];
              return Number.isFinite(level) && level !== channel.level
                ? { ...channel, level }
                : channel;
            }),
          }));
        } else if (message.type === "capabilities") {
          setBridgeProfile(message.profile ?? null);
          addTrace(`Controller profile: ${message.profile?.id ?? "unknown"}`);
        } else if (message.type === "verifyResult") {
          setComparisonState(message.message ?? "Comparison finished");
          setComparisonMatch(
            message.state === "match"
              ? {
                  localChecksum: String(message.localChecksum || "").toLowerCase(),
                  controllerChecksum: String(
                    message.controllerChecksum || "",
                  ).toLowerCase(),
                  version: String(message.version || ""),
                }
              : null,
          );
          // Toast the outcome too — the inline state sits in a panel of similar
          // sentences, so on its own it is not visible feedback.
          notify(
            message.state === "match"
              ? "Configuration matches the Scene Controller"
              : message.state === "unavailable"
                ? "Controller comparison is not available"
                : "Configuration differs from the Scene Controller",
            message.state === "match" ? "ok" : "warn",
          );
        } else if (message.type === "transferPreflight") {
          setTransferPreflight(message as TransferPreflight);
          setTransferProgress(null);
          setLiveWritesEnabled(Boolean(message.liveWritesEnabled));
          notify(
            message.message ?? "Offline transfer dry run finished",
            message.state === "passed" ? "ok" : "warn",
          );
        } else if (message.type === "transferProgress") {
          setTransferProgress(message as TransferProgress);
          addTrace(message.message ?? `Transfer state: ${message.state}`);
        } else if (message.type === "transferResult") {
          const result = message as TransferResult;
          setTransferResult(result);
          setTransferDialog("result");
          setTransferProgress(null);
          notify(
            result.message,
            result.state === "completed" ? "ok" : "warn",
          );
        } else if (message.type === "transferSafetyStatus") {
          setTransferStopped(Boolean(message.emergencyStopped));
          setLiveWritesEnabled(Boolean(message.liveWritesEnabled));
        } else if (message.type === "trace") addTrace(message.message);
      } catch {
        addTrace(String(event.data));
      }
    };
    ws.onerror = () => {
      setConnection("error");
      const message = "The connection to the local bridge was lost";
      // The status pill already reads "Connection failed"; an unprompted
      // attempt should not also throw a toast at someone who has just opened
      // the page.
      if (auto) addTrace(message, "warn");
      else notify(message, "warn");
    };
    ws.onclose = () => {
      if (
        connectionRef.current === "connected" ||
        connectionRef.current === "bridge"
      )
        showToast("Disconnected from the Scene Controller", "warn");
      setConnection((state) => (state === "error" ? state : "offline"));
    };
  };


  // A range slider fires onChange on every pixel of a drag. Transmitting a
  // packet per tick floods the Scene Controller, which drops the connection, so
  // live dim commands are throttled: send the first change immediately, then
  // coalesce rapid follow-ups and always transmit the final resting value.
  const DIM_THROTTLE_MS = 120;
  const dimThrottle = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: { id: number; level: number } | null;
  }>({ timer: null, pending: null });
  const lastSceneRun = useRef<number | null>(null);
  const reportedAddresses = useRef(new Set<number>());
  // The last level the controller reported per address, so the comparison can
  // show controller-side state and not just which addresses exist.
  const reportedLevels = useRef(new Map<number, number>());
  const sceneStateFlags = useRef(new Set<number>());

  // The Scene Controller addresses a channel by the byte computed at import
  // (stored module position * 8 + channel index), not the logical channel id.
  const controllerChannelFor = (id: number) =>
    data.channels.find((channel) => channel.id === id)?.controllerChannel ?? id;
  const controllerSwitchFor = (wallSwitch: WallSwitch) =>
    wallSwitch.number ?? wallSwitch.id;

  const transmitDim = (id: number, level: number) => {
    const state = dimThrottle.current;
    state.pending = { id, level };
    // A cycle is already running; the latest value is kept in `pending` and
    // goes out on the next tick (trailing edge).
    if (state.timer) return;
    const flush = () => {
      if (!state.pending) {
        state.timer = null; // idle for a full interval — stop the cycle
        return;
      }
      const { id: pendingId, level: pendingLevel } = state.pending;
      state.pending = null;
      // Live preview transmits an instant change (transition 0). A non-zero
      // fade starts a transition on every slider tick, and the Scene Controller
      // drops the connection when new dims arrive mid-fade on the same channel.
      send({
        type: "dim",
        channel: controllerChannelFor(pendingId),
        level: pendingLevel,
        transition: 0,
      });
      addTrace(`Channel ${pendingId} set to ${pendingLevel}%`);
      state.timer = setTimeout(flush, DIM_THROTTLE_MS);
    };
    flush(); // leading edge: send immediately, then rate-limit follow-ups
  };

  const setChannelLevel = (id: number, level: number, transmit = true) => {
    setData((old) => ({
      ...old,
      channels: old.channels.map((channel) =>
        channel.id === id ? { ...channel, level } : channel,
      ),
    }));
    if (transmit) transmitDim(id, level);
  };

  const periodIsActive = (periodId?: number) => {
    if (!periodId) return true;
    const period = data.periods.find((item) => item.id === periodId);
    if (!period || !period.enabled) return false;
    const now = new Date();
    const weekday = dayNames[(now.getDay() + 6) % 7];
    if (period.days.length && !period.days.includes(weekday)) return false;
    const parseMinutes = (value: string) => {
      const [hours, minutes] = value.split(":").map(Number);
      return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
    };
    const latitude = Number(data.site.latitude);
    const longitude = Number(data.site.longitude);
    const sun = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? solarTimes(now, latitude, longitude)
      : { sunrise: undefined, sunset: undefined };
    const eventMinutes = (mode: number, value: string) => {
      if (mode === 4) return parseMinutes(value);
      const event = mode < 2 ? sun.sunrise : sun.sunset;
      if (!event) return parseMinutes(value);
      const base = event.getHours() * 60 + event.getMinutes();
      return base + (mode === 0 || mode === 2 ? -parseMinutes(value) : parseMinutes(value));
    };
    const current = now.getHours() * 60 + now.getMinutes();
    const start = eventMinutes(period.startMode ?? 4, period.start);
    const end = eventMinutes(period.endMode ?? 4, period.end);
    return start <= end ? current >= start && current < end : current >= start || current < end;
  };

  const runScene = (scene: Scene | undefined, visited = new Set<number>()) => {
    if (!scene || visited.has(scene.id)) return;
    if (scene.previousSceneId && lastSceneRun.current !== scene.previousSceneId) {
      addTrace(`${scene.name} not run — previous-scene rule was not satisfied`, "warn");
      return;
    }
    const firstPeriod = periodIsActive(scene.period1);
    const firstPass = scene.period1Mode === "not-during" ? !firstPeriod : firstPeriod;
    const secondPass = periodIsActive(scene.period2);
    const periodsPass = scene.period1Mode === "always" || !scene.period1
      ? true
      : scene.period2Mode === "and" ? firstPass && secondPass
        : scene.period2Mode === "or" ? firstPass || secondPass : firstPass;
    if (!periodsPass) {
      addTrace(`${scene.name} not run — period rule was not satisfied`, "warn");
      return;
    }
    const flag = scene.stateFlag ?? 0;
    if (scene.stateFlagAction === "require-set" && !sceneStateFlags.current.has(flag)) return;
    if (scene.stateFlagAction === "require-clear" && sceneStateFlags.current.has(flag)) return;
    const chain = new Set(visited).add(scene.id);
    const extender = data.scenes.find((item) => item.id === scene.extenderSceneId);
    if (scene.runExtenderFirst && extender) runScene(extender, chain);
    Object.entries(scene.levels).forEach(([channelIdText, storedLevel]) => {
      const channelId = Number(channelIdText);
      const channel = data.channels.find((item) => item.id === channelId);
      if (!channel) return;
      const settings = scene.channelSettings?.[channelId];
      const target = Math.max(0, Math.min(100, settings?.relativePercent
        ? Math.round(channel.level * (settings.brightness / 100))
        : storedLevel));
      const distance = Math.abs(target - channel.level);
      const seconds = settings?.fadeTime ?? 0;
      const effectiveSeconds = settings?.use100PercentTime ? seconds * distance / 100 : seconds;
      const command = () => {
        setChannelLevel(channelId, target, false);
        send({
          type: "dim",
          channel: controllerChannelFor(channelId),
          level: target,
          transition: Math.max(0, Math.round(effectiveSeconds * 2)),
        });
      };
      const delayMs = Math.max(0, (settings?.delay ?? 0) * 1000);
      if (delayMs) window.setTimeout(command, delayMs);
      else command();
    });
    addTrace(`Scene “${scene.name}” run`, "ok");
    lastSceneRun.current = scene.id;
    if (scene.stateFlagAction === "set") sceneStateFlags.current.add(flag);
    if (scene.stateFlagAction === "clear") sceneStateFlags.current.delete(flag);
    if (!scene.runExtenderFirst && extender) runScene(extender, chain);
    const next = data.scenes.find((item) => item.id === scene.nextSceneId);
    if (next && scene.nextSceneMode === 0) {
      const delayMs = Math.max(0, (scene.nextSceneTime ?? 0) * 2000);
      window.setTimeout(() => runScene(next, scene.beginNewSequence ? new Set() : chain), delayMs);
      addTrace(`${scene.name}: “${next.name}” scheduled in ${delayMs / 1000}s`);
    }
  };

  const pressSwitch = (wallSwitch: WallSwitch, button: number) => {
    const controllerButton = rawControllerButton(wallSwitch.buttons, button);
    send({
      type: "switch",
      switch: controllerSwitchFor(wallSwitch),
      button: controllerButton,
    });
    addTrace(`${wallSwitch.name}: physical button ${controllerButton} sent using the controller's installed configuration`);
  };

  const updateSite = (patch: Partial<Site>) =>
    setData((old) => {
      const updated = { ...old.site, ...patch };
      // The iOS app never stores the site type: it derives it from the fifth
      // character of the site ID. Editing the ID therefore re-derives it so the
      // model can never disagree with the ID an exported archive carries.
      if (patch.id !== undefined) updated.siteType = siteTypeFromSiteId(updated.id);
      const sites = (old.sites?.length ? old.sites : [old.site]).map((site) =>
        site.id === old.site.id ? updated : site,
      );
      const configurations = patch.id && patch.id !== old.site.id
        ? (old.configurations ?? []).map((config) =>
            config.siteId === old.site.id ? { ...config, siteId: patch.id! } : config)
        : old.configurations;
      return { ...old, site: updated, sites, configurations };
    });

  /**
   * Try to reach the Scene Controller as soon as the page has its saved site.
   *
   * The controller address, port and security code all come from storage, so
   * this cannot run before the workspace has loaded. It is attempted once per
   * page load: after that, reconnecting is the Connect button's job, and a
   * silent retry loop would keep re-opening a session the user may have closed
   * on purpose.
   *
   * It sits below `connect` and everything `connect` reaches — notably
   * `updateSite`, which a discovery reply calls — because a hook may not run
   * ahead of the declarations it depends on.
   */
  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (!storageLoaded || autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;
    connect({ auto: true });
    // Only the first load matters, and `connect` reads current state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageLoaded]);

  /**
   * Resolves a controller action against the profile the bridge announced. Before
   * a bridge connects there is no profile, so the safe local one is assumed —
   * which is also the only one any real controller has offered so far.
   */
  const capability = (messageType: string) =>
    controllerActionState(messageType, bridgeProfile);

  const compareWithController = () => {
    const compiled = compileConfig(data);
    if (!compiled.complete) {
      notify(
        "This configuration cannot be compared because its controller image is incomplete.",
        "warn",
      );
      return;
    }
    const localChecksum = formatChecksum(compiled.checksum);
    setComparisonState(
      `Current local configuration CRC: ${localChecksum}. Waiting for the Scene Controller…`,
    );
    send({ type: "verify", localChecksum });
  };

  const runTransferDryRun = () => {
    const compiled = compileConfig(data);
    const users = compileUserProfiles(data);
    if (!compiled.complete || !users.complete) {
      const details = [
        ...(compiled.complete ? [] : ["The controller image is incomplete."]),
        ...users.problems,
      ];
      const message = `Offline dry run blocked: ${details.join(" ")}`;
      setTransferPreflight({ state: "failed", message, liveWritesEnabled: false });
      notify(message, "warn");
      return;
    }
    setTransferProgress("Compiling and replaying the complete transfer offline…");
    send({
      type: "transferDryRun",
      imageBase64: bytesToBase64(compiled.image),
      imageChecksum: formatChecksum(compiled.checksum),
      userPayloadsBase64: users.payloads.map(bytesToBase64),
      clock: transferClock(),
      siteType: data.site.siteType ?? 0,
      firmwareProfile: "type-0-live-only",
    });
  };

  const beginLiveTransfer = () => {
    const compiled = compileConfig(data);
    const users = compileUserProfiles(data);
    if (!compiled.complete || !users.complete) {
      notify("The configuration is not complete enough to send.", "warn");
      return;
    }
    const imageChecksum = formatChecksum(compiled.checksum).toLowerCase();
    if (
      transferPreflight?.state !== "passed" ||
      transferPreflight.imageChecksum?.toLowerCase() !== imageChecksum
    ) {
      notify(
        "Run the offline transfer dry run for this exact configuration first.",
        "warn",
      );
      return;
    }
    setTransferResult(null);
    setTransferProgress({
      state: "starting",
      message: "Connecting to Scene Controller",
    });
    setTransferDialog("running");
    send({
      type: "sync",
      confirm: "Continue",
      imageBase64: bytesToBase64(compiled.image),
      imageChecksum,
      userPayloadsBase64: users.payloads.map(bytesToBase64),
      clock: transferClock(),
      siteType: data.site.siteType ?? 0,
      firmwareProfile: "type-0-live-only",
    });
  };



  /**
   * The archive always carries four gateway address slots and four count
   * slots, so the editor writes into a fixed-length array rather than
   * appending — a sparse edit must not shift the remaining slots.
   */
  const updateGateway = (
    index: number,
    patch: Partial<{ address: string; count: number }>,
  ) =>
    setData((old) => {
      const gateways = Array.from({ length: 4 }, (_, slot) => ({
        address: old.site.wirelessGateways?.[slot]?.address ?? "",
        count: old.site.wirelessGateways?.[slot]?.count ?? 0,
      }));
      gateways[index] = { ...gateways[index], ...patch };
      const site = { ...old.site, wirelessGateways: gateways };
      const sites = (old.sites?.length ? old.sites : [old.site]).map((item) =>
        item.id === old.site.id ? site : item,
      );
      return { ...old, site, sites };
    });

  const selectSite = (site: Site) => {
    socket.current?.close();
    setConnection("offline");
    setData((old) => {
      if (site.id === old.site.id) return old;
      const outgoing = snapshotContent(old);
      const configurations = (old.configurations ?? []).map((config) =>
        config.id === old.activeConfigId ? { ...config, content: outgoing } : config);
      const target = configurations.find((config) => config.siteId === site.id);
      const content = target?.content ?? emptyConfigContent();
      return {
        ...old, ...content, site, configurations,
        activeConfigId: target?.id,
      };
    });
  };

  const createSite = () => {
    const name = window.prompt("Site name");
    if (!name?.trim()) return;
    const sites = data.sites?.length ? data.sites : [data.site];
    const nextNumber = sites.length + 1;
    const site: Site = {
      name: name.trim(),
      id: `FD4-${String(nextNumber).padStart(4, "0")}`,
      ip: "",
      port: 15273,
      routerPort: 15273,
      description: "FlexiDim lighting system",
      address: "",
      contact: "",
      email: "",
      phone: "",
      latitude: "",
      longitude: "",
      timezone: data.site.timezone || "Europe/London",
      dst: data.site.dst || "UK / Europe",
      remote: false,
      remoteServer: "",
      securityCode: "",
      autoDetect: true,
      addressLines: ["", "", "", ""],
      siteType: 0,
      routerInbound: false,
      wirelessGateways: [],
      bridgeUrl: data.site.bridgeUrl ?? "/bridge",
      bridgeToken: "",
    };
    setData((old) => {
      const configs = old.configurations ?? [];
      const newConfigId = Math.max(0, ...configs.map((c) => c.id)) + 1;
      const config: Configuration = {
        id: newConfigId,
        siteId: site.id,
        name: `${site.name} configuration`,
        description: site.description,
        lastUpdated: new Date().toISOString(),
      };
      const outgoing = snapshotContent(old);
      const configurations = configs.map((item) =>
        item.id === old.activeConfigId ? { ...item, content: outgoing } : item);
      return {
        ...old, ...emptyConfigContent(),
        site,
        sites: [...sites, site],
        configurations: [...configurations, config],
        activeConfigId: newConfigId,
      };
    });
    setConnection("offline");
    notify(`Site “${site.name}” created`, "ok");
  };

  const deleteSite = (siteId: string) => {
    const site = (data.sites?.length ? data.sites : [data.site]).find(
      (candidate) => candidate.id === siteId,
    );
    if (!site || !window.confirm(`Delete site “${site.name}” and all of its configurations?`)) return;
    socket.current?.close();
    setConnection("offline");
    setData((old) => {
      const allSites = old.sites?.length ? old.sites : [old.site];
      if (allSites.length <= 1) return old;
      const sites = allSites.filter((candidate) => candidate.id !== siteId);
      const outgoing = snapshotContent(old);
      const configurations = (old.configurations ?? [])
        .map((configuration) =>
          configuration.id === old.activeConfigId
            ? { ...configuration, content: outgoing }
            : configuration,
        )
        .filter((configuration) => configuration.siteId !== siteId);
      if (old.site.id !== siteId) return { ...old, sites, configurations };
      const nextSite = sites[0];
      const nextConfiguration = configurations.find(
        (configuration) => configuration.siteId === nextSite.id,
      );
      const content = nextConfiguration?.content ?? emptyConfigContent();
      return {
        ...old,
        ...content,
        site: nextSite,
        sites,
        activeConfigId: nextConfiguration?.id,
        configurations: configurations.map((configuration) =>
          configuration.id === nextConfiguration?.id
            ? { ...configuration, content: undefined }
            : configuration,
        ),
      };
    });
    notify(`Site “${site.name}” deleted`, "ok");
  };

  const setChangesAllowed = (allowed: boolean) => {
    setInstaller(allowed);
    addTrace(
      allowed ? "Configuration changes enabled" : "Configuration changes disabled",
      allowed ? "ok" : undefined,
    );
  };

  const setEquipmentAllowed = (allowed: boolean) => {
    if (allowed) {
      const code = window.prompt("Enter the installer equipment-change code");
      if (code !== "FLEXIDIM") {
        notify("Equipment changes remain locked", "warn");
        return;
      }
    }
    setAllowEquipment(allowed);
    addTrace(
      allowed ? "Equipment changes enabled" : "Equipment changes disabled",
      allowed ? "ok" : "warn",
    );
  };

  // The editable model of the active configuration lives at the top level of
  // `data`; other configurations keep their own snapshot in `content`.
  const snapshotContent = (source: AppData): ConfigContent =>
    Object.fromEntries(
      CONFIG_CONTENT_KEYS.map((key) => [key, source[key] ?? []]),
    ) as unknown as ConfigContent;

  const updateConfiguration = (id: number, patch: Partial<Configuration>) =>
    setData((old) => ({
      ...old,
      configurations: (old.configurations ?? []).map((config) =>
        config.id === id
          ? { ...config, ...patch, lastUpdated: new Date().toISOString() }
          : config,
      ),
    }));

  const selectConfiguration = (id: number) =>
    setData((old) => {
      if (id === old.activeConfigId) return old;
      const configs = old.configurations ?? [];
      const target = configs.find((config) => config.id === id);
      if (!target) return old;
      const outgoing = snapshotContent(old);
      const content = target.content ?? outgoing;
      return {
        ...old,
        ...content,
        activeConfigId: id,
        configurations: configs.map((config) =>
          config.id === old.activeConfigId
            ? { ...config, content: outgoing }
            : config.id === id
              ? { ...config, content: undefined }
              : config,
        ),
      };
    });

  const duplicateConfiguration = (id: number) => {
    const source = (data.configurations ?? []).find(
      (config) => config.id === id,
    );
    setData((old) => {
      const configs = old.configurations ?? [];
      const original = configs.find((config) => config.id === id);
      if (!original) return old;
      const newId = Math.max(0, ...configs.map((config) => config.id)) + 1;
      const sourceContent =
        original.id === old.activeConfigId
          ? snapshotContent(old)
          : original.content;
      const copy: Configuration = {
        id: newId,
        siteId: original.siteId,
        name: `${original.name} copy`,
        description: original.description,
        lastUpdated: new Date().toISOString(),
        content: sourceContent
          ? structuredClone(sourceContent)
          : snapshotContent(old),
      };
      return { ...old, configurations: [...configs, copy] };
    });
    if (source) notify(`Duplicated configuration “${source.name}”`, "ok");
  };

  const deleteConfiguration = (id: number) =>
    setData((old) => {
      const configs = old.configurations ?? [];
      const target = configs.find((config) => config.id === id);
      if (
        !target ||
        configs.filter((config) => config.siteId === target.siteId).length <= 1
      )
        return old;
      const remaining = configs.filter((config) => config.id !== id);
      if (id !== old.activeConfigId)
        return { ...old, configurations: remaining };
      const next =
        remaining.find((config) => config.siteId === target.siteId) ??
        remaining[0];
      const content = next.content ?? snapshotContent(old);
      return {
        ...old,
        ...content,
        activeConfigId: next.id,
        configurations: remaining.map((config) =>
          config.id === next.id ? { ...config, content: undefined } : config,
        ),
      };
    });

  const addFloor = () => {
    if (!allowEquipment) return;
    const name = window.prompt("Floor name");
    if (!name?.trim()) return;
    const id = newId(data.rooms);
    setData((old) => ({
      ...old,
      rooms: [
        ...old.rooms,
        {
          id,
          name: name.trim(),
          floor: "FlexiDim",
          icon: roomIcons[id % roomIcons.length],
          parentId: null,
        },
      ],
    }));
    setAreaMenuParent(null);
    setSelectedRoom(id);
    setEquipmentSelection({ type: "area", id });
    addTrace(`Floor “${name.trim()}” added`, "ok");
  };

  const addModule = () => {
    if (!allowEquipment) return;
    const rawId = window.prompt("Module ID", String(newId(equipmentModules)));
    if (rawId === null) return;
    const id = Number(rawId);
    if (!Number.isFinite(id) || equipmentModules.some((item) => item.id === id)) {
      window.alert("Enter a unique numeric Module ID.");
      return;
    }
    const flexModule: FlexModule = {
      id,
      name: `Module ${id}`,
      bus: "A",
      enabled: true,
      pending: true,
      position: equipmentModules.length,
    };
    setData((old) => ({
      ...old,
      modules: [...(old.modules ?? equipmentModules), flexModule],
    }));
    setEquipmentSection("modules");
    setEquipmentSelection({ type: "module", id });
  };

  const updateRoom = (id: number, patch: Partial<Room>) => {
    if (patch.parentId != null) {
      const roomById = new Map(data.rooms.map((room) => [room.id, room]));
      const visited = new Set([id]);
      let parentId: number | null | undefined = patch.parentId;
      while (parentId != null) {
        if (visited.has(parentId)) {
          window.alert("An area cannot be moved beneath one of its descendants.");
          return;
        }
        visited.add(parentId);
        parentId = roomById.get(parentId)?.parentId;
      }
    }
    setData((old) => ({
      ...old,
      rooms: old.rooms.map((room) =>
        room.id === id ? { ...room, ...patch } : room,
      ),
    }));
  };
  const updateChannel = (id: number, patch: Partial<Channel>) =>
    setData((old) => {
      const modules = [...(old.modules ?? equipmentModules)].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const channels = old.channels.map((channel) => {
        const updated = channel.id === id ? { ...channel, ...patch } : channel;
        const position = modules.findIndex((module) => module.id === updated.moduleId);
        const channelIndex = updated.channelIndex ?? updated.moduleIndex;
        return channelIndex != null
          ? { ...updated, moduleIndex: channelIndex, channelIndex, controllerChannel: controllerChannelAddress(position, channelIndex) }
          : updated;
      });
      return { ...old, channels };
    });
  const updateSwitch = (id: number, patch: Partial<WallSwitch>) =>
    setData((old) => ({
      ...old,
      switches: old.switches.map((wallSwitch) =>
        wallSwitch.id === id ? { ...wallSwitch, ...patch } : wallSwitch,
      ),
    }));
  const updateModule = (id: number, patch: Partial<FlexModule>) =>
    setData((old) => {
      const modules = (old.modules ?? equipmentModules).map((module) =>
        module.id === id ? { ...module, ...patch } : module,
      );
      const ordered = [...modules].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const channels = old.channels.map((channel) => {
        const position = ordered.findIndex((module) => module.id === channel.moduleId);
        const channelIndex = channel.channelIndex ?? channel.moduleIndex;
        return channelIndex != null
          ? { ...channel, controllerChannel: controllerChannelAddress(position, channelIndex) }
          : channel;
      });
      return { ...old, modules, channels };
    });
  const moveModule = (id: number, position: number) => {
    const ordered = [...equipmentModules].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const current = ordered.findIndex((module) => module.id === id);
    if (current < 0) return;
    const [module] = ordered.splice(current, 1);
    ordered.splice(Math.max(0, Math.min(position, ordered.length)), 0, module);
    setData((old) => {
      const modules = ordered.map((item, index) => ({ ...item, position: index, pending: true }));
      const channels = old.channels.map((channel) => {
        const modulePosition = modules.findIndex((item) => item.id === channel.moduleId);
        const channelIndex = channel.channelIndex ?? channel.moduleIndex;
        return channelIndex != null ? { ...channel, controllerChannel: controllerChannelAddress(modulePosition, channelIndex) } : channel;
      });
      return { ...old, modules, channels };
    });
  };

  /**
   * The recovery key is minted from the existing list rather than from a clock:
   * it only has to be unique within `deletedItems`, and deriving it keeps this
   * path pure so a delete can never depend on when it happened.
   */
  const moveToDeleted = (
    type: DeletedItem["type"],
    item: DeletedItem["item"],
  ) => {
    if (!allowEquipment) return;
    if (type === "area" && (
      data.rooms.some((room) => room.parentId === item.id) ||
      data.channels.some((channel) => channel.roomId === item.id) ||
      data.switches.some((wallSwitch) => wallSwitch.roomId === item.id)
    )) {
      window.alert("Move the child rooms, channels and switches before deleting this area.");
      return;
    }
    if (type === "module" && data.channels.some((channel) => channel.moduleId === item.id)) {
      window.alert("Move this module's channels before deleting it.");
      return;
    }
    setData((old) => {
      const entityType = {
        area: "room",
        light: "channel",
        switch: "switch",
        module: "module",
      } as const;
      const content = deleteConfigEntity(
        snapshotContent(old),
        entityType[type],
        item.id,
      );
      const taken = new Set(content.deletedItems.map((entry) => entry.key));
      let key = `${type}-${item.id}`;
      for (let attempt = 2; taken.has(key); attempt += 1)
        key = `${type}-${item.id}-${attempt}`;
      const deleted = { key, type, item } as DeletedItem;
      return {
        ...old,
        ...content,
        deletedItems: [...content.deletedItems, deleted],
      };
    });
    setEquipmentSelection(null);
    addTrace(`${item.name} moved to Deleted items`);
  };

  const restoreDeleted = (deleted: DeletedItem) => {
    if (!allowEquipment) return;
    setData((old) => ({
      ...old,
      rooms:
        deleted.type === "area" ? [...old.rooms, deleted.item] : old.rooms,
      switches:
        deleted.type === "switch"
          ? [...old.switches, deleted.item]
          : old.switches,
      channels:
        deleted.type === "light"
          ? [...old.channels, deleted.item]
          : old.channels,
      modules:
        deleted.type === "module"
          ? [...(old.modules ?? equipmentModules), deleted.item]
          : old.modules,
      deletedItems: (old.deletedItems ?? []).filter(
        (item) => item.key !== deleted.key,
      ),
    }));
    addTrace(`${deleted.item.name} restored`, "ok");
  };

  const createBasicAssignments = () => {
    if (
      !window.confirm(
        "For every switch currently without basic assignments, automatically assign all channels in a room to that switch?",
      )
    )
      return;
    const switches = data.switches.filter(
      (wallSwitch) =>
        !wallSwitch.basic?.channelIds.length &&
        data.channels.some((channel) => channel.roomId === wallSwitch.roomId),
    );
    setData((old) => ({
      ...old,
      switches: old.switches.map((wallSwitch) =>
        switches.some((candidate) => candidate.id === wallSwitch.id)
          ? {
              ...wallSwitch,
              basic: {
                channelIds: old.channels
                  .filter((channel) => channel.roomId === wallSwitch.roomId)
                  .map((channel) => channel.id),
                assignOn: true,
                assignOff: true,
                assignDimming: true,
                assignChannelDimming: false,
                onTime: 0,
                offTime: 0,
                offPriority: 0,
                onPriority: false,
                channelSettings: {},
              },
            }
          : wallSwitch,
      ),
    }));
    addTrace(
      switches.length
        ? `Basic assignments created for ${switches.length} switches`
        : "No unassigned switches needed basic assignments",
      switches.length ? "ok" : undefined,
    );
  };

  /**
   * Runs one of the recovered scene-creation utilities. The generated shape
   * lives in `scene-utilities.ts` so it can be asserted directly; this only
   * handles the prompt and merging the result into the workspace.
   */
  const createSceneUtility = (utility: SceneUtility, label: string) => {
    // The original app offers the button prompt after EVERY utility, not just
    // Simple Scenes.
    const assignToButtons = window.confirm(UTILITY_BUTTON_PROMPT);
    let firstSceneId: number | undefined;
    setData((old) => {
      const result = generateSceneUtility(utility, old, { assignToButtons });
      firstSceneId = result.scenes[0]?.id;
      return {
        ...old,
        scenes: [...old.scenes, ...result.scenes],
        sceneGroups: [...old.sceneGroups, ...result.sceneGroups],
        assignments: [...old.assignments, ...result.assignments],
      };
    });
    if (firstSceneId !== undefined) setSelectedScene(firstSceneId);
    setEditingSceneGroupId(null);
    setShowSceneUtilities(false);
    addTrace(`${label} created`, "ok");
  };

  const restoreDeletedScene = (scene: Scene) => {
    setData((old) => ({
      ...old,
      scenes: [
        ...old.scenes,
        { ...scene, group: "Scenes", groupId: undefined, folderPath: ["Scenes"] },
      ],
      deletedScenes: (old.deletedScenes ?? []).filter((item) => item.id !== scene.id),
    }));
    addTrace(`${scene.name} restored to Scenes`, "ok");
  };

  const permanentlyDeleteScene = (scene: Scene) => {
    setData((old) => ({
      ...old,
      deletedScenes: (old.deletedScenes ?? []).filter((item) => item.id !== scene.id),
    }));
    addTrace(`${scene.name} permanently deleted`, "warn");
  };

  const moveSceneToDeleted = (scene: Scene) => {
    setData((old) => {
      const content = deleteConfigEntity(snapshotContent(old), "scene", scene.id);
      return {
        ...old,
        ...content,
        deletedScenes: [...content.deletedScenes, scene],
      };
    });
    setSelectedScene(0);
    notify(`${scene.name} moved to Deleted scenes`, "warn");
  };

  // Each logical button holds a single scene. On the plate two consecutive
  // logical buttons make up the first-press / second-press of one physical
  // button, but each is stored as its own assignment.
  const setButtonScene = (
    wallSwitch: WallSwitch,
    button: number,
    sceneId: number,
  ) => {
    setData((old) => {
      const assignments = old.assignments.filter(
        (assignment) =>
          !(
            assignment.switchId === wallSwitch.id &&
            assignment.button === button
          ),
      );
      if (sceneId) assignments.push({ switchId: wallSwitch.id, button, sceneId });
      return { ...old, assignments };
    });
  };

  // Simulate a physical button press from the Scene-to-Button plate. The
  // "When button pressed" mode decides what (if anything) reaches the
  // controller: nothing, the raw button press (controller uses its own stored
  // config), or the live effect from the current app config (run the scene).
  const pressSceneButton = (
    wallSwitch: WallSwitch,
    press: "first" | "second",
    button: number,
    physicalPosition: number,
  ) => {
    if (buttonPressMode === "none") return;
    const scene = data.scenes.find(
      (item) => item.id === buttonAssignment(wallSwitch.id, button)?.sceneId,
    );
    if (buttonPressMode === "live" && scene) {
      runScene(scene);
      return;
    }
    const builtIn = specialButtonDefault(
      wallSwitch.buttons,
      physicalPosition,
    );
    if (
      buttonPressMode === "live" &&
      !scene &&
      builtIn?.name === "Default on/off"
    ) {
      const commands = defaultOnOffCommands(wallSwitch, data.channels);
      if (!commands.length) {
        addTrace(`${wallSwitch.name}: Default on/off has no Basic Assignment channels`, "warn");
        return;
      }
      for (const command of commands) {
        send({
          type: "dim",
          channel: controllerChannelFor(command.id),
          level: command.level,
          transition: command.transition,
        });
      }
      setData((old) => ({
        ...old,
        channels: old.channels.map((channel) => {
          const command = commands.find((candidate) => candidate.id === channel.id);
          return command ? { ...channel, level: command.level } : channel;
        }),
      }));
      addTrace(
        `${wallSwitch.name}: Default on/off → ${commands[0].level ? "on" : "off"} (${commands.length} channels)`,
        "ok",
      );
      return;
    }
    // "latest settings", or "live" with no assigned scene: transmit the raw
    // physical switch button for the controller to interpret. Logical scene
    // slots (2P-1/2P) are not valid switch-command button addresses.
    const controllerButton = rawControllerButton(
      wallSwitch.buttons,
      physicalPosition,
    );
    send({
      type: "switch",
      switch: controllerSwitchFor(wallSwitch),
      button: controllerButton,
    });
    addTrace(
      `${wallSwitch.name}: ${press} press of button ${controllerButton} sent (${
        buttonPressMode === "live" ? "live system" : "latest settings"
      })`,
    );
  };

  const updateSwitchBasic = (
    switchId: number,
    patch: Partial<NonNullable<WallSwitch["basic"]>>,
  ) =>
    setData((old) => ({
      ...old,
      switches: old.switches.map((wallSwitch) =>
        wallSwitch.id === switchId
          ? {
              ...wallSwitch,
              basic: {
                channelIds: [],
                assignOn: false,
                assignOff: false,
                assignDimming: false,
                assignChannelDimming: false,
                onTime: 0,
                offTime: 0,
                offPriority: 0,
                onPriority: false,
                channelSettings: {},
                ...wallSwitch.basic,
                ...patch,
              },
            }
          : wallSwitch,
      ),
    }));

  const updateBasicChannelSettings = (
    switchId: number,
    channelId: number,
    patch: Partial<
      NonNullable<
        NonNullable<WallSwitch["basic"]>["channelSettings"]
      >[number]
    >,
  ) =>
    setData((old) => ({
      ...old,
      switches: old.switches.map((wallSwitch) => {
        if (wallSwitch.id !== switchId) return wallSwitch;
        const basic = wallSwitch.basic ?? {
          channelIds: [],
          assignOn: false,
          assignOff: false,
          assignDimming: false,
          assignChannelDimming: false,
          onTime: 0,
          offTime: 0,
          offPriority: 0,
          onPriority: false,
          channelSettings: {},
        };
        const current = basic.channelSettings?.[channelId] ?? {
          assignOn: basic.assignOn,
          assignOff: basic.assignOff ?? false,
          assignDimming: basic.assignDimming,
          assignChannelDimming: basic.assignChannelDimming,
          onPriority: basic.onPriority ?? false,
          offPriority: Boolean(basic.offPriority),
          onFade: basic.onTime,
          offFade: basic.offTime,
        };
        return {
          ...wallSwitch,
          basic: {
            ...basic,
            channelSettings: {
              ...basic.channelSettings,
              [channelId]: { ...current, ...patch },
            },
          },
        };
      }),
    }));

  // Edits route through editScene so a locked scene stays read-only everywhere,
  // rather than each control having to remember to check the lock.
  const updateScene = (sceneId: number, patch: Partial<Scene>) =>
    setData((old) => ({
      ...old,
      scenes: old.scenes.map((scene) =>
        scene.id === sceneId ? editScene(scene, patch) : scene,
      ),
    }));

  const reorderScene = (sceneId: number, direction: -1 | 1) =>
    setData((old) => ({ ...old, scenes: moveScene(old.scenes, sceneId, direction) }));

  const reorderSceneGroup = (groupId: number, direction: -1 | 1) =>
    setData((old) => ({
      ...old,
      sceneGroups: moveSceneGroup(old.sceneGroups ?? [], groupId, direction),
    }));

  const updateSceneGroup = (groupId: number, patch: Partial<SceneGroup>) =>
    setData((old) => ({
      ...old,
      sceneGroups: (old.sceneGroups ?? []).map((group) =>
        group.id === groupId ? { ...group, ...patch } : group,
      ),
    }));

  const updateSceneChannel = (
    sceneId: number,
    channelId: number,
    patch: Partial<SceneChannelSettings>,
  ) =>
    setData((old) => ({
      ...old,
      scenes: old.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        const brightness = scene.levels[channelId] ?? 100;
        const current = scene.channelSettings?.[channelId] ?? {
          brightness,
          fadeTime: scene.fade,
          relativePercent: false,
          use100PercentTime: false,
          delay: 0,
          flags: 0,
        };
        let flags = patch.flags ?? current.flags;
        if (patch.relativePercent !== undefined)
          flags = patch.relativePercent ? flags | 0x80 : flags & ~0x80;
        if (patch.use100PercentTime !== undefined)
          flags = patch.use100PercentTime ? flags | 0x10 : flags & ~0x10;
        const updated = { ...current, ...patch, flags };
        return {
          ...scene,
          levels: { ...scene.levels, [channelId]: updated.brightness },
          channelSettings: {
            ...scene.channelSettings,
            [channelId]: updated,
          },
        };
      }),
    }));

  const exportConfig = () => {
    const blob = new Blob(
      [
        stringifyConfiguration(
          {
            format: "FlexiDim Web Configuration",
            version: 2,
            exportedAt: new Date().toISOString(),
            data: workspace,
          },
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.site.name.replace(/\s+/g, "-").toLowerCase()}.fd4web.json`;
    link.click();
    URL.revokeObjectURL(url);
    addTrace("Configuration exported", "ok");
  };
  const exportLegacyConfig = () => {
    try {
      const bytes = buildLegacyArchive(data);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${data.site.name.replace(/\s+/g, "-").toLowerCase()}.fd4cfg`;
      link.click();
      URL.revokeObjectURL(url);
      addTrace("iOS .fd4cfg configuration exported", "ok");
    } catch (error) {
      notify(
        `Configuration not exported: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
    }
  };
  const exportHardwareCsv = () => {
    const rows = [
      ["Type", "Name", "Room", "Controller number", "Module", "Channel", "Hardware type"],
      ...data.switches.map((item) => ["Switch", item.name, roomName(item.roomId), item.number ?? item.id, "", "", item.hardwareType ?? item.type ?? ""]),
      ...data.channels.map((item) => ["Channel", item.name, roomName(item.roomId), item.controllerChannel ?? "", item.moduleId ?? "", item.channelIndex ?? item.moduleIndex ?? "", item.hardwareType ?? item.kind]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.site.name.replace(/\s+/g, "-").toLowerCase()}-hardware.csv`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Hardware CSV exported", "ok");
  };
  const exportUserKeys = () => {
    const payload = {
      format: "FlexiDim Web User Keys",
      version: 1,
      exportedAt: new Date().toISOString(),
      siteId: data.site.id,
      users: data.users.map((user) => ({
        id: user.id,
        name: user.name,
        securityCode: user.securityCode ?? user.key,
        profileVersion: user.profileVersion ?? 0,
        profileData: user.profileData ?? buildUserProfileData(user),
      })),
    };
    const url = URL.createObjectURL(
      new Blob([stringifyConfiguration(payload, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.site.name.replace(/\s+/g, "-").toLowerCase()}-user-keys.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("User security keys exported", "ok");
  };

  const flashChannel = (channel: Channel) => {
    const original = channel.level;
    setChannelLevel(channel.id, original >= 50 ? 0 : 100);
    window.setTimeout(() => setChannelLevel(channel.id, original), 800);
  };

  const importConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reportImportEvent = (
      status: "started" | "succeeded" | "failed",
      details: Record<string, unknown> = {},
    ) => {
      void fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "configuration-import",
          status,
          fileName: file.name,
          fileSize: file.size,
          ...details,
        }),
      }).catch(() => undefined);
    };
    // Server storage is the ONLY persistence — the browser copy is a one-time
    // migration candidate that is deleted after the first successful load. So an
    // import with no reachable server cannot be completed, and applying it to
    // in-memory state would leave the UI showing a configuration that vanishes
    // on reload. Refuse before touching any state.
    if (!(await storageReachable())) {
      notify(
        `Cannot import ${file.name}: server storage is unavailable, so there is nowhere to save the configuration. Restore the server and try again.`,
        "warn",
      );
      event.target.value = "";
      return;
    }
    reportImportEvent("started");
    try {
      let imported: AppData;
      const legacyFile = /\.fd4(cfg|xlt)$/i.test(file.name);
      if (legacyFile)
        imported = parseLegacyFd4Config(await file.arrayBuffer());
      else {
        const parsed = JSON.parse(await file.text());
        const value = parsed.data ?? parsed;
        if (isFlexiDimWorkspace(value)) {
          for (const site of value.sites) {
            for (const configuration of site.configurations) {
              const issues = validateConfigContent(configuration.content);
              if (issues.length) {
                throw new Error(
                  `Configuration contains invalid references: ${issues[0]}`,
                );
              }
            }
          }
          imported = materializeAppData(value);
        } else {
          if (!looksLikeAppData(value))
            throw new Error("Invalid web configuration");
          imported = value;
        }
        imported = restoreAreaHierarchy(imported);
      }
      imported = restoreAreaHierarchy(imported);
      const integrityIssues = validateConfigContent(snapshotContent(imported));
      if (integrityIssues.length) {
        throw new Error(
          `Configuration contains invalid references: ${integrityIssues[0]}`,
        );
      }
      if (legacyFile) {
        const sites = data.sites?.length ? data.sites : [data.site];
        const sameId = sites.find((site) => site.id === imported.site.id);
        const sameName = sites.find((site) => site.name.toLocaleLowerCase() === imported.site.name.toLocaleLowerCase());
        let targetSite = imported.site;
        if (sameId) {
          if (siteImportDetailsEqual(sameId, imported.site)) {
            targetSite = mergeImportedSite(sameId, imported.site, true);
          } else {
            const importedDate = new Date(imported.site.updatedAt ?? 0).getTime();
            const currentDate = new Date(sameId.updatedAt ?? 0).getTime();
            const freshness = importedDate && currentDate
              ? importedDate > currentDate
                ? "The imported site details are newer."
                : currentDate > importedDate
                  ? "The saved site details are newer."
                  : "The timestamps match, but the site details differ."
              : "The imported and saved site details differ.";
            // Name the fields that differ. "Details differ" alone gives an
            // installer no way to tell a stale backup from a corrected one.
            const differences = siteImportDifferences(sameId, imported.site);
            const detail = differences.length
              ? ` Differences: ${differences.join(", ")}.`
              : "";
            const useImported = window.confirm(
              `A site with ID ${sameId.id} already exists. ${freshness}${detail} The controller address in use is kept either way. The matching configuration will be refreshed rather than duplicated. Use the imported site details too?`,
            );
            targetSite = mergeImportedSite(sameId, imported.site, useImported);
          }
        } else if (sameName) {
          window.alert("The imported site has an existing name but a different Site ID, so a new site will be created.");
        }
        setData((old) => {
          const outgoing = snapshotContent(old);
          const importedConfig = imported.configurations?.[0];
          const configurationName = importedConfig?.name ?? `${targetSite.name} import`;
          const existingSites = old.sites?.length ? old.sites : [old.site];
          const starterSiteIds = new Set(
            existingSites
              .filter((site) => site.id !== targetSite.id && isStarterSite(site, old.configurations ?? []))
              .map((site) => site.id),
          );
          let configurations = (old.configurations ?? [])
            .map((config) =>
              config.id === old.activeConfigId ? { ...config, content: outgoing } : config)
            .filter((config) => !starterSiteIds.has(config.siteId));
          const configuration: Configuration = {
            id: 0,
            siteId: targetSite.id,
            name: configurationName,
            description: importedConfig?.description ?? `Imported from ${file.name}`,
            lastUpdated: importedConfig?.lastUpdated ?? new Date().toISOString(),
          };
          const upserted = upsertImportedConfiguration(
            configurations,
            configuration,
            old.activeConfigId,
          );
          configurations = upserted.configurations;
          const configurationId = upserted.configurationId;
          const retainedSites = existingSites.filter((site) => !starterSiteIds.has(site.id));
          const nextSites = retainedSites.some((site) => site.id === targetSite.id)
            ? retainedSites.map((site) => site.id === targetSite.id ? targetSite : site)
            : [...retainedSites, targetSite];
          return {
            ...old,
            ...snapshotContent(imported),
            site: targetSite,
            sites: nextSites,
            configurations,
            activeConfigId: configurationId,
          };
        });
      } else {
        if (!looksLikeAppData(imported)) throw new Error("Invalid web configuration");
        setData(imported);
      }
      setSelectedRoom(
        imported.rooms.find((room) => room.parentId)?.id ??
          imported.rooms[0]?.id ??
          0,
      );
      setSelectedScene(imported.scenes[0]?.id ?? 0);
      setAreaMenuParent(null);
      setSceneGroupId(null);
      setEditingSceneGroupId(null);
      setSelectedSceneChannelId(null);
      setBasicFloor(null);
      setBasicRoom(null);
      setBasicSwitchId(null);
      setBasicChannelId(null);
      setSceneButtonFloor(null);
      setSceneButtonRoom(null);
      setEquipmentSection("areas");
      setEquipmentSelection(null);
      reportImportEvent("succeeded", {
        rooms: imported.rooms.length,
        channels: imported.channels.length,
        switches: imported.switches.length,
        scenes: imported.scenes.length,
        periods: imported.periods.length,
        users: imported.users.length,
      });
      // Storage was confirmed reachable before any state was touched, and the
      // debounced save reports its own failure if the server dies mid-write.
      notify(`Imported configuration from ${file.name}`, "ok");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown configuration import error";
      reportImportEvent("failed", { message });
      notify(`Configuration import failed: ${message}`, "warn");
    }
    event.target.value = "";
  };

  const addChannel = () => {
    if (!allowEquipment) return;
    const name = window.prompt("Channel name");
    if (!name?.trim()) return;
    const id = newId(data.channels);
    const moduleId = equipmentModules[0]?.id;
    const channelIndex = Array.from({ length: 8 }, (_, index) => index + 1)
      .find((candidate) => !data.channels.some((channel) => channel.moduleId === moduleId && (channel.channelIndex ?? channel.moduleIndex) === candidate)) ?? 1;
    const modulePosition = equipmentModules.findIndex((module) => module.id === moduleId);
    setData((old) => ({
      ...old,
      channels: [
        ...old.channels,
        {
          id,
          name: name.trim(),
          roomId: selectedRoom,
          module: `Module ${moduleId ?? 1} / Ch${channelIndex}`,
          kind: "Dimmable",
          level: 0,
          moduleId,
          moduleIndex: channelIndex,
          channelIndex,
          controllerChannel: controllerChannelAddress(modulePosition, channelIndex),
          accessoryModule: "None",
          minimum: 0,
          maximum: 100,
          defaultLevel: 100,
        },
      ],
    }));
    setEquipmentSelection({ type: "light", id });
  };
  const addSwitch = () => {
    if (!allowEquipment) return;
    const name = window.prompt("Switch name");
    if (!name?.trim()) return;
    const id = newId(data.switches);
    setData((old) => ({
      ...old,
      switches: [
        ...old.switches,
        {
          id,
          name: name.trim(),
          roomId: selectedRoom,
          kind: "4 scene",
          type: switchTypeByName("4 scene").code,
          buttons: switchTypeByName("4 scene").buttons,
        },
      ],
    }));
    setSelectedSwitch(id);
    setEquipmentSelection({ type: "switch", id });
  };
  const connectionLabel =
    !storageLoaded
      ? "Loading…"
      : connection === "connected"
      ? "Connected"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "bridge"
          ? "Bridge ready"
          : connection === "error"
            ? "Connection failed"
            : "Offline";

  const availableSites = data.sites?.length ? data.sites : [data.site];

  const allConfigurations = data.configurations ?? [];
  const siteConfigurations = allConfigurations.filter(
    (config) => config.siteId === data.site.id,
  );
  const activeConfiguration =
    allConfigurations.find((config) => config.id === data.activeConfigId) ??
    siteConfigurations[0];
  const formatLastUpdated = (iso: string) => {
    if (!iso) return "—";
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? iso
      : parsed.toLocaleDateString("en-GB", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  };
  const latitudeValue = Number(data.site.latitude);
  const longitudeValue = Number(data.site.longitude);
  const todaySolar = Number.isFinite(latitudeValue) && Number.isFinite(longitudeValue)
    ? solarTimes(new Date(), latitudeValue, longitudeValue)
    : { sunrise: undefined, sunset: undefined };
  const formatSiteTime = (date?: Date) => date
    ? new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: normalizeSiteTimeZone(data.site.timezone, data.site.dst),
      }).format(date)
    : "—";
  const locateSite = () => {
    if (!navigator.geolocation) return notify("Location is not available in this browser", "warn");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => updateSite({
        latitude: coords.latitude.toFixed(5), longitude: coords.longitude.toFixed(5),
      }),
      (error) => notify(`Location could not be read: ${error.message}`, "warn"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const sitesPanel = (
    <div className="content-grid site-grid">
      <section className="card site-selector">
        <div className="card-title">
          <div>
            <small>SITES</small>
            <h2>My FlexiDim sites</h2>
          </div>
          <button className="primary" disabled={!installer} onClick={createSite}>
            ＋ Create site
          </button>
        </div>
        <div className="site-list">
          {availableSites.map((site) => (
            <button
              key={site.id}
              className={data.site.id === site.id ? "selected" : ""}
              onClick={() => selectSite(site)}
            >
              <img src="/flexidim/sites.png" alt="" />
              <span>
                <b>{site.name}</b>
                <small>{site.id}</small>
                <small>
                  {site.ip ? `${site.ip}:${site.port}` : "Controller not set"}
                </small>
              </span>
              <em>›</em>
            </button>
          ))}
        </div>
      </section>
      <section className="card site-identity">
        <div className="card-title">
          <div>
            <small>ACTIVE SITE</small>
            <h2>{data.site.name}</h2>
          </div>
          <span className={`status-pill ${connection}`}>
            ● {connectionLabel}
          </span>
          {availableSites.length > 1 && (
            <button
              className="delete"
              disabled={!installer}
              onClick={() => deleteSite(data.site.id)}
            >
              Delete site
            </button>
          )}
        </div>
        <div className="site-hero">
          <img src="/flexidim/sites.png" alt="" />
          <div>
            <b>{data.site.description}</b>
            <span>Site ID {data.site.id}</span>
            <span>
              {data.rooms.length} rooms · {data.channels.length} channels ·{" "}
              {data.scenes.length} scenes
            </span>
          </div>
        </div>
        <div className="connect-box">
          <Field label="Scene Controller IP">
            <input
              value={data.site.ip}
              disabled={!storageLoaded}
              onChange={(e) => updateSite({ ip: e.target.value })}
              inputMode="decimal"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              value={data.site.port}
              disabled={!storageLoaded}
              onChange={(e) => updateSite({ port: Number(e.target.value) })}
            />
          </Field>
          <button
            className="primary"
            disabled={!storageLoaded}
            onClick={() => connect()}
          >
            {connection === "connected" ? "Reconnect" : "Connect"}
          </button>
        </div>
        <p className="hint">
          The browser uses the bundled local bridge to reach the Scene
          Controller on your home network.
        </p>
      </section>
      <section className="card form-card">
        <div className="card-title">
          <div>
            <small>SITE DETAILS</small>
            <h2>Identity and contact</h2>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Site name">
            <input
              value={data.site.name}
              disabled={!installer}
              onChange={(e) => updateSite({ name: e.target.value })}
            />
          </Field>
          <Field label="Site ID">
            <input
              value={data.site.id}
              disabled={!installer}
              onChange={(e) => updateSite({ id: e.target.value })}
            />
          </Field>
          {(data.site.addressLines ?? [data.site.address, "", "", ""]).map((line, index) => (
            <Field key={index} label={`Address ${index + 1}`}>
              <input value={line} disabled={!installer} placeholder="Optional" onChange={(event) => {
                const addressLines = [...(data.site.addressLines ?? [data.site.address, "", "", ""] )];
                addressLines[index] = event.target.value;
                updateSite({ addressLines, address: addressLines.filter(Boolean).join(", ") });
              }} />
            </Field>
          ))}
          <Field label="Contact name" help="The person responsible for this site.">
            <input
              value={data.site.contact ?? ""}
              disabled={!installer}
              placeholder="Optional"
              onChange={(e) => updateSite({ contact: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={data.site.email ?? ""}
              disabled={!installer}
              placeholder="Optional"
              onChange={(e) => updateSite({ email: e.target.value })}
            />
          </Field>
          <Field label="Phone number">
            <input
              value={data.site.phone ?? ""}
              disabled={!installer}
              placeholder="Optional"
              onChange={(e) => updateSite({ phone: e.target.value })}
            />
          </Field>
        </div>
      </section>
      <section className="card form-card">
        <div className="card-title">
          <div>
            <small>LOCATION &amp; TIME</small>
            <h2>Location and daylight saving</h2>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="Latitude"
            help="Used with longitude to calculate local sunrise and sunset times."
          >
            <input
              value={data.site.latitude ?? ""}
              disabled={!installer}
              placeholder="e.g. 51.5074"
              inputMode="decimal"
              onChange={(e) => updateSite({ latitude: e.target.value })}
            />
          </Field>
          <Field
            label="Longitude"
            help="Used with latitude to calculate local sunrise and sunset times."
          >
            <input
              value={data.site.longitude ?? ""}
              disabled={!installer}
              placeholder="e.g. -0.1278"
              inputMode="decimal"
              onChange={(e) => updateSite({ longitude: e.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <input
              value={data.site.timezone}
              disabled={!installer}
              onChange={(e) => updateSite({ timezone: e.target.value })}
            />
          </Field>
          <Field label="DST rules" help="The daylight-saving ruleset for this site.">
            <select
              value={data.site.dst}
              disabled={!installer}
              onChange={(e) => updateSite({ dst: e.target.value })}
            >
              <option>UK / Europe</option>
              <option>USA</option>
              <option>No daylight saving</option>
            </select>
          </Field>
        </div>
        <div className="button-row compact site-location-actions">
          <button disabled={!installer} onClick={locateSite}>Use current location</button>
          <span className="version">
            Sunrise {formatSiteTime(todaySolar.sunrise)} · Sunset {formatSiteTime(todaySolar.sunset)}
          </span>
        </div>
        {dstYearRule && (
          <p className="hint">
            {dstYearRule.offsetMinutes
              ? `DST ${isDstActive(dstYearRule, new Date()) ? "active" : "inactive"}; ${formatSiteTime(dstTransition(dstYearRule, "start"))} start and ${formatSiteTime(dstTransition(dstYearRule, "end"))} end for ${dstYearRule.year}.`
              : `No daylight-saving offset for ${dstYearRule.year}.`}
          </p>
        )}
      </section>
      <section className="card form-card">
        <div className="card-title">
          <div>
            <small>NETWORK &amp; REMOTE</small>
            <h2>Ports and remote access</h2>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="Inbound port"
            help="The TCP port the Scene Controller listens on (default 15273)."
          >
            <input
              type="number"
              value={data.site.port}
              disabled={!installer}
              onChange={(e) => updateSite({ port: Number(e.target.value) })}
            />
          </Field>
          <Field label="Local bridge address" help="Use loopback on the bridge computer, or an authenticated wss:// companion address from an iPad.">
            <input value={data.site.bridgeUrl ?? "/bridge"} disabled={!installer} onChange={(event) => updateSite({ bridgeUrl: event.target.value })} />
          </Field>
          <Field label="Bridge pairing token" help="Required when the bridge is intentionally exposed through an authenticated LAN/WSS companion.">
            <input type="password" value={data.site.bridgeToken ?? ""} disabled={!installer} onChange={(event) => updateSite({ bridgeToken: event.target.value })} />
          </Field>
          <Field
            label="Router inbound port"
            help="The port forwarded on the router for remote access, if configured."
          >
            <input
              type="number"
              value={data.site.routerPort ?? data.site.port}
              disabled={!installer || !data.site.routerInbound}
              onChange={(e) => updateSite({ routerPort: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Remote server"
            help="The remote-access server address, if this site uses one."
          >
            <input
              value={data.site.remoteServer ?? ""}
              disabled={!installer}
              placeholder="Optional"
              onChange={(e) => updateSite({ remoteServer: e.target.value })}
            />
          </Field>
          <Field
            label="Controller security code"
            help="Required for every type-0 controller connection. Import it from the site's .fd4cfg file or enter the controller's 16-character ASCII key."
          >
            <input
              type="password"
              value={data.site.securityCode ?? ""}
              disabled={!installer}
              required
              minLength={16}
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
              placeholder="Required — 16 characters"
              aria-invalid={Boolean(data.site.securityCode) && !validControllerSecurityCode(data.site.securityCode)}
              onChange={(e) => updateSite({ securityCode: e.target.value })}
            />
          </Field>
          <Field
            label="Controller site type"
            help="Derived from the fifth character of the site ID, exactly as the original app does; edit the site ID to change it."
          >
            <output className="derived-value" data-testid="derived-site-type">
              {SITE_TYPE_LABELS[siteTypeFromSiteId(data.site.id)] ??
                SITE_TYPE_LABELS[0]}
            </output>
          </Field>
        </div>
        <div className="gateway-editor">
          <h3>Wireless gateways</h3>
          <p className="hint">
            Up to four wireless gateway addresses and their device counts, as
            stored in the site record.
          </p>
          {[0, 1, 2, 3].map((index) => {
            const gateway = data.site.wirelessGateways?.[index];
            return (
              <div className="gateway-row" key={index}>
                <Field label={`Gateway ${index + 1} address`}>
                  <input
                    value={gateway?.address ?? ""}
                    disabled={!installer}
                    placeholder="Not configured"
                    onChange={(event) =>
                      updateGateway(index, { address: event.target.value })
                    }
                  />
                </Field>
                <Field label={`Gateway ${index + 1} count`}>
                  <input
                    type="number"
                    min={0}
                    value={gateway?.count ?? 0}
                    disabled={!installer}
                    onChange={(event) =>
                      updateGateway(index, {
                        count: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                  />
                </Field>
              </div>
            );
          })}
        </div>
        <Toggle label="Router inbound enabled" help="Use the configured router-forwarded port for supported remote access." checked={data.site.routerInbound ?? false} disabled={!installer} onChange={(routerInbound) => updateSite({ routerInbound })} />
        <Toggle
          label="Enable remote access"
          help="Allow this site to be reached over the internet through the remote server."
          checked={data.site.remote}
          disabled={!installer || (data.site.siteType ?? 0) === 0}
          onChange={(remote) => updateSite({ remote })}
        />
        <Toggle
          label="Auto-detect controller"
          help="Broadcast to find the Scene Controller automatically instead of using a fixed address."
          checked={data.site.autoDetect ?? false}
          disabled={!installer}
          onChange={(autoDetect) => updateSite({ autoDetect })}
        />
      </section>
    </div>
  );

  const readiness = transferReadiness(data);
  const currentImageChecksum = formatChecksum(
    compileConfig(data).checksum,
  ).toLowerCase();
  const matchingComparison =
    comparisonMatch?.localChecksum === currentImageChecksum &&
    comparisonMatch?.controllerChecksum === currentImageChecksum &&
    comparisonMatch?.version === "4.0";
  const matchingPreflight =
    transferPreflight?.state === "passed" &&
    transferPreflight.imageChecksum?.toLowerCase() === currentImageChecksum &&
    transferPreflight.runnerQualification?.state === "passed";
  const visibleTransferMessage =
    transferProgress?.message === "This takes about 60 seconds"
      ? "Restarting Scene Controller — this takes about 60 seconds"
      : transferProgress?.message;

  const configPanel = (
    <div className="content-grid config-grid">
      <section className="card config-list-card">
        <div className="card-title">
          <div>
            <small>CONFIGURATIONS</small>
            <h2>{data.site.name}</h2>
          </div>
          <button
            className="config-import"
            onClick={() => fileInput.current?.click()}
          >
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".fd4cfg,.fd4xlt,.fd4web,.json,application/x-plist,application/octet-stream"
            onChange={importConfig}
            hidden
          />
        </div>
        <div className="config-list">
          {siteConfigurations.map((config) => (
            <div
              key={config.id}
              className={`config-row ${config.id === data.activeConfigId ? "active" : ""}`}
            >
              <button
                className="config-select"
                onClick={() => selectConfiguration(config.id)}
              >
                <img src="/flexidim/configurations.png" alt="" />
                <span>
                  <b>{config.name}</b>
                  <small>{config.description || "No description"}</small>
                  <small>
                    Last updated on: {formatLastUpdated(config.lastUpdated)}
                  </small>
                </span>
                {config.id === data.activeConfigId ? (
                  <em className="config-active-tag">Active</em>
                ) : (
                  <em>›</em>
                )}
              </button>
              <div className="config-row-actions">
                <button
                  title={`Duplicate ${config.name}`}
                  disabled={!installer}
                  onClick={() => duplicateConfiguration(config.id)}
                >
                  Duplicate
                </button>
                {siteConfigurations.length > 1 && (
                  <button
                    className="delete"
                    disabled={!installer}
                    title={`Delete ${config.name}`}
                    onClick={() => deleteConfiguration(config.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      {activeConfiguration && (
        <section className="card form-card">
          <div className="card-title">
            <div>
              <small>ACTIVE CONFIGURATION</small>
              <h2>{activeConfiguration.name}</h2>
            </div>
            <span className="version">
              Last updated on: {formatLastUpdated(activeConfiguration.lastUpdated)}
            </span>
          </div>
          <div className="form-grid">
            <Field label="Configuration name">
              <input
                value={activeConfiguration.name}
                disabled={!installer}
                onChange={(e) =>
                  updateConfiguration(activeConfiguration.id, {
                    name: e.target.value,
                  })
                }
              />
            </Field>
            <Field label="Description">
              <input
                value={activeConfiguration.description}
                disabled={!installer}
                placeholder="Optional"
                onChange={(e) =>
                  updateConfiguration(activeConfiguration.id, {
                    description: e.target.value,
                  })
                }
              />
            </Field>
          </div>
          <div className="config-actions">
            {/* The primary download is the SAME format the importer accepts, so
                import and download are a round trip. The JSON export is a
                web-native superset kept as a secondary backup. */}
            <button
              className="primary"
              title="Download this site as a .fd4cfg file — the same format the original app and this importer use."
              onClick={exportLegacyConfig}
            >
              Download configuration
            </button>
            <button
              title="Back up every site, including web-only settings the .fd4cfg format cannot hold."
              onClick={exportConfig}
            >
              Back up all sites (JSON)
            </button>
            <button
              disabled={
                connection !== "connected" || !capability("verify").allowed
              }
              title={
                connection !== "connected"
                  ? "Connect to the Scene Controller first."
                  : capability("verify").reason
              }
              onClick={compareWithController}
            >
              Compare with Scene Controller
            </button>
            <button
              disabled={
                connection === "offline" ||
                connection === "error" ||
                readiness.blockers.length > 0 ||
                transferStopped
              }
              title={
                transferStopped
                  ? "The emergency stop is latched. Restart the bridge before another offline dry run."
                  : readiness.blockers[0] ??
                    "Compile every outgoing byte, replay the recovered sender offline, and self-check every frame. This never writes to the controller."
              }
              onClick={runTransferDryRun}
            >
              Run offline transfer dry run
            </button>
            <button
              disabled={
                !readiness.ready ||
                !capability("sync").allowed ||
                connection !== "connected" ||
                !liveWritesEnabled ||
                !matchingComparison ||
                !matchingPreflight ||
                transferDialog === "running"
              }
              title={
                readiness.blockers[0] ??
                capability("sync").reason ??
                (!matchingComparison
                  ? "Run Compare and confirm that the firmware 4.0 Scene Controller matches this exact configuration."
                  : !matchingPreflight
                    ? "Run the offline transfer dry run for this exact configuration."
                    : !liveWritesEnabled
                      ? "The local bridge has live configuration writes disabled."
                      : readiness.unavailableReason)
              }
              onClick={() => setTransferDialog("warning")}
            >
              Send configuration to Scene Controller
            </button>
          </div>
          <div className="readiness" data-testid="transfer-readiness">
            {/* Only things that change, or that an installer can act on. The
                reason transfer is unavailable is a constant: it lives on the
                disabled button and in the downloaded report, because shown here
                permanently it read as a fault in the user's own data. */}
            <p className="readiness-crc">
              Checksum <code>0x{readiness.localCrc}</code>
              <HelpTip
                label="Checksum"
                help="A short fingerprint of this configuration. It changes whenever the configuration changes, so you can tell two copies apart. It is not the Scene Controller's own checksum."
              />
            </p>
            {comparisonState && (
              <p className="readiness-comparison" data-testid="comparison-state">
                <b>Controller comparison:</b> {comparisonState}
              </p>
            )}
            <div className="transfer-safety" data-testid="transfer-safety">
              <p>
                <b>Live configuration writes:</b>{" "}
                {liveWritesEnabled ? "enabled" : "disabled"}
                {transferStopped ? " — emergency stop latched" : ""}
              </p>
              {visibleTransferMessage && <p>{visibleTransferMessage}</p>}
              {transferPreflight && (
                <>
                  <p>
                    <b>Offline dry run:</b> {transferPreflight.message}
                  </p>
                  {transferPreflight.state === "passed" && (
                    <p>
                      Image CRC <code>0x{transferPreflight.imageChecksum}</code>,
                      {" "}{transferPreflight.imageBytes} bytes in{" "}
                      {transferPreflight.blockCount} blocks;{" "}
                      {transferPreflight.userCount} user payloads totaling{" "}
                      {transferPreflight.userBytes} bytes;{" "}
                      {transferPreflight.frameCount} validated frames.
                    </p>
                  )}
                  {transferPreflight.transcriptSha256 && (
                    <p>
                      Transcript SHA-256{" "}
                      <code>{transferPreflight.transcriptSha256}</code>
                    </p>
                  )}
                  {transferPreflight.runnerQualification?.state === "passed" && (
                    <p>
                      <b>Bridge runner qualification:</b> passed offline,
                      including the original app&apos;s reset/reconnect cycle and{" "}
                      {transferPreflight.runnerQualification.validatedStatusRecords}{" "}
                      validated normal status records. No controller bytes were
                      written.
                    </p>
                  )}
                  {transferPreflight.lifecycle?.length ? (
                    <p>
                      <b>Original-app lifecycle modeled offline:</b>{" "}
                      {transferPreflight.lifecycle
                        .map((message) =>
                          message.startsWith("Downloading block ")
                            ? message.replace(
                                /^Downloading block \d+$/,
                                `Downloading blocks 1–${transferPreflight.blockCount}`,
                              )
                            : message
                        )
                        .filter((message, index, all) =>
                          index === 0 || message !== all[index - 1]
                        )
                        .join(" → ")}
                    </p>
                  ) : null}
                  <p>
                    Live Send requires a successful Compare from this
                    connection within five minutes, bound to this exact image
                    CRC, plus this exact offline dry run.
                  </p>
                </>
              )}
              <p>
                Recovery rule: keep the current <code>.fd4cfg</code> available
                on the iPad. If a future transfer is interrupted, stop and use
                the original app’s restore workflow; do not retry blindly.
              </p>
            </div>
            {readiness.blockers.length > 0 && (
              <div className="readiness-blockers">
                <h4>Fix before transferring</h4>
                <ul>
                  {readiness.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}
            {readiness.warnings.length > 0 && (
              <div className="readiness-warnings">
                <h4>Review before transferring</h4>
                <ul>
                  {readiness.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="warning-copy">
            Hover any button for what it does.
          </p>
        </section>
      )}
      <section
        className={`card installer-card ${allowEquipment ? "enabled" : ""}`}
      >
        <div>
          <small>EQUIPMENT CHANGES</small>
          <h2>
            {allowEquipment
              ? "Equipment changes enabled"
              : "Equipment changes are disabled"}
          </h2>
          <p>
            Editing equipment (floors, rooms, modules, switches and lights) can
            affect proper operation of the FlexiDim system. This is separate from
            the main Allow changes switch, which covers everything else.
          </p>
        </div>
        <Toggle
          label="Allow equipment changes"
          help="Unlock editing of the hardware model: floors, rooms, modules, switches and lights."
          checked={allowEquipment}
          onChange={setEquipmentAllowed}
        />
      </section>
    </div>
  );

  const selectedEquipmentArea =
    equipmentSelection?.type === "area"
      ? data.rooms.find((item) => item.id === equipmentSelection.id)
      : undefined;
  const selectedEquipmentModule =
    equipmentSelection?.type === "module"
      ? equipmentModules.find((item) => item.id === equipmentSelection.id)
      : undefined;
  const selectedEquipmentSwitch =
    equipmentSelection?.type === "switch"
      ? data.switches.find((item) => item.id === equipmentSelection.id)
      : undefined;
  const selectedEquipmentLight =
    equipmentSelection?.type === "light"
      ? data.channels.find((item) => item.id === equipmentSelection.id)
      : undefined;

  // Bus A and bus B are numbered independently, so the module's number comes
  // from its position within its OWN bus, not its position in the merged list.
  const selectedModuleNumber = selectedEquipmentModule
    ? controllerModuleNumber(
        selectedEquipmentModule.bus,
        equipmentModules
          .filter((module) => module.bus === selectedEquipmentModule.bus)
          .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
          .findIndex((module) => module.id === selectedEquipmentModule.id),
      )
    : -1;

  // Which hardware family a module belongs to was not recovered from the iOS
  // binary, so the editor works from the default family and never rewrites an
  // imported hardware code it does not recognise.
  const selectedChannelFamily = channelTypeFamily(
    selectedEquipmentLight?.typeFamily ?? DEFAULT_CHANNEL_TYPE_FAMILY,
  );
  const selectedChannelTypeOption = selectedChannelFamily.options.find(
    (option) => option.hw === selectedEquipmentLight?.hardwareType,
  );
  const selectedChannelLoadClass = selectedChannelTypeOption?.loadClass;

  const equipmentPanel = (
    <div className="master-detail equipment-layout">
      <section className="master card equipment-browser">
        <div className="master-head">
          <div>
            <small>EQUIPMENT</small>
            <h2>Hardware</h2>
          </div>
          {allowEquipment && equipmentSection === "areas" && (
            <button onClick={addFloor} aria-label="Add floor">
              ＋
            </button>
          )}
          {allowEquipment && equipmentSection === "modules" && (
            <button onClick={addModule} aria-label="Add module">
              ＋
            </button>
          )}
        </div>
        <div className="equipment-sections">
          {(
            [
              ["areas", "Floor / areas", data.rooms.length],
              ["modules", "Modules", equipmentModules.length],
              ["switches", "Switch overview", data.switches.length],
              ["deleted", "Deleted items", data.deletedItems?.length ?? 0],
            ] as [EquipmentSection, string, number][]
          ).map(([section, label, count]) => (
            <button
              key={section}
              className={equipmentSection === section ? "selected" : ""}
              onClick={() => {
                setEquipmentSection(section);
                setEquipmentSelection(null);
              }}
            >
              <span>
                <b>{label}</b>
                <small>{count} items</small>
              </span>
              <em>›</em>
            </button>
          ))}
        </div>
        {equipmentSection === "areas" && (
          <div className="area-tier area-drilldown equipment-area-list">
            {(() => {
              const currentArea = areaMenuParent
                ? data.rooms.find((room) => room.id === areaMenuParent)
                : undefined;
              const list = currentArea
                ? data.rooms.filter((room) => room.parentId === currentArea.id)
                : rootAreas;
              return (
                <>
                  {currentArea && (
                    <div className="area-drill-header">
                      <button
                        onClick={() =>
                          setAreaMenuParent(currentArea.parentId ?? null)
                        }
                      >
                        ‹ {currentArea.parentId ? "Back" : "Floors"}
                      </button>
                      <strong>{currentArea.name}</strong>
                    </div>
                  )}
                  {list.map((area) => {
                    const children = data.rooms.filter(
                      (room) => room.parentId === area.id,
                    );
                    return (
                      <div className="scene-nav-row" key={area.id}>
                        <button
                          className={activeAreaId === area.id ? "selected" : ""}
                          onClick={() => {
                            setSelectedRoom(area.id);
                            setEquipmentSelection(null);
                            if (children.length) setAreaMenuParent(area.id);
                          }}
                        >
                          <img src={area.icon} alt="" />
                          <span>
                            <b>{area.name}</b>
                            <small>
                              {children.length
                                ? `${children.length} areas`
                                : `${data.channels.filter((channel) => channel.roomId === area.id).length} lights · ${data.switches.filter((item) => item.roomId === area.id).length} switches`}
                            </small>
                          </span>
                          <em>›</em>
                        </button>
                        <button
                          className="scene-info-button"
                          title={`Edit ${area.name} information`}
                          aria-label={`Edit ${area.name} information`}
                          onClick={() =>
                            setEquipmentSelection({ type: "area", id: area.id })
                          }
                        >
                          i
                        </button>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )}
        {equipmentSection === "modules" && (
          <div className="area-tier equipment-object-list">
            <span>Modules</span>
            {equipmentModules.map((module) => (
              <button
                key={module.id}
                className={
                  equipmentSelection?.type === "module" &&
                  equipmentSelection.id === module.id
                    ? "selected"
                    : ""
                }
                onClick={() =>
                  setEquipmentSelection({ type: "module", id: module.id })
                }
              >
                <img src="/flexidim/equipment.png" alt="" />
                <span>
                  <b>{module.name}</b>
                  <small>
                    Bus {module.bus} ·{" "}
                    {
                      data.channels.filter(
                        (channel) => channel.moduleId === module.id,
                      ).length
                    } channels
                  </small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        )}
        {equipmentSection === "switches" && (
          <div className="area-tier equipment-object-list">
            <span>Switch overview</span>
            {data.switches.map((item) => (
              <button
                key={item.id}
                className={
                  equipmentSelection?.type === "switch" &&
                  equipmentSelection.id === item.id
                    ? "selected"
                    : ""
                }
                onClick={() => {
                  setSelectedSwitch(item.id);
                  setEquipmentSelection({ type: "switch", id: item.id });
                }}
              >
                <img src="/flexidim/switches.png" alt="" />
                <span>
                  <b>{item.name}</b>
                  <small>
                    {roomName(item.roomId)} · No. {item.number ?? item.id} ·{" "}
                    {item.kind}
                  </small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        )}
        {equipmentSection === "deleted" && (
          <div className="area-tier equipment-object-list">
            <span>Deleted items</span>
            {(data.deletedItems ?? []).map((deleted) => (
              <button key={deleted.key} disabled>
                <img src="/flexidim/equipment.png" alt="" />
                <span>
                  <b>{deleted.item.name}</b>
                  <small>{deleted.type}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="detail card equipment-detail">
        {selectedEquipmentArea ? (
          <>
            <div className="card-title">
              <div>
                <small>FLOOR / AREA</small>
                <h2>{selectedEquipmentArea.name}</h2>
              </div>
              {allowEquipment && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted("area", selectedEquipmentArea)
                  }
                >
                  Delete
                </button>
              )}
            </div>
            <div className="equipment-form-grid">
              <Field label="Room name">
                <input
                  value={selectedEquipmentArea.name}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateRoom(selectedEquipmentArea.id, {
                      name: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Names for Remote Control app">
                <input
                  value={selectedEquipmentArea.shortName ?? selectedEquipmentArea.name}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateRoom(selectedEquipmentArea.id, {
                      shortName: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Floor / area">
                <select
                  value={selectedEquipmentArea.areaType ?? "Room"}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateRoom(selectedEquipmentArea.id, {
                      areaType: event.target.value as Room["areaType"],
                    })
                  }
                >
                  <option>Floor</option>
                  <option>Area</option>
                  <option>Room</option>
                </select>
              </Field>
              <Field label="Parent area">
                <select
                  value={selectedEquipmentArea.parentId ?? ""}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateRoom(selectedEquipmentArea.id, {
                      parentId: Number(event.target.value) || null,
                    })
                  }
                >
                  <option value="">Top level</option>
                  {data.rooms
                    .filter((room) => room.id !== selectedEquipmentArea.id)
                    .map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <h3>Room icon</h3>
            <div className="room-icon-picker">
              {areaIconChoices.map((icon) => (
                <button
                  key={icon}
                  className={selectedEquipmentArea.icon === icon ? "selected" : ""}
                  disabled={!allowEquipment}
                  onClick={() =>
                    updateRoom(selectedEquipmentArea.id, { icon })
                  }
                >
                  <img src={icon} alt="" />
                </button>
              ))}
            </div>
          </>
        ) : selectedEquipmentModule ? (
          <>
            <div className="card-title">
              <div>
                <small>MODULE</small>
                <h2>{selectedEquipmentModule.name}</h2>
              </div>
              {allowEquipment && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted("module", selectedEquipmentModule)
                  }
                >
                  Delete
                </button>
              )}
            </div>
            <div className="equipment-form-grid">
              <Field label="Module ID">
                <input value={selectedEquipmentModule.id} disabled />
              </Field>
              <Field label="Name">
                <input
                  value={selectedEquipmentModule.name}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateModule(selectedEquipmentModule.id, {
                      name: event.target.value,
                      pending: true,
                    })
                  }
                />
              </Field>
              <Field label="Bus">
                <select
                  value={selectedEquipmentModule.bus}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateModule(selectedEquipmentModule.id, {
                      bus: event.target.value as "A" | "B",
                      pending: true,
                    })
                  }
                >
                  <option value="A">Bus A</option>
                  <option value="B">Bus B</option>
                </select>
              </Field>
              <Field label="Controller order" help="Module position controls the live channel address; changing it recalculates every affected address.">
                <select value={[...equipmentModules].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).findIndex((module) => module.id === selectedEquipmentModule.id)} disabled={!allowEquipment} onChange={(event) => moveModule(selectedEquipmentModule.id, Number(event.target.value))}>
                  {equipmentModules.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}
                </select>
              </Field>
              <Field
                label="Controller module number"
                help="Bus A numbers from 1; bus B numbers from 16, so a bus can hold at most 15 modules."
              >
                <output className="derived-value" data-testid="module-number">
                  {selectedModuleNumber > 0 ? selectedModuleNumber : "Unassigned"}
                </output>
              </Field>
              <Toggle
                label="Turn on"
                checked={selectedEquipmentModule.enabled}
                disabled={!allowEquipment}
                onChange={(enabled) =>
                  updateModule(selectedEquipmentModule.id, { enabled })
                }
              />
            </div>
            {selectedEquipmentModule.pending && (
              <p className="hint pending-profile" data-testid="module-pending">
                This module has profile changes that have not been sent to the
                Scene Controller.
              </p>
            )}
            <div className="equipment-actions">
              <GatedAction
                state={capability("moduleProfiles")}
                onClick={() => send({ type: "moduleProfiles" })}
              >
                Send module profile
              </GatedAction>
            </div>
            <h3>Channel names</h3>
            <div className="module-channel-list">
              {data.channels
                .filter(
                  (channel) => channel.moduleId === selectedEquipmentModule.id,
                )
                .map((channel) => (
                  <button
                    key={channel.id}
                    onClick={() =>
                      setEquipmentSelection({ type: "light", id: channel.id })
                    }
                  >
                    <span>{channel.id}</span>
                    <b>{channel.name}</b>
                    <em>›</em>
                  </button>
                ))}
            </div>
            <div className="equipment-actions">
              <button onClick={() => data.channels.forEach((channel) => setChannelLevel(channel.id, 100))}>All On</button>
              <button onClick={() => data.channels.forEach((channel) => setChannelLevel(channel.id, 0))}>All Off</button>
              <button onClick={() => send({ type: "moduleProfiles", mode: "pending" })}>Send configuration changes</button>
              <button onClick={() => send({ type: "moduleProfiles", mode: "all" })}>Resend all configuration information</button>
              <button onClick={exportHardwareCsv}>Export configuration details</button>
            </div>
          </>
        ) : selectedEquipmentSwitch ? (
          <>
            <div className="card-title">
              <div>
                <small>SWITCH</small>
                <h2>{selectedEquipmentSwitch.name}</h2>
              </div>
              {allowEquipment && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted("switch", selectedEquipmentSwitch)
                  }
                >
                  Delete
                </button>
              )}
            </div>
            <div className="equipment-editor-split">
              <div className="equipment-form-grid">
                <Field label="Switch name">
                  <input
                    value={selectedEquipmentSwitch.name}
                    disabled={!allowEquipment}
                    onChange={(event) =>
                      updateSwitch(selectedEquipmentSwitch.id, {
                        name: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Switch number">
                  <input
                    type="number"
                    value={selectedEquipmentSwitch.number ?? selectedEquipmentSwitch.id}
                    disabled={!allowEquipment}
                    onChange={(event) =>
                      updateSwitch(selectedEquipmentSwitch.id, {
                        number: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label="Switch type"
                  help="The physical switch face. “Not used” parks the address without deleting the switch."
                >
                  <select
                    value={selectedEquipmentSwitch.type ?? 13}
                    disabled={!allowEquipment}
                    data-testid="switch-type"
                    onChange={(event) => {
                      const entry = switchTypeByCode(Number(event.target.value));
                      if (!entry) return;
                      updateSwitch(selectedEquipmentSwitch.id, {
                        type: entry.code,
                        hardwareType: entry.code,
                        buttons: entry.buttons,
                        kind: entry.name,
                      });
                    }}
                  >
                    {SWITCH_TYPES.map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="LED brightness">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={selectedEquipmentSwitch.ledBrightness ?? 70}
                    disabled={!allowEquipment}
                    onChange={(event) =>
                      updateSwitch(selectedEquipmentSwitch.id, {
                        ledBrightness: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Default brightness">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={selectedEquipmentSwitch.defaultBrightness ?? 100}
                    disabled={!allowEquipment}
                    onChange={(event) =>
                      updateSwitch(selectedEquipmentSwitch.id, {
                        defaultBrightness: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <div className="equipment-switch-picture">
                <img src="/flexidim/switches.png" alt="" />
                <b>{selectedEquipmentSwitch.buttons} button switch</b>
              </div>
            </div>
            <div className="equipment-actions">
              <GatedAction
                state={capability("switchDetect")}
                onClick={() => send({ type: "switchDetect", switch: controllerSwitchFor(selectedEquipmentSwitch) })}
              >
                Detect by button press
              </GatedAction>
              <GatedAction
                state={capability("switchTypeDetect")}
                onClick={() => send({ type: "switchTypeDetect", switch: controllerSwitchFor(selectedEquipmentSwitch) })}
              >
                Detect switch types
              </GatedAction>
              {/* A button press uses the verified raw switch command, so it is
                  not gated: it replays what the controller already has. */}
              <button onClick={() => pressSwitch(selectedEquipmentSwitch, 1)}>Press button 1</button>
            </div>
          </>
        ) : selectedEquipmentLight ? (
          <>
            <div className="card-title">
              <div>
                <small>CHANNEL</small>
                <h2>{selectedEquipmentLight.name}</h2>
              </div>
              {allowEquipment && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted("light", selectedEquipmentLight)
                  }
                >
                  Delete
                </button>
              )}
            </div>
            <div className="equipment-form-grid">
              <Field label="Channel name">
                <input
                  value={selectedEquipmentLight.name}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      name: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Channel number">
                <input type="number" min="1" max="8" value={selectedEquipmentLight.channelIndex ?? selectedEquipmentLight.moduleIndex ?? 1} disabled={!allowEquipment} onChange={(event) => updateChannel(selectedEquipmentLight.id, { channelIndex: Number(event.target.value), moduleIndex: Number(event.target.value) })} />
              </Field>
              <Field label="Module">
                <select
                  value={selectedEquipmentLight.moduleId ?? ""}
                  disabled={!allowEquipment}
                  onChange={(event) => {
                    const moduleId = Number(event.target.value);
                    updateChannel(selectedEquipmentLight.id, {
                      moduleId,
                      module: `Module ${moduleId}`,
                    });
                  }}
                >
                  <option value="">Unassigned</option>
                  {equipmentModules.map((module) => (
                    <option key={module.id} value={module.id}>
                      {module.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Output type"
                help={`${selectedChannelFamily.description}. Choosing a type stores the controller's own hardware code.`}
              >
                <select
                  value={String(
                    selectedChannelTypeOption?.displayPosition ??
                      selectedEquipmentLight.hardwareType ??
                      "",
                  )}
                  disabled={!allowEquipment}
                  data-testid="channel-output-type"
                  onChange={(event) => {
                    const option = selectedChannelFamily.options.find(
                      (candidate) =>
                        String(candidate.displayPosition) === event.target.value,
                    );
                    if (!option) return;
                    // The stored hardware code is what the controller and the
                    // archive care about; `kind` and `dimmable` follow from it
                    // so the three can never disagree.
                    updateChannel(selectedEquipmentLight.id, {
                      hardwareType: option.hw,
                      kind: option.name,
                      dimmable: option.loadClass === "dimmable",
                      hardwareChanged: true,
                    });
                  }}
                >
                  {selectedChannelTypeOption === undefined && (
                    <option value="">
                      {selectedEquipmentLight.hardwareType === undefined
                        ? "Not set"
                        : `Stored code ${selectedEquipmentLight.hardwareType} — not in this family`}
                    </option>
                  )}
                  {selectedChannelFamily.options.map((option) => (
                    <option
                      key={option.displayPosition}
                      value={String(option.displayPosition)}
                    >
                      {option.name}
                    </option>
                  ))}
                </select>
              </Field>
              {selectedChannelFamily.nameBindingVerified === false && (
                <p className="hint">
                  This module family&apos;s type labels are not yet confirmed
                  against the original app; the stored hardware code is
                  preserved exactly as imported.
                </p>
              )}
              <Field
                label="Accessory type"
                help="Only meaningful for an accessory output. The original app offers exactly these two."
              >
                <select
                  value={String(selectedEquipmentLight.accessoryType ?? "")}
                  disabled={
                    !allowEquipment || selectedChannelLoadClass !== "accessory"
                  }
                  data-testid="channel-accessory-type"
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      accessoryType:
                        event.target.value === ""
                          ? undefined
                          : Number(event.target.value),
                      hardwareChanged: true,
                    })
                  }
                >
                  <option value="">Not set</option>
                  {ACCESSORY_TYPE_NAMES.map((name, index) => (
                    <option key={name} value={String(index)}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Minimum">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectedEquipmentLight.minimum ?? 0}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      minimum: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Maximum">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectedEquipmentLight.maximum ?? 100}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      maximum: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Default">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectedEquipmentLight.defaultLevel ?? 100}
                  disabled={!allowEquipment}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      defaultLevel: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Test dimming">
                <input
                  type="range"
                  min={selectedEquipmentLight.minimum ?? 0}
                  max={selectedEquipmentLight.maximum ?? 100}
                  value={selectedEquipmentLight.level}
                  onChange={(event) =>
                    setChannelLevel(
                      selectedEquipmentLight.id,
                      Number(event.target.value),
                    )
                  }
                />
              </Field>
            </div>
            <p className="channel-type-explanation">
              Channel type explanation: choose the output profile that matches
              the connected driver or load.
            </p>
            <div className="equipment-actions">
              {/* Toggle and flash are ordinary verified dim commands. */}
              <button onClick={() => setChannelLevel(selectedEquipmentLight.id, selectedEquipmentLight.level ? 0 : 100)}>Toggle</button>
              <button onClick={() => flashChannel(selectedEquipmentLight)}>Flash channel</button>
              <GatedAction
                state={capability("channelSearch")}
                onClick={() => send({ type: "channelSearch", channel: controllerChannelFor(selectedEquipmentLight.id) })}
              >
                Search for this channel
              </GatedAction>
              <GatedAction
                state={capability("channelProfile")}
                onClick={() => send({ type: "channelProfile", channel: controllerChannelFor(selectedEquipmentLight.id) })}
              >
                Send configuration changes
              </GatedAction>
              {isBlindControl(selectedEquipmentLight.accessoryType) && (
                <>
                  <GatedAction
                    state={capability("blind")}
                    onClick={() => send({ type: "blind", channel: controllerChannelFor(selectedEquipmentLight.id), action: "open" })}
                  >
                    Open blind
                  </GatedAction>
                  <GatedAction
                    state={capability("blind")}
                    onClick={() => send({ type: "blind", channel: controllerChannelFor(selectedEquipmentLight.id), action: "toggle" })}
                  >
                    Toggle blind
                  </GatedAction>
                  <GatedAction
                    state={capability("blind")}
                    onClick={() => send({ type: "blind", channel: controllerChannelFor(selectedEquipmentLight.id), action: "close" })}
                  >
                    Close blind
                  </GatedAction>
                </>
              )}
            </div>
          </>
        ) : equipmentSection === "deleted" ? (
          <>
            <div className="card-title">
              <div>
                <small>RECOVERY</small>
                <h2>Deleted items</h2>
              </div>
            </div>
            <div className="deleted-items-list">
              {(data.deletedItems ?? []).length ? (
                (data.deletedItems ?? []).map((deleted) => (
                  <div key={deleted.key}>
                    <span>
                      <b>{deleted.item.name}</b>
                      <small>{deleted.type}</small>
                    </span>
                    <button disabled={!allowEquipment} onClick={() => restoreDeleted(deleted)}>Restore</button>
                    <button
                      className="delete"
                      disabled={!allowEquipment}
                      onClick={() =>
                        setData((old) => ({
                          ...old,
                          deletedItems: (old.deletedItems ?? []).filter(
                            (item) => item.key !== deleted.key,
                          ),
                        }))
                      }
                    >
                      Permanently delete
                    </button>
                  </div>
                ))
              ) : (
                <Empty>No deleted hardware.</Empty>
              )}
            </div>
          </>
        ) : equipmentSection === "areas" ? (
          <>
            <div className="card-title">
              <div>
                <small>{data.rooms.find((room) => room.id === activeAreaId)?.floor ?? "AREA"}</small>
                <h2>{roomName(activeAreaId)}</h2>
              </div>
              {allowEquipment && (
                <div className="button-row compact">
                  <button onClick={addSwitch}>＋ Switch</button>
                  <button className="primary" onClick={addChannel}>＋ Light</button>
                </div>
              )}
            </div>
            <h3>Lighting channels</h3>
            <div className="equipment-choice-list">
              {data.channels
                .filter((channel) => scopedAreaIds.has(channel.roomId))
                .map((channel) => (
                  <button key={channel.id} onClick={() => setEquipmentSelection({ type: "light", id: channel.id })}>
                    <span className="channel-number">{channel.id}</span>
                    <span><b>{channel.name}</b><small>{channel.module} · {channel.kind}</small></span>
                    <em>Configure ›</em>
                  </button>
                ))}
            </div>
            <h3>Wall switches</h3>
            <div className="equipment-choice-list">
              {scopedSwitches.map((item) => (
                <button key={item.id} onClick={() => setEquipmentSelection({ type: "switch", id: item.id })}>
                  <img src="/flexidim/switches.png" alt="" />
                  <span><b>{item.name}</b><small>{item.kind}</small></span>
                  <em>Configure ›</em>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );

  const switchesPanel = (
    <div className="master-detail">
      <section className="master card">
        <div className="master-head">
          <div>
            <small>SWITCHES</small>
            <h2>Switch overview</h2>
          </div>
          {allowEquipment && <button onClick={addSwitch}>＋</button>}
        </div>
        {data.switches.map((item) => (
          <button
            key={item.id}
            className={selectedSwitch === item.id ? "selected" : ""}
            onClick={() => setSelectedSwitch(item.id)}
          >
            <img src="/flexidim/switches.png" alt="" />
            <span>
              <b>{item.name}</b>
              <small>
                {roomName(item.roomId)} · {item.kind}
              </small>
            </span>
            <em>›</em>
          </button>
        ))}
      </section>
      <section className="detail card">
        {(() => {
          const item =
            data.switches.find((s) => s.id === selectedSwitch) ??
            data.switches[0];
          if (!item) return <Empty>Add a switch to begin.</Empty>;
          return (
            <>
              <div className="card-title">
                <div>
                  <small>{roomName(item.roomId)}</small>
                  <h2>{item.name}</h2>
                </div>
                <span className="version">Switch {item.id}</span>
              </div>
              <div className="wall-switch">
                <div className="switch-label">FlexiDim</div>
                <div className={`switch-grid buttons-${item.buttons}`}>
                  {Array.from(
                    { length: item.buttons },
                    (_, index) => index + 1,
                  ).map((button) => (
                    <button
                      key={button}
                      onClick={() => pressSwitch(item, button)}
                    >
                      <span>{button}</span>
                      <small>
                        {assignedScene(item.id, button)?.name ?? "Unassigned"}
                      </small>
                    </button>
                  ))}
                </div>
              </div>
              <p className="center hint">
                Press a button to send the original FlexiDim switch command and
                run its assigned scene.
              </p>
              <div className="form-grid narrow">
                <Field label="Switch name">
                  <input
                    value={item.name}
                    onChange={(e) =>
                      setData((old) => ({
                        ...old,
                        switches: old.switches.map((s) =>
                          s.id === item.id ? { ...s, name: e.target.value } : s,
                        ),
                      }))
                    }
                  />
                </Field>
                <Field label="Switch type">
                  <select
                    value={item.kind}
                    onChange={(e) =>
                      setData((old) => ({
                        ...old,
                        switches: old.switches.map((s) =>
                          s.id === item.id
                            ? {
                                ...s,
                                kind: e.target.value,
                                type: switchTypeByName(e.target.value)?.code,
                                hardwareType: switchTypeByName(e.target.value)
                                  ?.code,
                                buttons:
                                  switchTypeByName(e.target.value)?.buttons ??
                                  s.buttons,
                              }
                            : s,
                        ),
                      }))
                    }
                  >
                    {SWITCH_TYPES.map((entry) => (
                      <option key={entry.code}>{entry.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          );
        })()}
      </section>
    </div>
  );

  const basicRooms = basicFloor
    ? (() => {
        const children = data.rooms.filter(
          (room) => room.parentId === basicFloor,
        );
        const floor = data.rooms.find((room) => room.id === basicFloor);
        return children.length ? children : floor ? [floor] : [];
      })()
    : [];
  const basicSwitches = basicRoom
    ? data.switches.filter((item) => item.roomId === basicRoom)
    : [];
  const currentBasicSwitch = data.switches.find(
    (item) => item.id === basicSwitchId && item.roomId === basicRoom,
  );
  const basicChannels = currentBasicSwitch
    ? data.channels.filter(
        (channel) => channel.roomId === currentBasicSwitch.roomId,
      )
    : [];
  const basicSettings = currentBasicSwitch?.basic ?? {
    channelIds: [],
    assignOn: false,
    assignOff: false,
    assignDimming: false,
    assignChannelDimming: false,
    onTime: 0,
    offTime: 0,
    offPriority: 0,
    onPriority: false,
    channelSettings: {},
  };
  const assignedBasicChannels = basicSettings.channelIds.flatMap((id) => {
    const channel = data.channels.find((candidate) => candidate.id === id);
    return channel ? [channel] : [];
  });
  const unassignedBasicChannels = basicChannels.filter(
    (channel) => !basicSettings.channelIds.includes(channel.id),
  );
  const selectedBasicChannel = assignedBasicChannels.find(
    (channel) => channel.id === basicChannelId,
  );
  const selectedBasicChannelSettings = selectedBasicChannel
    ? (basicSettings.channelSettings?.[selectedBasicChannel.id] ?? {
        assignOn: basicSettings.assignOn,
        assignOff: basicSettings.assignOff ?? false,
        assignDimming: basicSettings.assignDimming,
        assignChannelDimming: basicSettings.assignChannelDimming,
        onPriority: basicSettings.onPriority ?? false,
        offPriority: Boolean(basicSettings.offPriority),
        onFade: basicSettings.onTime,
        offFade: basicSettings.offTime,
      })
    : undefined;
  const fadeTimes = [
    ...new Set([
      0,
      0.1,
      0.2,
      0.5,
      1,
      1.5,
      2,
      2.5,
      3,
      5,
      10,
      15,
      20,
      30,
      45,
      60,
      selectedBasicChannelSettings?.onFade,
      selectedBasicChannelSettings?.offFade,
    ].filter((seconds): seconds is number => seconds !== undefined)),
  ].sort((a, b) => a - b);

  const assignmentsPanel = (
    <div className="master-detail basic-assignment-layout">
      <section className="master card basic-assignment-menu">
        <div className="master-head">
          <div>
            <small>BASIC ASSIGNMENTS</small>
            <h2>
              {!basicFloor
                ? "Floors"
                : !basicRoom
                  ? roomName(basicFloor)
                  : roomName(basicRoom)}
            </h2>
          </div>
          {installer && (
            <button
              onClick={createBasicAssignments}
              aria-label="Edit or add basic assignments"
            >
              ＋
            </button>
          )}
        </div>
        {!basicFloor ? (
          <div className="area-tier">
            <span>Floors</span>
            {rootAreas.map((floor) => (
              <button
                key={floor.id}
                onClick={() => {
                  setBasicFloor(floor.id);
                  setBasicRoom(null);
                  setBasicSwitchId(null);
                  setBasicChannelId(null);
                }}
              >
                <img src={floor.icon} alt="" />
                <span>
                  <b>{floor.name}</b>
                  <small>Choose a room</small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        ) : !basicRoom ? (
          <div className="area-tier area-drilldown">
            <div className="area-drill-header">
              <button onClick={() => setBasicFloor(null)}>‹ Floors</button>
              <strong>{roomName(basicFloor)}</strong>
            </div>
            {basicRooms.map((room) => (
              <button
                key={room.id}
                onClick={() => {
                  setBasicRoom(room.id);
                  setBasicSwitchId(null);
                  setBasicChannelId(null);
                }}
              >
                <img src={room.icon} alt="" />
                <span>
                  <b>{room.name}</b>
                  <small>
                    {
                      data.switches.filter((item) => item.roomId === room.id)
                        .length
                    } switches
                  </small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        ) : (
          <div className="area-tier area-drilldown">
            <div className="area-drill-header">
              <button
                onClick={() => {
                  setBasicRoom(null);
                  setBasicSwitchId(null);
                  setBasicChannelId(null);
                }}
              >
                ‹ {roomName(basicFloor)}
              </button>
              <strong>{roomName(basicRoom)}</strong>
            </div>
            {basicSwitches.map((item) => (
              <button
                key={item.id}
                className={basicSwitchId === item.id ? "selected" : ""}
                onClick={() => {
                  setBasicSwitchId(item.id);
                  setBasicChannelId(null);
                  setShowBasicChannelPicker(false);
                  setOrderingBasicChannels(false);
                }}
              >
                <img src="/flexidim/switches.png" alt="" />
                <span>
                  <b>{item.name}</b>
                  <small>
                    {item.basic?.channelIds.length ?? 0} assigned channels
                  </small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="detail card basic-switch-editor">
        {currentBasicSwitch ? (
          <>
            <div className="card-title">
              <div>
                <small>{roomName(currentBasicSwitch.roomId)}</small>
                <h2>{currentBasicSwitch.name}</h2>
              </div>
              <span className="version">{currentBasicSwitch.kind}</span>
            </div>
            <div className="basic-options-grid">
              <section className="basic-assigned-channels">
                <div className="basic-section-title">
                  <div>
                    <small>CHANNELS</small>
                    <h3>Assigned lights</h3>
                  </div>
                </div>
                {installer && (
                  <div className="basic-channel-toolbar">
                    <button
                      title="Add one or more unassigned lights from this switch's room."
                      onClick={() => {
                        setShowBasicChannelPicker((visible) => !visible);
                        setOrderingBasicChannels(false);
                      }}
                    >
                      ＋ Add channels
                    </button>
                    <button
                      title="Change the order assigned channels are compiled in. The controller processes them in exactly this order."
                      className={orderingBasicChannels ? "active" : ""}
                      onClick={() => {
                        setOrderingBasicChannels((ordering) => !ordering);
                        setShowBasicChannelPicker(false);
                      }}
                    >
                      ↕ Adjust compiled order
                    </button>
                    <button
                      title="Assign every light in this room to the selected switch."
                      onClick={() => {
                        const channelIds = basicChannels.map(
                          (channel) => channel.id,
                        );
                        updateSwitchBasic(currentBasicSwitch.id, { channelIds });
                        setBasicChannelId(channelIds[0] ?? null);
                      }}
                    >
                      Select all
                    </button>
                    <button
                      title="Remove every assigned light from the selected switch."
                      onClick={() => {
                        updateSwitchBasic(currentBasicSwitch.id, {
                          channelIds: [],
                        });
                        setBasicChannelId(null);
                      }}
                    >
                      Deselect all
                    </button>
                  </div>
                )}
                {showBasicChannelPicker && installer && (
                  <div className="basic-channel-picker">
                    <strong>Add channels</strong>
                    {unassignedBasicChannels.length ? (
                      unassignedBasicChannels.map((channel) => (
                        <button
                          key={channel.id}
                          title={`Add ${channel.name} to this switch.`}
                          onClick={() => {
                            updateSwitchBasic(currentBasicSwitch.id, {
                              channelIds: [
                                ...basicSettings.channelIds,
                                channel.id,
                              ],
                            });
                            setBasicChannelId(channel.id);
                          }}
                        >
                          <span>
                            <b>{channel.name}</b>
                            <small>{channel.module}</small>
                          </span>
                          <em>＋</em>
                        </button>
                      ))
                    ) : (
                      <p>All room channels are already assigned.</p>
                    )}
                  </div>
                )}
                <div className="basic-channel-list">
                  {assignedBasicChannels.map((channel, index) => (
                    <div
                      key={channel.id}
                      className={
                        basicChannelId === channel.id ? "selected" : ""
                      }
                    >
                      <button
                        className="basic-channel-select"
                        title={`Edit assignment settings for ${channel.name}.`}
                        onClick={() => setBasicChannelId(channel.id)}
                      >
                        <span>
                          <b>{channel.name}</b>
                          <small>{channel.module}</small>
                        </span>
                        <em>›</em>
                      </button>
                      {orderingBasicChannels && installer && (
                        <span className="basic-order-buttons">
                          <button
                            disabled={index === 0}
                            title={`Move ${channel.name} earlier.`}
                            onClick={() => {
                              const channelIds = [...basicSettings.channelIds];
                              [channelIds[index - 1], channelIds[index]] = [
                                channelIds[index],
                                channelIds[index - 1],
                              ];
                              updateSwitchBasic(currentBasicSwitch.id, {
                                channelIds,
                              });
                            }}
                          >
                            ↑
                          </button>
                          <button
                            disabled={index === assignedBasicChannels.length - 1}
                            title={`Move ${channel.name} later.`}
                            onClick={() => {
                              const channelIds = [...basicSettings.channelIds];
                              [channelIds[index], channelIds[index + 1]] = [
                                channelIds[index + 1],
                                channelIds[index],
                              ];
                              updateSwitchBasic(currentBasicSwitch.id, {
                                channelIds,
                              });
                            }}
                          >
                            ↓
                          </button>
                        </span>
                      )}
                      {installer && !orderingBasicChannels && (
                        <button
                          className="basic-remove-channel"
                          title={`Remove ${channel.name} from this switch.`}
                          onClick={() => {
                            updateSwitchBasic(currentBasicSwitch.id, {
                              channelIds: basicSettings.channelIds.filter(
                                (id) => id !== channel.id,
                              ),
                            });
                            if (basicChannelId === channel.id)
                              setBasicChannelId(null);
                          }}
                        >
                          −
                        </button>
                      )}
                    </div>
                  ))}
                  {!assignedBasicChannels.length && (
                    <Empty>Add channels to this switch.</Empty>
                  )}
                </div>
              </section>
              <section className="basic-function-options">
                {selectedBasicChannel && selectedBasicChannelSettings ? (
                  <>
                    <small>CHANNEL FUNCTIONS</small>
                    <h3>{selectedBasicChannel.name}</h3>
                    <Toggle
                      label="Assign for on"
                      help="Include this light when the switch sends its On operation."
                      checked={selectedBasicChannelSettings.assignOn}
                      disabled={!installer}
                      onChange={(assignOn) =>
                        updateBasicChannelSettings(
                          currentBasicSwitch.id,
                          selectedBasicChannel.id,
                          { assignOn },
                        )
                      }
                    />
                    <Toggle
                      label="Assign for off"
                      help="Include this light when the switch sends its Off operation."
                      checked={selectedBasicChannelSettings.assignOff}
                      disabled={!installer}
                      onChange={(assignOff) =>
                        updateBasicChannelSettings(
                          currentBasicSwitch.id,
                          selectedBasicChannel.id,
                          { assignOff },
                        )
                      }
                    />
                    <Toggle
                      label="Assign for dimming"
                      help="Allow the switch's normal dimming action to raise or lower this light."
                      checked={selectedBasicChannelSettings.assignDimming}
                      disabled={!installer}
                      onChange={(assignDimming) =>
                        updateBasicChannelSettings(
                          currentBasicSwitch.id,
                          selectedBasicChannel.id,
                          { assignDimming },
                        )
                      }
                    />
                    <Toggle
                      label="Assign for channel dimming"
                      help="Allow direct channel-dimming commands from this switch to control this light independently."
                      checked={
                        selectedBasicChannelSettings.assignChannelDimming
                      }
                      disabled={!installer}
                      onChange={(assignChannelDimming) =>
                        updateBasicChannelSettings(
                          currentBasicSwitch.id,
                          selectedBasicChannel.id,
                          { assignChannelDimming },
                        )
                      }
                    />
                    <div className="basic-priority-options">
                      {/* The archive stores ONE `op` (onOffPri) per switch, not
                          a pair of per-channel flags. Presenting it once here is
                          what the original app's data model actually supports;
                          two independent per-channel toggles implied a
                          precision the controller never receives. */}
                      <label title="Whether this switch's basic assignment acts with on/off priority. Applies to every channel assigned to the switch.">
                        <input
                          type="checkbox"
                          data-testid="switch-on-off-priority"
                          checked={onOffPriority(currentBasicSwitch)}
                          disabled={!installer}
                          onChange={(event) =>
                            updateSwitchBasic(currentBasicSwitch.id, {
                              onPriority: event.target.checked,
                            })
                          }
                        />
                        <span className="option-label">
                          On/off priority (whole switch)
                          <HelpTip
                            label="On/off priority"
                            help="A single setting for the switch, stored as the archive's `op` field. It applies to every channel in this switch's basic assignment."
                          />
                        </span>
                      </label>
                    </div>
                    <div className="basic-timing-grid">
                      <Field
                        label="On fade time"
                        help="How long this light takes to reach its On level when operated by this switch."
                      >
                        <select
                          value={selectedBasicChannelSettings.onFade}
                          disabled={!installer}
                          onChange={(event) =>
                            updateBasicChannelSettings(
                              currentBasicSwitch.id,
                              selectedBasicChannel.id,
                              { onFade: Number(event.target.value) },
                            )
                          }
                        >
                          {fadeTimes.map((seconds) => (
                            <option key={seconds} value={seconds}>
                              {seconds === 0 ? "Immediate" : `${seconds} sec.`}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="Off fade time"
                        help="How long this light takes to fade fully off when operated by this switch."
                      >
                        <select
                          value={selectedBasicChannelSettings.offFade}
                          disabled={!installer}
                          onChange={(event) =>
                            updateBasicChannelSettings(
                              currentBasicSwitch.id,
                              selectedBasicChannel.id,
                              { offFade: Number(event.target.value) },
                            )
                          }
                        >
                          {fadeTimes.map((seconds) => (
                            <option key={seconds} value={seconds}>
                              {seconds === 0 ? "Immediate" : `${seconds} sec.`}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    {!installer && (
                      <p className="hint">
                        Turn on Allow changes to edit this channel.
                      </p>
                    )}
                  </>
                ) : (
                  <Empty>Select an assigned channel to edit its functions.</Empty>
                )}
              </section>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );

  const assignedSceneChannels = currentScene
    ? Object.keys(currentScene.levels).flatMap((channelId) => {
        const channel = data.channels.find((item) => item.id === Number(channelId));
        return channel ? [channel] : [];
      })
    : [];
  const unassignedSceneChannels = currentScene
    ? data.channels.filter((channel) => currentScene.levels[channel.id] === undefined)
    : [];
  const selectedSceneChannel = assignedSceneChannels.find(
    (channel) => channel.id === selectedSceneChannelId,
  );
  const selectedSceneChannelSettings = currentScene && selectedSceneChannel
    ? (currentScene.channelSettings?.[selectedSceneChannel.id] ?? {
        brightness: currentScene.levels[selectedSceneChannel.id] ?? 100,
        fadeTime: currentScene.fade,
        relativePercent: false,
        use100PercentTime: false,
        delay: 0,
        flags: 0,
        color: undefined,
        kelvin: undefined,
      })
    : undefined;
  // Colour capability comes from the channel's archived output type, not from
  // whether colour data happens to be present.
  const selectedSceneChannelSupportsColour = channelSupportsColour(
    selectedSceneChannel?.hardwareType,
    selectedSceneChannel?.typeFamily,
  );
  const sceneFadeTimes = [0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 15, 30, 60];
  const currentSceneTimerMode = currentScene?.nextSceneMode ?? -1;
  const currentSceneTimerValue = Math.max(0, currentScene?.nextSceneTime ?? 0);
  const currentSceneTimerHour = (currentSceneTimerValue >> 8) & 0xff;
  const currentSceneTimerMinute = currentSceneTimerValue & 0xff;
  const currentSceneDelayMinutes = Math.floor(currentSceneTimerValue / 30);
  const currentSceneDelaySeconds = (currentSceneTimerValue % 30) * 2;

  const scenesPanel = (
    <div className="master-detail scene-layout">
      <section className="master card scene-master">
        <div className="master-head">
          <div>
            <small>SCENES</small>
            <h2>{showDeletedScenes ? "Deleted scenes" : (currentSceneGroup?.name ?? "Scenes")}</h2>
          </div>
          {installer && !showDeletedScenes && (
            <button
              onClick={() => setShowSceneUtilities((visible) => !visible)}
              aria-label="Scene creation utilities"
            >
              ＋
            </button>
          )}
        </div>
        {showSceneUtilities && installer && (
          <div className="creation-utilities">
            <strong>Creation utilities</strong>
            <button onClick={() => createSceneUtility("extractor", "Extractor sequence")}>Create extractor sequence</button>
            <button onClick={() => createSceneUtility("security", "Security sequence")}>Create security sequence</button>
            <button onClick={() => createSceneUtility("simple", "Simple sequence")}>Create simple sequence</button>
          </div>
        )}
        <div className="area-tier area-drilldown scene-drilldown">
          {showDeletedScenes ? (
            <div className="area-drill-header">
              <button
                onClick={() => {
                  setShowDeletedScenes(false);
                  setSelectedScene(0);
                }}
              >
                ‹ Scenes
              </button>
              <strong>Deleted scenes</strong>
            </div>
          ) : currentSceneGroup ? (
            <div className="area-drill-header">
              <button
                onClick={() => {
                  setSceneGroupId(currentSceneGroup.parentId);
                  setEditingSceneGroupId(null);
                  setSelectedScene(0);
                  setSelectedSceneChannelId(null);
                }}
              >
                ‹ {currentSceneGroup.parentId ? "Back" : "Scenes"}
              </button>
              <strong>{currentSceneGroup.name}</strong>
            </div>
          ) : null}
          {!showDeletedScenes && !currentSceneGroup && (
            <button
              className="scene-trash-link"
              onClick={() => {
                setShowDeletedScenes(true);
                setEditingSceneGroupId(null);
                setSelectedScene(0);
                setSelectedSceneChannelId(null);
              }}
            >
              <img src="/flexidim/scenes.png" alt="" />
              <span><b>Deleted scenes</b><small>{data.deletedScenes?.length ?? 0} scenes</small></span>
              <em>›</em>
            </button>
          )}
          {visibleSceneGroups.map((group) => (
            <div className="scene-nav-row" key={group.id}>
              <button
                className={editingSceneGroupId === group.id ? "selected" : ""}
                onClick={() => {
                  setSceneGroupId(group.id);
                  setEditingSceneGroupId(null);
                  setSelectedScene(0);
                  setSelectedSceneChannelId(null);
                }}
              >
                <img src={group.icon} alt="" />
                <span>
                  <b>{group.name}</b>
                  <small>
                    {sceneGroups.filter((item) => item.parentId === group.id).length} areas ·{" "}
                    {data.scenes.filter((scene) => scene.groupId === group.id).length} scenes
                  </small>
                </span>
                <em>›</em>
              </button>
              <button
                className="scene-info-button"
                title={`Edit ${group.name}`}
                aria-label={`Edit ${group.name}`}
                onClick={() => {
                  setEditingSceneGroupId(group.id);
                  setSelectedScene(0);
                  setSelectedSceneChannelId(null);
                }}
              >
                i
              </button>
            </div>
          ))}
          {visibleScenes.map((scene) => (
            <button
              key={scene.id}
              className={selectedScene === scene.id && !editingSceneGroup ? "selected" : ""}
              onClick={() => {
                setEditingSceneGroupId(null);
                setSelectedScene(scene.id);
                setSelectedSceneChannelId(Number(Object.keys(scene.levels)[0]) || null);
                setShowSceneChannelPicker(false);
              }}
            >
              <img src="/flexidim/scenes.png" alt="" />
              <span>
                <b>{scene.name}</b>
                <small>{Object.keys(scene.levels).length} channels</small>
              </span>
              <em>›</em>
            </button>
          ))}
          {showDeletedScenes && (data.deletedScenes ?? []).map((scene) => (
            <div className="scene-deleted-row" key={scene.id}>
              <span>
                <img src="/flexidim/scenes.png" alt="" />
                <span><b>{scene.name}</b><small>{scene.folderPath?.join(" › ") ?? scene.group}</small></span>
              </span>
              {installer && <button onClick={() => restoreDeletedScene(scene)}>Restore</button>}
              {installer && <button className="danger" onClick={() => permanentlyDeleteScene(scene)}>Delete</button>}
            </div>
          ))}
          {!showDeletedScenes && !visibleSceneGroups.length && !visibleScenes.length && (
            <Empty>No scene groups or scenes here.</Empty>
          )}
          {showDeletedScenes && !(data.deletedScenes ?? []).length && (
            <Empty>No deleted scenes.</Empty>
          )}
        </div>
      </section>
      <section className="detail card scene-detail">
        {showDeletedScenes ? (
          <div className="deleted-scene-detail">
            <small>SCENE TRASH</small>
            <h2>Deleted scenes</h2>
            <p>Restore a scene to the Scenes root, or permanently remove it from this browser configuration.</p>
            {installer && Boolean(data.deletedScenes?.length) && (
              <button
                className="danger-button"
                onClick={() => setData((old) => ({ ...old, deletedScenes: [] }))}
              >
                Empty deleted scenes
              </button>
            )}
          </div>
        ) : editingSceneGroup ? (
          <>
            <div className="card-title">
              <div>
                <small>SCENE GROUP</small>
                <h2>{editingSceneGroup.name}</h2>
              </div>
              {installer && (
                <div className="button-row compact scene-order-actions">
                  <button
                    title="Move this group earlier among its siblings."
                    data-testid="group-move-up"
                    onClick={() => reorderSceneGroup(editingSceneGroup.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    title="Move this group later among its siblings."
                    data-testid="group-move-down"
                    onClick={() => reorderSceneGroup(editingSceneGroup.id, 1)}
                  >
                    ↓
                  </button>
                </div>
              )}
            </div>
            <div className="scene-group-editor">
              <Field label="Group name" help="The full floor or area name shown in Configuration.">
                <input
                  value={editingSceneGroup.name}
                  disabled={!installer}
                  onChange={(event) => updateSceneGroup(editingSceneGroup.id, { name: event.target.value })}
                />
              </Field>
              <Field label="Short name" help="The compact group name used where display space is limited.">
                <input
                  value={editingSceneGroup.shortName}
                  disabled={!installer}
                  onChange={(event) => updateSceneGroup(editingSceneGroup.id, { shortName: event.target.value })}
                />
              </Field>
              <h3>Room icon</h3>
              <div className="room-icon-picker">
                {areaIconChoices.map((icon) => (
                  <button
                    key={icon}
                    className={editingSceneGroup.icon === icon ? "selected" : ""}
                    disabled={!installer}
                    onClick={() => updateSceneGroup(editingSceneGroup.id, { icon })}
                  >
                    <img src={icon} alt="" />
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : currentScene ? (
          <>
            <div className="card-title scene-title-row">
              <div>
                <small>{currentSceneGroup?.name ?? currentScene.group}</small>
                <h2>{currentScene.name}</h2>
              </div>
              <Toggle
                label="Preview changes"
                help="Send brightness changes to the controller while editing, matching the iOS Preview Changes switch."
                checked={previewSceneChanges}
                onChange={setPreviewSceneChanges}
              />
              <button className="primary" onClick={() => runScene(currentScene)} disabled={connection !== "connected"}>
                Run scene
              </button>
              {installer && (
                <div className="button-row compact scene-order-actions">
                  <button
                    title="Move this scene earlier in its group. The order is the scene list's display rank."
                    data-testid="scene-move-up"
                    onClick={() => reorderScene(currentScene.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    title="Move this scene later in its group."
                    data-testid="scene-move-down"
                    onClick={() => reorderScene(currentScene.id, 1)}
                  >
                    ↓
                  </button>
                </div>
              )}
              {/* Deleting is blocked while locked, exactly as editing is. */}
              {installer && (
                <button
                  className="delete"
                  disabled={sceneIsLocked(currentScene)}
                  title={sceneIsLocked(currentScene) ? "Unlock this scene before deleting it." : undefined}
                  onClick={() => moveSceneToDeleted(currentScene)}
                >
                  Delete
                </button>
              )}
            </div>
            <Toggle
              label="Locked (read-only)"
              help="A locked scene can be run but not edited, matching the archive's lock flag. Unlock it to make changes."
              checked={sceneIsLocked(currentScene)}
              disabled={!installer}
              onChange={(locked) => updateScene(currentScene.id, { locked })}
            />
            {sceneIsLocked(currentScene) && (
              <p className="hint" data-testid="scene-locked-note">
                This scene is locked; its settings are read-only until you unlock
                it.
              </p>
            )}
            {sceneAffectedSwitches.length > 0 && (
              <p className="hint" data-testid="scene-affected-switches">
                Affected switches:{" "}
                {sceneAffectedSwitches
                  .map(
                    (entry) =>
                      `${entry.wallSwitch.name} (button ${entry.buttons.join(", ")})`,
                  )
                  .join("; ")}
              </p>
            )}
            {sceneUnknownFlagBits > 0 && (
              <p className="hint" data-testid="scene-unknown-flags">
                This scene carries flag bits (0x
                {sceneUnknownFlagBits.toString(16)}) whose meaning has not been
                recovered from the original app. They are preserved exactly as
                imported. The {UNRECOVERED_SCENE_FLAGS.join(" and ")} toggles are
                not offered because their bit positions are unverified.
              </p>
            )}
            <div className="scene-identity-grid">
              <Field label="Scene name" help="The full name of this scene.">
                <input
                  value={currentScene.name}
                  disabled={!installer}
                  onChange={(event) => updateScene(currentScene.id, { name: event.target.value })}
                />
              </Field>
              <Field label="Short name" help="The abbreviated scene name used on compact controls.">
                <input
                  value={currentScene.shortName ?? currentScene.name}
                  disabled={!installer}
                  onChange={(event) => updateScene(currentScene.id, { shortName: event.target.value })}
                />
              </Field>
            </div>
            <div className="scene-editor-grid">
              <section className="scene-assigned-panel">
                <div className="basic-section-title">
                  <div><small>CHANNELS</small><h3>Channels affected by scene</h3></div>
                  {installer && (
                    <button
                      className="scene-add-channel-button"
                      title="Add channels"
                      aria-label="Add channels"
                      onClick={() => setShowSceneChannelPicker((visible) => !visible)}
                    >＋</button>
                  )}
                </div>
                {showSceneChannelPicker && installer && (
                  <div className="basic-channel-picker">
                    <strong>Add channels</strong>
                    {unassignedSceneChannels.map((channel) => (
                      <button
                        key={channel.id}
                        onClick={() => {
                          updateSceneChannel(currentScene.id, channel.id, { brightness: channel.level });
                          setSelectedSceneChannelId(channel.id);
                        }}
                      >
                        <span><b>{channel.name}</b><small>{roomName(channel.roomId)}</small></span><em>＋</em>
                      </button>
                    ))}
                  </div>
                )}
                <div className="basic-channel-list scene-channel-list">
                  {assignedSceneChannels.map((channel) => (
                    <div key={channel.id} className={selectedSceneChannelId === channel.id ? "selected" : ""}>
                      <button className="basic-channel-select" onClick={() => setSelectedSceneChannelId(channel.id)}>
                        <span><b>{channel.name}</b><small>{roomName(channel.roomId)}</small></span><em>›</em>
                      </button>
                      {installer && (
                        <button
                          className="basic-remove-channel"
                          title={`Remove ${channel.name} from this scene.`}
                          onClick={() => {
                            const levels = { ...currentScene.levels };
                            const channelSettings = { ...currentScene.channelSettings };
                            delete levels[channel.id];
                            delete channelSettings[channel.id];
                            updateScene(currentScene.id, { levels, channelSettings });
                            if (selectedSceneChannelId === channel.id) setSelectedSceneChannelId(null);
                          }}
                        >−</button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              <section className="scene-channel-options">
                {selectedSceneChannel && selectedSceneChannelSettings ? (
                  <>
                    <small>CHANNEL SETTINGS</small>
                    <h3>{selectedSceneChannel.name}</h3>
                    <Field label={`Brightness: ${selectedSceneChannelSettings.brightness}%`} help="The target output level for this channel when the scene runs.">
                      <input
                        type="range" min="0" max="100"
                        value={selectedSceneChannelSettings.brightness}
                        disabled={!installer}
                        onChange={(event) => {
                          const brightness = Number(event.target.value);
                          updateSceneChannel(currentScene.id, selectedSceneChannel.id, { brightness });
                          if (previewSceneChanges) setChannelLevel(selectedSceneChannel.id, brightness, true);
                        }}
                      />
                    </Field>
                    {/* Colour and Kelvin only exist on fixtures the archived
                        channel type can actually address: a DMX address or DALI
                        group. A phase-control or relay output has intensity and
                        nothing else, so offering a colour wheel there would
                        invent a capability. */}
                    {selectedSceneChannelSupportsColour ? (
                      <>
                        <Field label="Colour" help="RGB scene colour for this DMX or DALI channel.">
                          <div className="scene-colour-control">
                            <img src="/flexidim/colorwheel.png" alt="Colour wheel" />
                            <input
                              type="color"
                              disabled={!installer}
                              data-testid="scene-channel-colour"
                              value={`#${[selectedSceneChannelSettings.color?.red ?? 255, selectedSceneChannelSettings.color?.green ?? 255, selectedSceneChannelSettings.color?.blue ?? 255].map((value) => value.toString(16).padStart(2, "0")).join("")}`}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateSceneChannel(currentScene.id, selectedSceneChannel.id, {
                                  color: {
                                    red: Number.parseInt(value.slice(1, 3), 16),
                                    green: Number.parseInt(value.slice(3, 5), 16),
                                    blue: Number.parseInt(value.slice(5, 7), 16),
                                  },
                                });
                              }}
                            />
                          </div>
                        </Field>
                        <Field label={`Tunable white: ${selectedSceneChannelSettings.kelvin ?? 4000} K`} help="Colour temperature for this channel.">
                          <input type="range" min="2000" max="6500" step="50" disabled={!installer} value={selectedSceneChannelSettings.kelvin ?? 4000} onChange={(event) => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { kelvin: Number(event.target.value) })} />
                        </Field>
                        <p className="hint">
                          Colour settings are stored in the configuration. Live
                          colour transmission stays unavailable until its
                          controller command is verified.
                        </p>
                      </>
                    ) : (
                      (selectedSceneChannelSettings.color || selectedSceneChannelSettings.kelvin) && (
                        <p className="hint" data-testid="scene-colour-unsupported">
                          This channel&apos;s output type does not address a
                          colour-capable fixture, but colour settings imported
                          for it are preserved rather than discarded.
                        </p>
                      )
                    )}
                    <Field label="Fade time" help="How long this channel takes to reach its scene brightness.">
                      <select
                        value={selectedSceneChannelSettings.fadeTime}
                        disabled={!installer}
                        onChange={(event) => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { fadeTime: Number(event.target.value) })}
                      >
                        {[...new Set([...sceneFadeTimes, selectedSceneChannelSettings.fadeTime])].sort((a, b) => a - b).map((seconds) => (
                          <option key={seconds} value={seconds}>{seconds === 0 ? "Immediate" : `${seconds} sec.`}</option>
                        ))}
                      </select>
                    </Field>
                    <Toggle label="Auto start" help="Automatically start this scene when its configured trigger becomes active." checked={currentScene.autoStart ?? false} disabled={!installer} onChange={(autoStart) => updateScene(currentScene.id, { autoStart })} />
                    <Toggle label="Relative %" help="Treat brightness as a percentage change relative to the channel's current level." checked={selectedSceneChannelSettings.relativePercent} disabled={!installer} onChange={(relativePercent) => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { relativePercent })} />
                    <Toggle label="100% time" help="Use the configured fade time as the time for a complete 0–100% transition." checked={selectedSceneChannelSettings.use100PercentTime} disabled={!installer} onChange={(use100PercentTime) => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { use100PercentTime })} />
                    <Field label="Delay" help="Wait this long after the scene runs before this channel changes.">
                      <div className="scene-stepper">
                        <button disabled={!installer || selectedSceneChannelSettings.delay <= 0} onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { delay: Math.max(0, selectedSceneChannelSettings.delay - 0.5) })}>−</button>
                        <output>{selectedSceneChannelSettings.delay.toFixed(1)} secs</output>
                        <button disabled={!installer} onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { delay: selectedSceneChannelSettings.delay + 0.5 })}>＋</button>
                      </div>
                    </Field>
                  </>
                ) : <Empty>Select a channel to edit its scene settings.</Empty>}
              </section>
            </div>
            <div className="scene-rule-sections">
              <div className="scene-rule-tabs">
                {(["rules", "periods", "flags"] as const).map((panel) => (
                  <button key={panel} className={sceneRulePanel === panel ? "active" : ""} onClick={() => setSceneRulePanel(panel)}>
                    {panel === "flags" ? "State flags" : panel[0].toUpperCase() + panel.slice(1)}
                  </button>
                ))}
              </div>
              {sceneRulePanel === "rules" ? (
                <>
            <div className="scene-sequence-sections">
              <section className="scene-sequence-card">
                <div className="scene-sequence-heading"><small>SEQUENCE</small><h3>Additional process</h3><p>Only used if the main scene runs.</p></div>
                <div className="scene-sequence-controls">
                  <Field label="Mode" help="Choose when the additional scene runs, or choose a sequence control action.">
                    <select value={currentSceneTimerMode} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { nextSceneMode: Number(event.target.value) })}>
                      <option value="-1">No additional process</option>
                      {sceneTimerModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}
                    </select>
                  </Field>
                  {currentSceneTimerMode === 0 && (
                    <Field label="Minutes : Seconds" help="Wait this long after the main scene runs before continuing the sequence.">
                      <span className="scene-timer-value">
                        <select
                          aria-label="Delay minutes"
                          value={Math.min(59, currentSceneDelayMinutes)}
                          disabled={!installer}
                          onChange={(event) => updateScene(currentScene.id, { nextSceneTime: Number(event.target.value) * 30 + currentSceneDelaySeconds / 2 })}
                        >
                          {timerMinutes.map((value) => <option key={value} value={value}>{twoDigits(value)}m</option>)}
                        </select>
                        <b>:</b>
                        <select
                          aria-label="Delay seconds"
                          value={currentSceneDelaySeconds}
                          disabled={!installer}
                          onChange={(event) => updateScene(currentScene.id, { nextSceneTime: currentSceneDelayMinutes * 30 + Number(event.target.value) / 2 })}
                        >
                          {timerSeconds.map((value) => <option key={value} value={value}>{twoDigits(value)}s</option>)}
                        </select>
                      </span>
                    </Field>
                  )}
                  {currentSceneTimerMode >= 1 && currentSceneTimerMode <= 5 && (
                    <Field
                      label={currentSceneTimerMode === 1 ? "Time" : "Offset"}
                      help={currentSceneTimerMode === 1 ? "The clock time when this scene should run." : "The amount of time before or after the selected sunrise or sunset event."}
                    >
                      <span className="scene-timer-value">
                        <select
                          aria-label={currentSceneTimerMode === 1 ? "Timer hour" : "Offset hours"}
                          value={Math.min(23, currentSceneTimerHour)}
                          disabled={!installer}
                          onChange={(event) => updateScene(currentScene.id, { nextSceneTime: (Number(event.target.value) << 8) | currentSceneTimerMinute })}
                        >
                          {timerHours.map((value) => <option key={value} value={value}>{twoDigits(value)}h</option>)}
                        </select>
                        <b>:</b>
                        <select
                          aria-label={currentSceneTimerMode === 1 ? "Timer minute" : "Offset minutes"}
                          value={Math.min(59, currentSceneTimerMinute)}
                          disabled={!installer}
                          onChange={(event) => updateScene(currentScene.id, { nextSceneTime: (currentSceneTimerHour << 8) | Number(event.target.value) })}
                        >
                          {timerMinutes.map((value) => <option key={value} value={value}>{twoDigits(value)}m</option>)}
                        </select>
                      </span>
                    </Field>
                  )}
                  {currentSceneTimerMode >= 1 && currentSceneTimerMode <= 5 && (
                    <Field label="On day(s)" help="Limit this timer to the selected day or group of days.">
                      <select value={currentScene.nextSceneDay ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { nextSceneDay: Number(event.target.value) })}>
                        {sceneTimerDays.map((day, index) => <option key={day} value={index}>{day}</option>)}
                      </select>
                    </Field>
                  )}
                  <Toggle label="Begin a new sequence" help="Start the additional process as a new independent sequence." checked={currentScene.beginNewSequence ?? false} disabled={!installer} onChange={(beginNewSequence) => updateScene(currentScene.id, { beginNewSequence })} />
                </div>
              </section>
              <section className="scene-sequence-card">
                <div className="scene-sequence-heading"><small>LINKED SCENE</small><h3>Additionally run scene</h3><p>Choose the linked or extender scene separately.</p></div>
                <div className="scene-sequence-controls">
                  <Field label="Scene">
                    <select value={currentScene.nextSceneId ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { nextSceneId: Number(event.target.value) || undefined })}>
                      <option value="0">None</option>{data.scenes.filter((scene) => scene.id !== currentScene.id).map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Extender scene">
                    <select value={currentScene.extenderSceneId ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { extenderSceneId: Number(event.target.value) || undefined })}>
                      <option value="0">None</option>{data.scenes.filter((scene) => scene.id !== currentScene.id).map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
                    </select>
                  </Field>
                  <Toggle label="Run additional scene first" help="Run the extender scene before the main scene rather than after it." checked={currentScene.runExtenderFirst ?? false} disabled={!installer} onChange={(runExtenderFirst) => updateScene(currentScene.id, { runExtenderFirst })} />
                </div>
              </section>
            </div>
            <div className="scene-rule-panel-body">
              <Field label="Only when last scene was" help="Restrict this scene to run only after the selected previous scene.">
                <select value={currentScene.previousSceneId ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { previousSceneId: Number(event.target.value) || undefined })}>
                  <option value="0">Any scene</option>
                  {data.scenes.filter((scene) => scene.id !== currentScene.id).map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
                </select>
              </Field>
            </div>
                </>
              ) : sceneRulePanel === "periods" ? (
                <div className="scene-rule-panel-body scene-period-grid">
                  <Field label="Period 1 condition"><select value={currentScene.period1Mode ?? "during"} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period1Mode: event.target.value as Scene["period1Mode"] })}><option value="always">Always</option><option value="during">Run scene if during period</option><option value="not-during">Run scene if not during period</option></select></Field>
                  <Field label="Period 1" help="Only run this scene while the selected period is active."><select value={currentScene.period1 ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period1: Number(event.target.value) })}><option value="0">None</option>{data.periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></Field>
                  <Field label="Period combination"><select value={currentScene.period2Mode ?? "none"} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period2Mode: event.target.value as Scene["period2Mode"] })}><option value="none">No second period</option><option value="and">Only if also</option><option value="or">Or also</option></select></Field>
                  <Field label="Period 2" help="A second period condition for this scene."><select value={currentScene.period2 ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period2: Number(event.target.value) })}><option value="0">None</option>{data.periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></Field>
                </div>
              ) : (
                <div className="scene-rule-panel-body">
                  <Field label="State flag" help="The controller state flag set or tested by this scene."><input type="number" min="0" value={currentScene.stateFlag ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { stateFlag: Number(event.target.value) })} /></Field>
                  <Field label="State flag action"><select value={currentScene.stateFlagAction ?? "none"} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { stateFlagAction: event.target.value as Scene["stateFlagAction"] })}><option value="none">No action</option><option value="set">Set State Flag</option><option value="clear">Clear State Flag</option><option value="require-set">Only if set</option><option value="require-clear">Only if clear</option></select></Field>
                </div>
              )}
            </div>
          </>
        ) : (
          <Empty>Select a floor, area, or scene.</Empty>
        )}
      </section>
    </div>
  );

  const sceneButtonRooms = sceneButtonFloor
    ? (() => {
        const children = data.rooms.filter(
          (room) => room.parentId === sceneButtonFloor,
        );
        const floor = data.rooms.find((room) => room.id === sceneButtonFloor);
        return children.length ? children : floor ? [floor] : [];
      })()
    : [];
  const sceneButtonSwitches = sceneButtonRoom
    ? data.switches.filter((item) => item.roomId === sceneButtonRoom)
    : [];
  const currentSceneButtonSwitch =
    sceneButtonSwitches.find((item) => item.id === selectedSwitch);
  // selectedButton is the physical plate position; each position pairs two
  // logical buttons — first press (2P-1) and second press (2P).
  const firstPressAssignment = currentSceneButtonSwitch
    ? buttonAssignment(currentSceneButtonSwitch.id, selectedButton * 2 - 1)
    : undefined;
  const secondPressAssignment = currentSceneButtonSwitch
    ? buttonAssignment(currentSceneButtonSwitch.id, selectedButton * 2)
    : undefined;
  const selectedButtonFirstDefault = currentSceneButtonSwitch
    ? specialButtonDefault(currentSceneButtonSwitch.buttons, selectedButton)
    : undefined;
  // The picker opens on the switch's own area (iOS default) but can be
  // navigated out to any floor/area. Scene groups mirror the area tree by name.
  const sceneButtonSwitchRoom = currentSceneButtonSwitch
    ? data.rooms.find((room) => room.id === currentSceneButtonSwitch.roomId)
    : undefined;
  const sceneButtonStartGroupId = sceneButtonSwitchRoom
    ? (sceneGroups.find(
        (group) =>
          group.name.trim().toLowerCase() ===
          sceneButtonSwitchRoom.name.trim().toLowerCase(),
      )?.id ?? null)
    : null;
  const sceneBreadcrumb = (scene: Scene) =>
    (scene.folderPath?.length
      ? scene.folderPath
      : [scene.group || "Scenes"]
    ).join(" : ");
  const sceneLabel = (sceneId?: number) => {
    const scene = data.scenes.find((item) => item.id === sceneId);
    return scene ? `${scene.name} (${sceneBreadcrumb(scene)})` : undefined;
  };
  const openScenePicker = (buttonNo: number) => {
    setScenePickerGroupId(sceneButtonStartGroupId);
    setScenePickerButton(buttonNo);
  };
  const assignPickerScene = (sceneId: number) => {
    if (scenePickerButton != null && currentSceneButtonSwitch)
      setButtonScene(currentSceneButtonSwitch, scenePickerButton, sceneId);
    setScenePickerButton(null);
  };
  const pickerGroup = sceneGroups.find(
    (group) => group.id === scenePickerGroupId,
  );
  const pickerChildGroups = sceneGroups
    .filter((group) => group.parentId === scenePickerGroupId)
    .sort((a, b) => a.displayRank - b.displayRank);
  const pickerScenes = data.scenes.filter(
    (scene) => (scene.groupId ?? null) === scenePickerGroupId,
  );

  const sceneButtonPanel = (
    <div className="master-detail scene-button-layout">
      <section className="master card scene-button-menu">
        <div className="master-head">
          <div>
            <small>SCENE TO BUTTON</small>
            <h2>
              {!sceneButtonFloor
                ? "Floors"
                : !sceneButtonRoom
                  ? roomName(sceneButtonFloor)
                  : roomName(sceneButtonRoom)}
            </h2>
          </div>
        </div>
        {!sceneButtonFloor ? (
          <div className="area-tier">
            <span>Floors</span>
            {rootAreas.map((floor) => (
              <button
                key={floor.id}
                onClick={() => {
                  setSceneButtonFloor(floor.id);
                  setSceneButtonRoom(null);
                }}
              >
                <img src={floor.icon} alt="" />
                <span>
                  <b>{floor.name}</b>
                  <small>Choose a room</small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        ) : !sceneButtonRoom ? (
          <div className="area-tier area-drilldown">
            <div className="area-drill-header">
              <button onClick={() => setSceneButtonFloor(null)}>‹ Floors</button>
              <strong>{roomName(sceneButtonFloor)}</strong>
            </div>
            {sceneButtonRooms.map((room) => (
              <button
                key={room.id}
                onClick={() => {
                  setSceneButtonRoom(room.id);
                  setSelectedSwitch(0);
                  setSelectedButton(1);
                }}
              >
                <img src={room.icon} alt="" />
                <span>
                  <b>{room.name}</b>
                  <small>
                    {
                      data.switches.filter((item) => item.roomId === room.id)
                        .length
                    } switches
                  </small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        ) : (
          <div className="area-tier area-drilldown">
            <div className="area-drill-header">
              <button onClick={() => setSceneButtonRoom(null)}>
                ‹ {roomName(sceneButtonFloor)}
              </button>
              <strong>{roomName(sceneButtonRoom)}</strong>
            </div>
            {sceneButtonSwitches.map((item) => (
              <button
                key={item.id}
                className={selectedSwitch === item.id ? "selected" : ""}
                onClick={() => {
                  setSelectedSwitch(item.id);
                  setSelectedButton(1);
                }}
              >
                <img src="/flexidim/switches.png" alt="" />
                <span>
                  <b>{item.name}</b>
                  <small>{item.kind} · {item.buttons} buttons</small>
                </span>
                <em>›</em>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="detail card switch-button-editor">
        {currentSceneButtonSwitch ? (
          <>
            <div className="card-title">
              <div>
                <small>{roomName(currentSceneButtonSwitch.roomId)}</small>
                <h2>{currentSceneButtonSwitch.name}</h2>
              </div>
            </div>
            <div className="switch-editor-body">
              {(() => {
                const layout = switchButtonLayout(
                  currentSceneButtonSwitch.buttons,
                );
                return (
                  <div
                    className="switch-plate"
                    aria-label={`${currentSceneButtonSwitch.kind} switch button layout`}
                    style={{ gridTemplateColumns: layout.columns }}
                  >
                    {layout.cells.map(({ button: position, column, row }) => {
                      const firstButtonNo = position * 2 - 1;
                      const secondButtonNo = position * 2;
                      const hasFirst = Boolean(
                        buttonAssignment(
                          currentSceneButtonSwitch.id,
                          firstButtonNo,
                        )?.sceneId,
                      );
                      const hasSecond = Boolean(
                        buttonAssignment(
                          currentSceneButtonSwitch.id,
                          secondButtonNo,
                        )?.sceneId,
                      );
                      const hasDefault = Boolean(
                        specialButtonDefault(
                          currentSceneButtonSwitch.buttons,
                          position,
                        ),
                      );
                      return (
                        <button
                          key={position}
                          className={selectedButton === position ? "selected" : ""}
                          style={{ gridColumn: column, gridRow: row }}
                          onClick={() => {
                            setSelectedButton(position);
                            pressSceneButton(
                              currentSceneButtonSwitch,
                              "first",
                              firstButtonNo,
                              position,
                            );
                          }}
                          aria-label={`Buttons ${firstButtonNo} and ${secondButtonNo}${hasSecond ? ", first and second press assigned" : hasFirst ? ", first press assigned" : hasDefault ? ", built-in function" : ", unassigned"}`}
                        >
                          <span className="switch-button-dots">
                            <i
                              className={
                                hasFirst ? "active" : hasDefault ? "default" : ""
                              }
                            />
                            <i className={hasSecond ? "active" : ""} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              <div className="button-operation-editor">
                <small>
                  BUTTONS {selectedButton * 2 - 1} &amp; {selectedButton * 2}
                </small>
                <h3>Assigned scenes</h3>
                <div className="press-assign">
                  <div className="press-assign-text">
                    <span className="option-label">
                      First press
                      <HelpTip
                        label="First press"
                        help="The scene run when this button is pressed once."
                      />
                    </span>
                    <p className="press-assign-value">
                      {sceneLabel(firstPressAssignment?.sceneId) ??
                        (selectedButtonFirstDefault
                          ? `Default — ${selectedButtonFirstDefault.name}`
                          : "Not assigned")}
                    </p>
                  </div>
                  <div className="press-assign-actions">
                    <button
                      className="press-edit"
                      disabled={!installer}
                      onClick={() => openScenePicker(selectedButton * 2 - 1)}
                      aria-label="Choose scene for first press"
                    >
                      Edit
                    </button>
                    {firstPressAssignment?.sceneId && (
                      <button
                        className="press-x"
                        disabled={!installer}
                        aria-label="Clear first press"
                        onClick={() =>
                          setButtonScene(
                            currentSceneButtonSwitch,
                            selectedButton * 2 - 1,
                            0,
                          )
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
                {selectedButtonFirstDefault && !firstPressAssignment?.sceneId && (
                  <p className="hint press-default-hint">
                    {selectedButtonFirstDefault.help}
                  </p>
                )}
                <div className="press-assign">
                  <div className="press-assign-text">
                    <span className="option-label">
                      Second press
                      <HelpTip
                        label="Second press"
                        help="An optional scene run when the button is pressed a second time."
                      />
                    </span>
                    <p className="press-assign-value">
                      {sceneLabel(secondPressAssignment?.sceneId) ?? "Not assigned"}
                    </p>
                  </div>
                  <div className="press-assign-actions">
                    <button
                      className="press-edit"
                      disabled={!installer}
                      onClick={() => openScenePicker(selectedButton * 2)}
                      aria-label="Choose scene for second press"
                    >
                      Edit
                    </button>
                    {secondPressAssignment?.sceneId && (
                      <button
                        className="press-x"
                        disabled={!installer}
                        aria-label="Clear second press"
                        onClick={() =>
                          setButtonScene(
                            currentSceneButtonSwitch,
                            selectedButton * 2,
                            0,
                          )
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
                <div className="button-send-mode">
                  <span className="option-label">When button pressed</span>
                  <div className="send-mode-options">
                    {BUTTON_PRESS_MODES.map((mode) => (
                      <div className="send-mode-option" key={mode.value}>
                        <button
                          type="button"
                          className={buttonPressMode === mode.value ? "active" : ""}
                          onClick={() => setButtonPressMode(mode.value)}
                        >
                          {mode.label}
                        </button>
                        <HelpTip label={mode.label} help={mode.help} />
                      </div>
                    ))}
                  </div>
                </div>
                {!installer && (
                  <p className="hint">
                    Turn on Allow changes to edit button scenes.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          <Empty>Choose a floor, room, and switch.</Empty>
        )}
      </section>
      {scenePickerButton != null && (
        <div
          className="scene-picker-overlay"
          onClick={() => setScenePickerButton(null)}
        >
          <div
            className="scene-picker"
            role="dialog"
            aria-label="Choose a scene"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="scene-picker-head">
              {scenePickerGroupId !== null ? (
                <button
                  className="scene-picker-back"
                  onClick={() =>
                    setScenePickerGroupId(pickerGroup?.parentId ?? null)
                  }
                >
                  ‹ Back
                </button>
              ) : (
                <span />
              )}
              <strong>{pickerGroup?.name ?? "All areas"}</strong>
              <button
                className="scene-picker-close"
                aria-label="Close"
                onClick={() => setScenePickerButton(null)}
              >
                ✕
              </button>
            </div>
            <div className="scene-picker-list">
              {pickerChildGroups.map((group) => {
                const areaCount = sceneGroups.filter(
                  (item) => item.parentId === group.id,
                ).length;
                const sceneCount = data.scenes.filter(
                  (scene) => scene.groupId === group.id,
                ).length;
                return (
                  <button
                    key={`group-${group.id}`}
                    className="scene-picker-group"
                    onClick={() => setScenePickerGroupId(group.id)}
                  >
                    <img src={group.icon} alt="" />
                    <span>
                      <b>{group.name}</b>
                      <small>
                        {areaCount} areas · {sceneCount} scenes
                      </small>
                    </span>
                    <em>›</em>
                  </button>
                );
              })}
              {pickerScenes.map((scene) => (
                <button
                  key={`scene-${scene.id}`}
                  className="scene-picker-scene"
                  onClick={() => assignPickerScene(scene.id)}
                >
                  <img src="/flexidim/scenes.png" alt="" />
                  <span>
                    <b>{scene.name}</b>
                    <small>{sceneBreadcrumb(scene)}</small>
                  </span>
                </button>
              ))}
              {!pickerChildGroups.length && !pickerScenes.length && (
                <p className="hint">No areas or scenes here.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const periodsPanel = (
    <div className="content-grid">
      <section className="card wide">
        <div className="card-title">
          <div>
            <small>PERIODS</small>
            <h2>Periods</h2>
          </div>
        </div>
        <div className="period-columns" aria-hidden="true">
          <span>Period name</span>
          <span>From</span>
          <span>To</span>
        </div>
        <div className="period-list">
          {data.periods.map((period) => (
            <div
              key={period.id}
              className={period.name.trim() ? "period-active" : "period-empty"}
            >
              <span className="period-number">{period.id}</span>
              <input
                className="period-name"
                aria-label={`Period ${period.id} name`}
                value={period.name}
                disabled={!installer}
                onChange={(e) =>
                  setData((old) => ({
                    ...old,
                    periods: old.periods.map((p) =>
                      p.id === period.id
                        ? e.target.value
                          ? { ...p, name: e.target.value }
                          : {
                              ...p,
                              name: "",
                              start: "00:00",
                              end: "00:00",
                              startMode: 0,
                              endMode: 0,
                            }
                        : p,
                    ),
                  }))
                }
              />
              <div className="period-boundary">
                <select
                  aria-label={`Period ${period.id} from mode`}
                  value={period.name.trim() ? (period.startMode ?? 0) : ""}
                  disabled={!installer || !period.name.trim()}
                  onChange={(event) => setData((old) => ({
                    ...old, periods: old.periods.map((item) => item.id === period.id ? { ...item, startMode: Number(event.target.value) } : item),
                  }))}
                >
                  <option value=""></option>
                  {periodModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}
                </select>
                <input
                  type="time"
                  aria-label={`Period ${period.id} from time`}
                  value={period.name.trim() ? period.start : ""}
                  disabled={!installer || !period.name.trim()}
                  onChange={(e) =>
                    setData((old) => ({
                      ...old,
                      periods: old.periods.map((p) =>
                        p.id === period.id
                          ? { ...p, start: e.target.value }
                          : p,
                      ),
                    }))
                  }
                />
              </div>
              <div className="period-boundary">
                <select
                  aria-label={`Period ${period.id} to mode`}
                  value={period.name.trim() ? (period.endMode ?? 0) : ""}
                  disabled={!installer || !period.name.trim()}
                  onChange={(event) => setData((old) => ({
                    ...old, periods: old.periods.map((item) => item.id === period.id ? { ...item, endMode: Number(event.target.value) } : item),
                  }))}
                >
                  <option value=""></option>
                  {periodModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}
                </select>
                <input
                  type="time"
                  aria-label={`Period ${period.id} to time`}
                  value={period.name.trim() ? period.end : ""}
                  disabled={!installer || !period.name.trim()}
                  onChange={(e) =>
                    setData((old) => ({
                      ...old,
                      periods: old.periods.map((p) =>
                        p.id === period.id ? { ...p, end: e.target.value } : p,
                      ),
                    }))
                  }
                />
              </div>
            </div>
          ))}
        </div>
        <div className="state-flags-section">
          <h3>State Flags</h3>
          <div className="state-flag-grid">
            {(data.stateFlags ?? []).map((stateFlag) => (
              <label key={stateFlag.id}>
                <span>{stateFlag.id}</span>
                <input
                  aria-label={`State flag ${stateFlag.id}`}
                  value={stateFlag.name}
                  disabled={!installer}
                  placeholder="enter a name to activate a state flag"
                  onChange={(event) =>
                    setData((old) => ({
                      ...old,
                      stateFlags: (old.stateFlags ?? []).map((item) =>
                        item.id === stateFlag.id
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <p className="hint state-flag-help">
            State Flags can be set or cleared by Scenes and then used by other
            Scenes (in the same way as Periods) to determine whether a Scene
            should run.
          </p>
        </div>
      </section>
    </div>
  );

  const moveUserAccess = (
    userId: number,
    field: "roomIds" | "switchIds",
    accessId: number,
    direction: -1 | 1,
  ) =>
    setData((old) => ({
      ...old,
      users: old.users.map((user) => {
        if (user.id !== userId) return user;
        const ordered = [...(user[field] ?? [])];
        const from = ordered.indexOf(accessId);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= ordered.length) return user;
        [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
        return updateUserProfile(user, { [field]: ordered });
      }),
    }));

  const usersPanel = (
    <div className="content-grid users-grid">
      <section className="card">
        <div className="card-title">
          <div>
            <small>USERS</small>
            <h2>Remote Control profiles</h2>
          </div>
          <button
            className="primary"
            disabled={!installer}
            onClick={() => {
              setData((old) => {
                const key = generateSecurityKey();
                const user = updateUserProfile(
                  {
                    id: newId(old.users),
                    name: "New user",
                    remote: false,
                    changes: false,
                    key,
                    securityCode: key,
                    roomIds: [],
                    switchIds: [],
                    profileVersion: 0,
                  },
                  {},
                );
                return { ...old, users: [...old.users, user] };
              });
              notify("New user created", "ok");
            }}
          >
            ＋ New user
          </button>
        </div>
        <div className="user-list">
          {data.users.map((user) => (
            <div key={user.id}>
              <img src="/flexidim/users.png" alt="" />
              <input
                value={user.name}
                disabled={!installer}
                onChange={(e) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id
                        ? updateUserProfile(u, { name: e.target.value })
                        : u,
                    ),
                  }))
                }
              />
              <code>{user.key}</code>
              <small>
                Profile v{user.profileVersion ?? 0} ·{" "}
                {user.profileStatus ?? (user.profileData ? "current" : "not generated")}
              </small>
              <button disabled={!installer} onClick={() => {
                const key = generateSecurityKey();
                setData((old) => ({
                  ...old, users: old.users.map((item) => item.id === user.id
                    ? updateUserProfile(item, { key, securityCode: key })
                    : item),
                }));
              }}>Generate security key</button>
              <Toggle
                label="Remote access"
                checked={user.remote}
                disabled={!installer}
                onChange={(remote) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id ? updateUserProfile(u, { remote }) : u,
                    ),
                  }))
                }
              />
              <Toggle
                label="Allow changes"
                checked={user.changes}
                disabled={!installer}
                onChange={(changes) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id ? updateUserProfile(u, { changes }) : u,
                    ),
                  }))
                }
              />
              <button
                className="delete"
                disabled={!installer}
                onClick={() =>
                  setData((old) => ({
                    ...old,
                    ...deleteConfigEntity(
                      snapshotContent(old),
                      "user",
                      user.id,
                    ),
                  }))
                }
              >
                Delete
              </button>
              <div className="user-access-editor">
                <strong>Rooms</strong>
                {orderUserAccess(data.rooms, user.roomIds).map((room) => (
                  <label key={room.id}>
                    <input type="checkbox" disabled={!installer} checked={user.roomIds?.includes(room.id) ?? false} onChange={(event) => setData((old) => ({
                      ...old, users: old.users.map((item) => item.id === user.id ? {
                        ...updateUserProfile(item, {
                          roomIds: event.target.checked
                            ? [...(item.roomIds ?? []), room.id]
                            : (item.roomIds ?? []).filter((id) => id !== room.id),
                        }),
                      } : item),
                    }))} />
                    {room.name}
                    {user.roomIds?.includes(room.id) && (
                      <span>
                        <button
                          type="button"
                          disabled={!installer || user.roomIds.indexOf(room.id) === 0}
                          onClick={(event) => {
                            event.preventDefault();
                            moveUserAccess(user.id, "roomIds", room.id, -1);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={!installer || user.roomIds.indexOf(room.id) === user.roomIds.length - 1}
                          onClick={(event) => {
                            event.preventDefault();
                            moveUserAccess(user.id, "roomIds", room.id, 1);
                          }}
                        >
                          ↓
                        </button>
                      </span>
                    )}
                  </label>
                ))}
                <strong>Switches</strong>
                {orderUserAccess(
                  data.switches.filter((wallSwitch) => !user.roomIds?.length || user.roomIds.includes(wallSwitch.roomId)),
                  user.switchIds,
                ).map((wallSwitch) => (
                  <label key={wallSwitch.id}>
                    <input type="checkbox" disabled={!installer} checked={user.switchIds?.includes(wallSwitch.id) ?? false} onChange={(event) => setData((old) => ({
                      ...old, users: old.users.map((item) => item.id === user.id ? {
                        ...updateUserProfile(item, {
                          switchIds: event.target.checked
                            ? [...(item.switchIds ?? []), wallSwitch.id]
                            : (item.switchIds ?? []).filter((id) => id !== wallSwitch.id),
                        }),
                      } : item),
                    }))} />
                    {wallSwitch.name}
                    {user.switchIds?.includes(wallSwitch.id) && (
                      <span>
                        <button
                          type="button"
                          disabled={!installer || user.switchIds.indexOf(wallSwitch.id) === 0}
                          onClick={(event) => {
                            event.preventDefault();
                            moveUserAccess(user.id, "switchIds", wallSwitch.id, -1);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={!installer || user.switchIds.indexOf(wallSwitch.id) === user.switchIds.length - 1}
                          onClick={(event) => {
                            event.preventDefault();
                            moveUserAccess(user.id, "switchIds", wallSwitch.id, 1);
                          }}
                        >
                          ↓
                        </button>
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="card user-info">
        <img src="/flexidim/icon.png" alt="FlexiDim" />
        <h2>User security keys</h2>
        <p>
          Keys are kept in this browser with the rest of the local
          configuration. Export a backup before clearing browser data.
        </p>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(
              data.users.map((u) => `${u.name}: ${u.key}`).join("\n"),
            );
            addTrace("User keys copied");
          }}
        >
          Copy all keys
        </button>
        <button onClick={exportUserKeys}>
          Export keys and profiles
        </button>
        <button disabled title="Controller user-profile transfer is not protocol-verified.">
          Send user profiles — not available
        </button>
      </section>
    </div>
  );

  const tracePanel = (
    <div className="content-grid">
      <section className="card wide trace-card">
        <div className="card-title">
          <div>
            <small>TRACE</small>
            <h2>Controller activity</h2>
          </div>
          <div className="button-row compact">
            <button onClick={() => send({ type: "periodFlags" })}>
              Request period flags
            </button>
            <button onClick={() => setTrace([])}>Clear</button>
          </div>
        </div>
        <div className="trace-list" role="log">
          {trace.length ? (
            trace.map((item, index) => (
              <div key={`${item.at}-${index}`} className={item.tone ?? ""}>
                <time>{item.at}</time>
                <i />
                <span>{item.text}</span>
              </div>
            ))
          ) : (
            <Empty>No activity yet.</Empty>
          )}
        </div>
      </section>
    </div>
  );

  const panels: Record<Tab, React.ReactNode> = {
    Sites: sitesPanel,
    Configurations: configPanel,
    Equipment: equipmentPanel,
    Switches: switchesPanel,
    "Basic Assignments": assignmentsPanel,
    Scenes: scenesPanel,
    "Scene to Button": sceneButtonPanel,
    Periods: periodsPanel,
    Users: usersPanel,
    Trace: tracePanel,
  };

  return (
    <main className="app-shell">
      {storageState === "unavailable" && (
        <div className="storage-banner" role="alert" data-testid="storage-banner">
          <b>Changes are not being saved.</b> Server storage is unavailable, so
          edits and imports exist only in this browser tab and will be lost when
          it closes. Reconnect the server, then reload before making further
          changes.
        </div>
      )}
      <header className="topbar">
        <button className="brand" onClick={() => setTab("Sites")}>
          <span className="brand-mark">
            <b>J</b>
            <b>C</b>
            <b>L</b>
          </span>
          <span>
            <strong>FlexiDim</strong>
            <small>Configuration</small>
          </span>
        </button>
        <div className="site-chip">
          <span>{data.site.name}</span>
          <small>{data.site.id}</small>
        </div>
        <button
          className={`connection-chip ${connection}`}
          disabled={!storageLoaded}
          onClick={() => connect()}
        >
          <i />
          {connectionLabel}
        </button>
        <div className="header-changes">
          <span>Allow changes</span>
          <button
            type="button"
            role="switch"
            aria-label="Allow configuration changes"
            aria-checked={installer}
            disabled={!storageLoaded}
            className={`ios-toggle ${installer ? "on" : ""}`}
            onClick={() => setChangesAllowed(!installer)}
          >
            <i />
          </button>
        </div>
      </header>
      <nav className="tabbar" aria-label="FlexiDim sections">
        {tabs.map((item) => (
          <button
            key={item.name}
            className={tab === item.name ? "active" : ""}
            onClick={() => setTab(item.name)}
          >
            <img src={item.icon} alt="" />
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
      <section className="workspace">
        <div className="section-heading">
          <div>
            <small>FLEXIDIM / {data.site.name.toUpperCase()}</small>
            <h1>{tab}</h1>
          </div>
          {tab !== "Sites" && (
            <span className={`status-pill ${connection}`}>
              ● {connectionLabel}
            </span>
          )}
        </div>
        {panels[tab]}
      </section>
      {transferDialog !== "closed" && (
        <div className="transfer-dialog-overlay">
          <div
            className="transfer-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="transfer-dialog-title"
          >
            {transferDialog === "warning" ? (
              <>
                <h2 id="transfer-dialog-title">
                  Ready to send configuration to Scene Controller
                </h2>
                <p>
                  Continuing will suspend operation of the switches until the
                  new configuration is completely downloaded.
                </p>
                <p>
                  The lighting system will also reset which, depending on the
                  new configuration, may result in light levels changing or
                  going off.
                </p>
                <p>The download process will take several minutes.</p>
                <div className="transfer-dialog-actions">
                  <button onClick={() => setTransferDialog("closed")}>
                    Cancel
                  </button>
                  <button className="primary" onClick={beginLiveTransfer}>
                    Continue
                  </button>
                </div>
              </>
            ) : transferDialog === "running" ? (
              <>
                <h2 id="transfer-dialog-title">
                  Send configuration to Scene Controller
                </h2>
                <p className="transfer-phase">
                  {visibleTransferMessage ?? "Connecting to Scene Controller"}
                </p>
                {transferProgress?.blockNumber &&
                  transferPreflight?.blockCount && (
                    <>
                      <progress
                        aria-label="Configuration download progress"
                        max={transferPreflight.blockCount}
                        value={transferProgress.blockNumber}
                      />
                      <p className="transfer-count">
                        Block {transferProgress.blockNumber} of{" "}
                        {transferPreflight.blockCount}
                      </p>
                    </>
                  )}
              </>
            ) : (
              <>
                <h2 id="transfer-dialog-title">
                  {transferResult?.state === "completed"
                    ? "Download completed successfully"
                    : "Configuration transfer stopped"}
                </h2>
                <p>
                  {transferResult?.state === "completed"
                    ? "Scene controller running normally"
                    : transferResult?.message}
                </p>
                <div className="transfer-dialog-actions">
                  <button
                    className="primary"
                    onClick={() => setTransferDialog("closed")}
                  >
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <footer>
        <span>FlexiDim Web</span>
        <span>Configuration saves automatically</span>
        <span>Recovered from iOS v2.97</span>
      </footer>
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            className={`toast ${toast.tone ?? "info"}`}
            onClick={() => dismissToast(toast.id)}
            aria-label={`Dismiss: ${toast.text}`}
          >
            <i />
            <span>{toast.text}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
