"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  parseLegacyFd4Config,
  type AppData,
  type DeletedItem,
  type FlexModule,
  type Channel,
  type Room,
  type Scene,
  type SceneChannelSettings,
  type SceneGroup,
  type Site,
  type WallSwitch,
} from "./fd4cfg";

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
  { name: "Basic Assignments", icon: "/flexidim/assignments.png" },
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
    description: "FlexiDim lighting system",
    address: "",
    timezone: "Europe/London",
    dst: "UK / Europe",
    remote: false,
  },
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
    { id: 1, name: "Kitchen entrance", roomId: 1, kind: "4 scene", buttons: 4 },
    { id: 2, name: "Living room", roomId: 2, kind: "8 scene", buttons: 8 },
  ],
  scenes: [
    {
      id: 1,
      name: "All Off",
      group: "Whole house",
      levels: { 1: 0, 2: 0, 3: 0, 4: 0 },
      fade: 1,
      enabled: true,
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
      <span className="option-label" title={help}>
        {label}
        {help && (
          <i
            tabIndex={0}
            aria-label={`${String(label)} help`}
            title={help}
            data-tooltip={help}
          >
            ?
          </i>
        )}
      </span>
      {children}
    </label>
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
      <span className="option-label" title={help}>
        {label}
        {help && (
          <i
            tabIndex={0}
            aria-label={`${label} help`}
            title={help}
            data-tooltip={help}
          >
            ?
          </i>
        )}
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
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
  const channels = data.channels.map((channel) => {
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
      channels
        .map((channel) => channel.moduleId)
        .filter((id): id is number => id !== undefined),
    ),
  ];
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
  return {
    ...data,
    rooms: normalizedRooms,
    channels,
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
  };
}

export default function FlexiDimWeb() {
  const [data, setData] = useState<AppData>(initialData);
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
  const [trace, setTrace] = useState<TraceItem[]>([
    { at: now(), text: "FlexiDim Web ready" },
  ]);
  const [installer, setInstaller] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem("flexidim-web-data");
    if (saved) {
      try {
        const parsed = restoreAreaHierarchy(JSON.parse(saved));
        window.setTimeout(() => setData(parsed), 0);
      } catch {
        /* keep safe defaults */
      }
    }
    hydrated.current = true;
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    return () => socket.current?.close();
  }, []);

  useEffect(() => {
    if (hydrated.current)
      localStorage.setItem("flexidim-web-data", JSON.stringify(data));
  }, [data]);

  const addTrace = (text: string, tone?: "ok" | "warn") =>
    setTrace((items) => [{ at: now(), text, tone }, ...items].slice(0, 150));
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

  const connect = () => {
    socket.current?.close();
    setConnection("connecting");
    addTrace(`Searching for a FlexiDim controller on port ${data.site.port}…`);
    const ws = new WebSocket("ws://127.0.0.1:8765");
    socket.current = ws;
    ws.onopen = () => {
      setConnection("bridge");
      ws.send(
        JSON.stringify({
          type: "discover",
          host: data.site.ip,
          port: data.site.port,
        }),
      );
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
          addTrace(
            message.message,
            message.state === "connected"
              ? "ok"
              : message.state === "error"
                ? "warn"
                : undefined,
          );
        } else if (message.type === "discovered") {
          updateSite({ ip: message.host, port: Number(message.port) });
          addTrace(
            `Controller discovered at ${message.host}:${message.port}`,
            "ok",
          );
        } else if (message.type === "trace") addTrace(message.message);
      } catch {
        addTrace(String(event.data));
      }
    };
    ws.onerror = () => {
      setConnection("error");
      addTrace("The connection to the local bridge was lost", "warn");
    };
    ws.onclose = () =>
      setConnection((state) => (state === "error" ? state : "offline"));
  };

  const setChannelLevel = (id: number, level: number, transmit = true) => {
    setData((old) => ({
      ...old,
      channels: old.channels.map((channel) =>
        channel.id === id ? { ...channel, level } : channel,
      ),
    }));
    if (transmit) {
      send({ type: "dim", channel: id, level, transition: 2 });
      addTrace(`Channel ${id} set to ${level}%`);
    }
  };

  const runScene = (scene: Scene | undefined) => {
    if (!scene) return;
    Object.entries(scene.levels).forEach(([channel, level]) =>
      setChannelLevel(Number(channel), level, false),
    );
    send({ type: "scene", levels: scene.levels, transition: scene.fade });
    addTrace(`Scene “${scene.name}” run`, "ok");
  };

  const pressSwitch = (wallSwitch: WallSwitch, button: number) => {
    send({ type: "switch", switch: wallSwitch.id, button });
    const scene = assignedScene(wallSwitch.id, button);
    if (scene) runScene(scene);
    else addTrace(`${wallSwitch.name}: button ${button} pressed`);
  };

  const updateSite = (patch: Partial<Site>) =>
    setData((old) => {
      const updated = { ...old.site, ...patch };
      const sites = (old.sites?.length ? old.sites : [old.site]).map((site) =>
        site.id === old.site.id ? updated : site,
      );
      return { ...old, site: updated, sites };
    });

  const selectSite = (site: Site) => {
    socket.current?.close();
    setConnection("offline");
    setData((old) => ({ ...old, site }));
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
      description: "FlexiDim lighting system",
      address: "",
      timezone: data.site.timezone || "Europe/London",
      dst: data.site.dst || "UK / Europe",
      remote: false,
    };
    setData((old) => ({ ...old, site, sites: [...sites, site] }));
    setConnection("offline");
    addTrace(`Site “${site.name}” created`, "ok");
  };

  const setChangesAllowed = (allowed: boolean) => {
    setInstaller(allowed);
    addTrace(
      allowed ? "Configuration changes enabled" : "Configuration changes disabled",
      allowed ? "ok" : undefined,
    );
  };

  const addFloor = () => {
    if (!installer) return;
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
    if (!installer) return;
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
    };
    setData((old) => ({
      ...old,
      modules: [...(old.modules ?? equipmentModules), flexModule],
    }));
    setEquipmentSection("modules");
    setEquipmentSelection({ type: "module", id });
  };

  const updateRoom = (id: number, patch: Partial<Room>) =>
    setData((old) => ({
      ...old,
      rooms: old.rooms.map((room) =>
        room.id === id ? { ...room, ...patch } : room,
      ),
    }));
  const updateChannel = (id: number, patch: Partial<Channel>) =>
    setData((old) => ({
      ...old,
      channels: old.channels.map((channel) =>
        channel.id === id ? { ...channel, ...patch } : channel,
      ),
    }));
  const updateSwitch = (id: number, patch: Partial<WallSwitch>) =>
    setData((old) => ({
      ...old,
      switches: old.switches.map((wallSwitch) =>
        wallSwitch.id === id ? { ...wallSwitch, ...patch } : wallSwitch,
      ),
    }));
  const updateModule = (id: number, patch: Partial<FlexModule>) =>
    setData((old) => ({
      ...old,
      modules: (old.modules ?? equipmentModules).map((module) =>
        module.id === id ? { ...module, ...patch } : module,
      ),
    }));

  const moveToDeleted = (deleted: DeletedItem) => {
    if (!installer) return;
    if (
      deleted.type === "area" &&
      data.rooms.some((room) => room.parentId === deleted.item.id)
    ) {
      window.alert("Move the child rooms first before deleting this area.");
      return;
    }
    setData((old) => ({
      ...old,
      rooms:
        deleted.type === "area"
          ? old.rooms.filter((item) => item.id !== deleted.item.id)
          : old.rooms,
      switches:
        deleted.type === "switch"
          ? old.switches.filter((item) => item.id !== deleted.item.id)
          : old.switches,
      channels:
        deleted.type === "light"
          ? old.channels.filter((item) => item.id !== deleted.item.id)
          : old.channels,
      modules:
        deleted.type === "module"
          ? (old.modules ?? equipmentModules).filter(
              (item) => item.id !== deleted.item.id,
            )
          : old.modules,
      deletedItems: [...(old.deletedItems ?? []), deleted],
    }));
    setEquipmentSelection(null);
    addTrace(`${deleted.item.name} moved to Deleted items`);
  };

  const restoreDeleted = (deleted: DeletedItem) => {
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

  const createSceneUtility = (
    utility: "extractor" | "security" | "simple",
    label: string,
  ) => {
    const name = window.prompt(`${label} name`, label);
    if (!name?.trim()) return;
    const id = newId([...data.scenes, ...(data.deletedScenes ?? [])]);
    setData((old) => ({
      ...old,
      scenes: [
        ...old.scenes,
        {
          id,
          name: name.trim(),
          group: currentSceneGroup?.name ?? "Sequences",
          groupId: sceneGroupId ?? sceneGroups[0]?.id,
          shortName: name.trim(),
          folderPath: currentSceneGroup ? [currentSceneGroup.name] : ["Sequences"],
          levels: Object.fromEntries(
            old.channels.map((channel) => [channel.id, channel.level]),
          ),
          fade: utility === "security" ? 0 : 2,
          enabled: true,
          days: dayNames,
          time: "",
          utility,
        },
      ],
    }));
    setSelectedScene(id);
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

  const setButtonLight = (
    wallSwitch: WallSwitch,
    button: number,
    press: "first" | "second",
    channelId: number,
  ) => {
    setData((old) => {
      const index = old.assignments.findIndex(
        (assignment) =>
          assignment.switchId === wallSwitch.id &&
          assignment.button === button,
      );
      const existing =
        index >= 0
          ? old.assignments[index]
          : { switchId: wallSwitch.id, button };
      const updated =
        press === "first"
          ? {
              ...existing,
              sceneId: undefined,
              channelIds: undefined,
              channelId: channelId || undefined,
            }
          : {
              ...existing,
              secondSceneId: undefined,
              secondChannelId: channelId || undefined,
            };
      const hasOperation = Boolean(
        updated.sceneId ||
          updated.channelId ||
          updated.channelIds?.length ||
          updated.secondSceneId ||
          updated.secondChannelId,
      );
      const assignments = [...old.assignments];
      if (index >= 0) {
        if (hasOperation) assignments[index] = updated;
        else assignments.splice(index, 1);
      } else if (hasOperation) assignments.push(updated);
      return { ...old, assignments };
    });
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

  const updateScene = (sceneId: number, patch: Partial<Scene>) =>
    setData((old) => ({
      ...old,
      scenes: old.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, ...patch } : scene,
      ),
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
        JSON.stringify(
          {
            format: "FlexiDim Web Configuration",
            version: 1,
            exportedAt: new Date().toISOString(),
            data,
          },
          null,
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

  const importConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      let imported: AppData;
      if (file.name.toLowerCase().endsWith(".fd4cfg"))
        imported = parseLegacyFd4Config(await file.arrayBuffer());
      else {
        const parsed = JSON.parse(await file.text());
        imported = restoreAreaHierarchy(parsed.data ?? parsed);
      }
      imported = restoreAreaHierarchy(imported);
      setData(imported);
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
      addTrace(`Imported ${file.name}`, "ok");
    } catch {
      addTrace("That configuration file could not be read", "warn");
    }
    event.target.value = "";
  };

  const addChannel = () => {
    if (!installer) return;
    const name = window.prompt("Channel name");
    if (!name?.trim()) return;
    const id = newId(data.channels);
    setData((old) => ({
      ...old,
      channels: [
        ...old.channels,
        {
          id,
          name: name.trim(),
          roomId: selectedRoom,
          module: `Module 1 / Ch${id}`,
          kind: "Dimmable",
          level: 0,
          moduleId: equipmentModules[0]?.id,
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
    if (!installer) return;
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
          buttons: 4,
        },
      ],
    }));
    setSelectedSwitch(id);
    setEquipmentSelection({ type: "switch", id });
  };
  const connectionLabel =
    connection === "connected"
      ? "Connected"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "bridge"
          ? "Bridge ready"
          : connection === "error"
            ? "Connection failed"
            : "Offline";

  const availableSites = data.sites?.length ? data.sites : [data.site];

  const sitesPanel = (
    <div className="content-grid site-grid">
      <section className="card site-selector">
        <div className="card-title">
          <div>
            <small>SITES</small>
            <h2>My FlexiDim sites</h2>
          </div>
          <button className="primary" onClick={createSite}>
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
              onChange={(e) => updateSite({ ip: e.target.value })}
              inputMode="decimal"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              value={data.site.port}
              onChange={(e) => updateSite({ port: Number(e.target.value) })}
            />
          </Field>
          <button className="primary" onClick={connect}>
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
            <h2>Home and location</h2>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Site name">
            <input
              value={data.site.name}
              onChange={(e) => updateSite({ name: e.target.value })}
            />
          </Field>
          <Field label="Site ID">
            <input
              value={data.site.id}
              onChange={(e) => updateSite({ id: e.target.value })}
            />
          </Field>
          <Field label="Address">
            <input
              value={data.site.address}
              placeholder="Optional"
              onChange={(e) => updateSite({ address: e.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <input
              value={data.site.timezone}
              onChange={(e) => updateSite({ timezone: e.target.value })}
            />
          </Field>
          <Field label="DST rules">
            <select
              value={data.site.dst}
              onChange={(e) => updateSite({ dst: e.target.value })}
            >
              <option>UK / Europe</option>
              <option>USA</option>
              <option>No daylight saving</option>
            </select>
          </Field>
        </div>
        <Toggle
          label="Enable remote access"
          checked={data.site.remote}
          onChange={(remote) => updateSite({ remote })}
        />
      </section>
    </div>
  );

  const configPanel = (
    <div className="content-grid config-grid">
      <section className="card">
        <div className="card-title">
          <div>
            <small>LOCAL CONFIGURATION</small>
            <h2>{data.site.name}</h2>
          </div>
          <span className="version">v2.97 migrated</span>
        </div>
        <div className="summary-list">
          <div>
            <span>Configuration name</span>
            <b>{data.site.name}</b>
          </div>
          <div>
            <span>Description</span>
            <b>{data.site.description}</b>
          </div>
          <div>
            <span>Format</span>
            <b>FlexiDim Web · fd4web</b>
          </div>
          <div>
            <span>Saved</span>
            <b>Automatically on this device</b>
          </div>
        </div>
        <div className="button-row">
          <button className="primary" onClick={exportConfig}>
            Export configuration
          </button>
          <button onClick={() => fileInput.current?.click()}>
            Import configuration
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".fd4cfg,.fd4web,.json,application/x-plist,application/octet-stream"
            onChange={importConfig}
            hidden
          />
        </div>
      </section>
      <section className="card sync-card">
        <div className="card-title">
          <div>
            <small>SCENE CONTROLLER</small>
            <h2>Configuration transfer</h2>
          </div>
        </div>
        <div className="sync-graphic">
          <img src="/flexidim/configurations.png" alt="" />
          <div className="sync-line">
            <i />
            <i />
            <i />
          </div>
          <img src="/flexidim/connected.png" alt="" />
        </div>
        <button onClick={() => addTrace("Configuration comparison requested")}>
          Compare with Scene Controller
        </button>
        <button
          className="primary"
          disabled={connection !== "connected"}
          onClick={() => {
            send({ type: "sync", data });
            addTrace("Configuration transfer started");
          }}
        >
          Send configuration to Scene Controller
        </button>
        <p className="warning-copy">
          Full binary configuration transfer is retained as an advanced bridge
          operation. Live lighting control remains available without it.
        </p>
      </section>
      <section className={`card installer-card ${installer ? "enabled" : ""}`}>
        <div>
          <small>INSTALLER ACCESS</small>
          <h2>
            {installer
              ? "Equipment changes enabled"
              : "Equipment changes are disabled"}
          </h2>
          <p>
            Making changes to equipment can affect proper operation of the
            FlexiDim system.
          </p>
        </div>
        <span className={`installer-status ${installer ? "enabled" : ""}`}>
          {installer ? "Allowed" : "Locked"}
        </span>
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

  const equipmentPanel = (
    <div className="master-detail equipment-layout">
      <section className="master card equipment-browser">
        <div className="master-head">
          <div>
            <small>EQUIPMENT</small>
            <h2>Hardware</h2>
          </div>
          {installer && equipmentSection === "areas" && (
            <button onClick={addFloor} aria-label="Add floor">
              ＋
            </button>
          )}
          {installer && equipmentSection === "modules" && (
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
          <div className="area-tier equipment-area-list">
            <div className="equipment-list-heading">
              {areaMenuParent ? (
                <button onClick={() => setAreaMenuParent(null)}>
                  ‹ Floors
                </button>
              ) : (
                <span>Floors / areas</span>
              )}
              {areaMenuParent && <strong>{roomName(areaMenuParent)}</strong>}
            </div>
            {(areaMenuParent
              ? data.rooms.filter((room) => room.parentId === areaMenuParent)
              : rootAreas
            ).map((area) => {
              const children = data.rooms.filter(
                (room) => room.parentId === area.id,
              );
              return (
                <div className="equipment-object-row" key={area.id}>
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
                    className="equipment-info"
                    aria-label={`Edit ${area.name} information`}
                    onClick={() =>
                      setEquipmentSelection({ type: "area", id: area.id })
                    }
                  >
                    ⓘ
                  </button>
                </div>
              );
            })}
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
              {installer && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted({
                      key: `area-${selectedEquipmentArea.id}-${Date.now()}`,
                      type: "area",
                      item: selectedEquipmentArea,
                    })
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
                  disabled={!installer}
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
                  disabled={!installer}
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
                  disabled={!installer}
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
                  disabled={!installer}
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
                  disabled={!installer}
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
              {installer && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted({
                      key: `module-${selectedEquipmentModule.id}-${Date.now()}`,
                      type: "module",
                      item: selectedEquipmentModule,
                    })
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
                  disabled={!installer}
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
                  disabled={!installer}
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
              <Toggle
                label="Turn on"
                checked={selectedEquipmentModule.enabled}
                disabled={!installer}
                onChange={(enabled) =>
                  updateModule(selectedEquipmentModule.id, { enabled })
                }
              />
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
              <button onClick={() => data.channels.forEach((channel) => setChannelLevel(channel.id, 100, false))}>All On</button>
              <button onClick={() => data.channels.forEach((channel) => setChannelLevel(channel.id, 0, false))}>All Off</button>
              <button onClick={() => addTrace("Pending module profiles sent", "ok")}>Send configuration changes</button>
              <button onClick={() => addTrace("All module profiles resent", "ok")}>Resend all configuration information</button>
              <button onClick={() => addTrace("Module configuration details prepared")}>Email configuration details</button>
            </div>
          </>
        ) : selectedEquipmentSwitch ? (
          <>
            <div className="card-title">
              <div>
                <small>SWITCH</small>
                <h2>{selectedEquipmentSwitch.name}</h2>
              </div>
              {installer && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted({
                      key: `switch-${selectedEquipmentSwitch.id}-${Date.now()}`,
                      type: "switch",
                      item: selectedEquipmentSwitch,
                    })
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
                    disabled={!installer}
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
                    disabled={!installer}
                    onChange={(event) =>
                      updateSwitch(selectedEquipmentSwitch.id, {
                        number: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Switch type">
                  <select
                    value={selectedEquipmentSwitch.buttons}
                    disabled={!installer}
                    onChange={(event) => {
                      const buttons = Number(event.target.value);
                      updateSwitch(selectedEquipmentSwitch.id, {
                        buttons,
                        kind: `${buttons} scene`,
                      });
                    }}
                  >
                    {[1, 2, 4, 6, 8, 12, 15].map((buttons) => (
                      <option key={buttons} value={buttons}>
                        {buttons} button
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
                    disabled={!installer}
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
                    disabled={!installer}
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
              <button onClick={() => addTrace("Waiting for a switch button press")}>Detect by button press</button>
              <button onClick={() => addTrace("Switch type detection started")}>Detect switch types</button>
              <button onClick={() => pressSwitch(selectedEquipmentSwitch, 1)}>Flash button LED</button>
            </div>
          </>
        ) : selectedEquipmentLight ? (
          <>
            <div className="card-title">
              <div>
                <small>CHANNEL</small>
                <h2>{selectedEquipmentLight.name}</h2>
              </div>
              {installer && (
                <button
                  className="delete"
                  onClick={() =>
                    moveToDeleted({
                      key: `light-${selectedEquipmentLight.id}-${Date.now()}`,
                      type: "light",
                      item: selectedEquipmentLight,
                    })
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
                  disabled={!installer}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      name: event.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Channel number">
                <input value={selectedEquipmentLight.id} disabled />
              </Field>
              <Field label="Module">
                <select
                  value={selectedEquipmentLight.moduleId ?? ""}
                  disabled={!installer}
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
              <Field label="Type">
                <select
                  value={selectedEquipmentLight.kind}
                  disabled={!installer}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      kind: event.target.value,
                    })
                  }
                >
                  <option>Dimmable</option>
                  <option>Trailing edge</option>
                  <option>Leading edge</option>
                  <option>DALI</option>
                  <option>Relay</option>
                  <option>1–10V</option>
                  <option>Blind</option>
                </select>
              </Field>
              <Field label="Accessory module">
                <select
                  value={selectedEquipmentLight.accessoryModule ?? "None"}
                  disabled={!installer}
                  onChange={(event) =>
                    updateChannel(selectedEquipmentLight.id, {
                      accessoryModule: event.target.value,
                    })
                  }
                >
                  <option>None</option>
                  <option>Automated search</option>
                  <option>Blind controller</option>
                  <option>DALI interface</option>
                </select>
              </Field>
              <Field label="Minimum">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectedEquipmentLight.minimum ?? 0}
                  disabled={!installer}
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
                  disabled={!installer}
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
                  disabled={!installer}
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
              <button onClick={() => setChannelLevel(selectedEquipmentLight.id, selectedEquipmentLight.level ? 0 : 100)}>Toggle</button>
              <button onClick={() => addTrace(`${selectedEquipmentLight.name} flashed`)}>Flash channel</button>
              <button onClick={() => addTrace("Channel profile sent", "ok")}>Send configuration changes</button>
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
                    <button onClick={() => restoreDeleted(deleted)}>Restore</button>
                    <button
                      className="delete"
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
              {installer && (
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
          {installer && <button onClick={addSwitch}>＋</button>}
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
                                buttons: e.target.value.startsWith("8") ? 8 : 4,
                              }
                            : s,
                        ),
                      }))
                    }
                  >
                    <option>4 scene</option>
                    <option>8 scene</option>
                    <option>2 channel opto</option>
                    <option>8 channel opto</option>
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
                      title="Change the order in which assigned channels appear and are processed."
                      className={orderingBasicChannels ? "active" : ""}
                      onClick={() => {
                        setOrderingBasicChannels((ordering) => !ordering);
                        setShowBasicChannelPicker(false);
                      }}
                    >
                      ↕ Adjust order
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
                      <label title="Give this channel's On command priority over lower-priority state changes.">
                        <input
                          type="checkbox"
                          checked={selectedBasicChannelSettings.onPriority}
                          disabled={!installer}
                          onChange={(event) =>
                            updateBasicChannelSettings(
                              currentBasicSwitch.id,
                              selectedBasicChannel.id,
                              { onPriority: event.target.checked },
                            )
                          }
                        />
                        <span className="option-label">
                          On priority
                          <i
                            tabIndex={0}
                            aria-label="On priority help"
                            title="Give this channel's On command priority over lower-priority state changes."
                            data-tooltip="Give this channel's On command priority over lower-priority state changes."
                          >?</i>
                        </span>
                      </label>
                      <label title="Give this channel's Off command priority over lower-priority state changes.">
                        <input
                          type="checkbox"
                          checked={selectedBasicChannelSettings.offPriority}
                          disabled={!installer}
                          onChange={(event) =>
                            updateBasicChannelSettings(
                              currentBasicSwitch.id,
                              selectedBasicChannel.id,
                              { offPriority: event.target.checked },
                            )
                          }
                        />
                        <span className="option-label">
                          Off priority
                          <i
                            tabIndex={0}
                            aria-label="Off priority help"
                            title="Give this channel's Off command priority over lower-priority state changes."
                            data-tooltip="Give this channel's Off command priority over lower-priority state changes."
                          >?</i>
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
      })
    : undefined;
  const sceneFadeTimes = [0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 15, 30, 60];
  const sceneRuleMask = (selectedSceneChannelSettings?.flags ?? 0) & 0x0f;
  const currentSceneTimerMode = currentScene?.nextSceneMode ?? -1;
  const currentSceneTimerValue = Math.max(0, currentScene?.nextSceneTime ?? 0);
  const currentSceneTimerHour = (currentSceneTimerValue >> 8) & 0xff;
  const currentSceneTimerMinute = currentSceneTimerValue & 0xff;
  const currentSceneDelayMinutes = Math.floor(currentSceneTimerValue / 30);
  const currentSceneDelaySeconds = (currentSceneTimerValue % 30) * 2;
  const sceneBrightnessRules = [
    { bit: 1, label: "When light is off" },
    { bit: 2, label: "When light is on" },
    { bit: 4, label: "When brightness would increase" },
    { bit: 8, label: "When brightness would decrease" },
  ];

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
            </div>
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
                    <div className="scene-rule-tabs">
                      {(["rules", "periods", "flags"] as const).map((panel) => (
                        <button key={panel} className={sceneRulePanel === panel ? "active" : ""} onClick={() => setSceneRulePanel(panel)}>
                          {panel === "flags" ? "State flags" : panel[0].toUpperCase() + panel.slice(1)}
                        </button>
                      ))}
                    </div>
                    <div className="scene-rule-panel">
                      {sceneRulePanel === "rules" ? (
                        <div className="scene-brightness-rules">
                          <div className="scene-rule-heading">
                            <div><b>Change brightness</b><small>Select one or more conditions.</small></div>
                            <button
                              className={sceneRuleMask === 0x0f ? "active" : ""}
                              disabled={!installer}
                              onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { flags: (selectedSceneChannelSettings.flags & ~0x0f) | 0x0f })}
                            >Always</button>
                          </div>
                          {sceneBrightnessRules.map((rule) => {
                            const enabled = Boolean(sceneRuleMask & rule.bit);
                            return (
                              <div className="scene-rule-condition" key={rule.bit}>
                                <span>{rule.label}</span>
                                <button
                                  className={enabled ? "enabled" : ""}
                                  disabled={!installer}
                                  aria-label={`${enabled ? "Remove" : "Add"} rule: ${rule.label}`}
                                  onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { flags: selectedSceneChannelSettings.flags ^ rule.bit })}
                                >{enabled ? "−" : "+"}</button>
                              </div>
                            );
                          })}
                          <div className="scene-rule-delay">
                            <div><b>Delay</b><small>Wait before changing this channel.</small></div>
                            <div className="scene-stepper">
                              <button disabled={!installer || selectedSceneChannelSettings.delay <= 0} onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { delay: Math.max(0, selectedSceneChannelSettings.delay - 0.5) })}>−</button>
                              <output>{selectedSceneChannelSettings.delay.toFixed(1)} secs</output>
                              <button disabled={!installer} onClick={() => updateSceneChannel(currentScene.id, selectedSceneChannel.id, { delay: selectedSceneChannelSettings.delay + 0.5 })}>＋</button>
                            </div>
                          </div>
                          <Field label="Only when last scene was" help="Restrict this scene to run only after the selected previous scene.">
                            <select value={currentScene.previousSceneId ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { previousSceneId: Number(event.target.value) || undefined })}>
                              <option value="0">Any scene</option>
                              {data.scenes.filter((scene) => scene.id !== currentScene.id).map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
                            </select>
                          </Field>
                        </div>
                      ) : sceneRulePanel === "periods" ? (
                        <div className="scene-period-grid">
                          <Field label="Period 1"><select value={currentScene.period1 ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period1: Number(event.target.value) })}><option value="0">None</option>{data.periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></Field>
                          <Field label="Period 2"><select value={currentScene.period2 ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { period2: Number(event.target.value) })}><option value="0">None</option>{data.periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></Field>
                        </div>
                      ) : (
                        <Field label="State flag" help="The controller state flag used by this scene's rules."><input type="number" min="0" value={currentScene.stateFlag ?? 0} disabled={!installer} onChange={(event) => updateScene(currentScene.id, { stateFlag: Number(event.target.value) })} /></Field>
                      )}
                    </div>
                  </>
                ) : <Empty>Select a channel to edit its scene settings.</Empty>}
              </section>
            </div>
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
  const currentButtonAssignment = currentSceneButtonSwitch
    ? buttonAssignment(currentSceneButtonSwitch.id, selectedButton)
    : undefined;
  const sceneButtonLights = currentSceneButtonSwitch
    ? data.channels.filter(
        (channel) => channel.roomId === currentSceneButtonSwitch.roomId,
      )
    : [];

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
                  <small>{item.buttons} buttons</small>
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
              <div className="switch-plate" aria-label="Switch button layout">
                {Array.from(
                  { length: currentSceneButtonSwitch.buttons },
                  (_, index) => index + 1,
                ).map((button) => {
                  const assignment = buttonAssignment(
                    currentSceneButtonSwitch.id,
                    button,
                  );
                  const hasFirst = Boolean(
                    assignment?.sceneId ||
                      assignment?.channelId ||
                      assignment?.channelIds?.length,
                  );
                  const hasSecond = Boolean(
                    assignment?.secondSceneId || assignment?.secondChannelId,
                  );
                  return (
                    <button
                      key={button}
                      className={selectedButton === button ? "selected" : ""}
                      onClick={() => setSelectedButton(button)}
                      aria-label={`Button ${button}${hasSecond ? ", first and second press assigned" : hasFirst ? ", first press assigned" : ", unassigned"}`}
                    >
                      <span>{button}</span>
                      <i className={hasFirst ? "active" : ""} />
                      <i className={hasSecond ? "active" : ""} />
                    </button>
                  );
                })}
              </div>
              <div className="button-operation-editor">
                <small>BUTTON {selectedButton}</small>
                <h3>Controlled light</h3>
                <Field label="First press">
                  <select
                    value={
                      currentButtonAssignment?.channelIds?.length
                        ? "all"
                        : (currentButtonAssignment?.channelId ?? "")
                    }
                    disabled={!installer}
                    onChange={(event) =>
                      setButtonLight(
                        currentSceneButtonSwitch,
                        selectedButton,
                        "first",
                        Number(event.target.value),
                      )
                    }
                  >
                    <option value="">No operation</option>
                    {currentButtonAssignment?.channelIds?.length && (
                      <option value="all">All room lights (basic)</option>
                    )}
                    {sceneButtonLights.map((channel) => (
                      <option value={channel.id} key={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Second press">
                  <select
                    value={currentButtonAssignment?.secondChannelId ?? ""}
                    disabled={!installer}
                    onChange={(event) =>
                      setButtonLight(
                        currentSceneButtonSwitch,
                        selectedButton,
                        "second",
                        Number(event.target.value),
                      )
                    }
                  >
                    <option value="">No second-press operation</option>
                    {sceneButtonLights.map((channel) => (
                      <option value={channel.id} key={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {!installer && (
                  <p className="hint">
                    Turn on Allow changes to edit button operations.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          <Empty>Choose a floor, room, and switch.</Empty>
        )}
      </section>
    </div>
  );

  const periodsPanel = (
    <div className="content-grid">
      <section className="card wide">
        <div className="card-title">
          <div>
            <small>PERIODS</small>
            <h2>Lighting schedule periods</h2>
          </div>
          <button
            className="primary"
            onClick={() =>
              setData((old) => ({
                ...old,
                periods: [
                  ...old.periods,
                  {
                    id: newId(old.periods),
                    name: "New period",
                    start: "08:00",
                    end: "18:00",
                    days: dayNames,
                    enabled: true,
                  },
                ],
              }))
            }
          >
            ＋ New period
          </button>
        </div>
        <div className="period-list">
          {data.periods.map((period) => (
            <div key={period.id} className={period.enabled ? "" : "disabled"}>
              <button
                className={`period-power ${period.enabled ? "on" : ""}`}
                onClick={() =>
                  setData((old) => ({
                    ...old,
                    periods: old.periods.map((p) =>
                      p.id === period.id ? { ...p, enabled: !p.enabled } : p,
                    ),
                  }))
                }
              >
                ●
              </button>
              <input
                className="period-name"
                value={period.name}
                onChange={(e) =>
                  setData((old) => ({
                    ...old,
                    periods: old.periods.map((p) =>
                      p.id === period.id ? { ...p, name: e.target.value } : p,
                    ),
                  }))
                }
              />
              <label>
                From{" "}
                <input
                  type="time"
                  value={period.start}
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
              </label>
              <label>
                To{" "}
                <input
                  type="time"
                  value={period.end}
                  onChange={(e) =>
                    setData((old) => ({
                      ...old,
                      periods: old.periods.map((p) =>
                        p.id === period.id ? { ...p, end: e.target.value } : p,
                      ),
                    }))
                  }
                />
              </label>
              <div className="mini-days">
                {dayNames.map((day) => (
                  <button
                    key={day}
                    className={period.days.includes(day) ? "active" : ""}
                    onClick={() =>
                      setData((old) => ({
                        ...old,
                        periods: old.periods.map((p) =>
                          p.id === period.id
                            ? {
                                ...p,
                                days: p.days.includes(day)
                                  ? p.days.filter((d) => d !== day)
                                  : [...p.days, day],
                              }
                            : p,
                        ),
                      }))
                    }
                  >
                    {day[0]}
                  </button>
                ))}
              </div>
              <button
                className="delete"
                onClick={() =>
                  setData((old) => ({
                    ...old,
                    periods: old.periods.filter((p) => p.id !== period.id),
                  }))
                }
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

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
            onClick={() =>
              setData((old) => ({
                ...old,
                users: [
                  ...old.users,
                  {
                    id: newId(old.users),
                    name: "New user",
                    remote: false,
                    changes: false,
                    key: crypto.randomUUID().replace(/-/g, " ").slice(0, 19),
                  },
                ],
              }))
            }
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
                onChange={(e) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id ? { ...u, name: e.target.value } : u,
                    ),
                  }))
                }
              />
              <code>{user.key}</code>
              <Toggle
                label="Remote access"
                checked={user.remote}
                onChange={(remote) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id ? { ...u, remote } : u,
                    ),
                  }))
                }
              />
              <Toggle
                label="Allow changes"
                checked={user.changes}
                onChange={(changes) =>
                  setData((old) => ({
                    ...old,
                    users: old.users.map((u) =>
                      u.id === user.id ? { ...u, changes } : u,
                    ),
                  }))
                }
              />
              <button
                className="delete"
                onClick={() =>
                  setData((old) => ({
                    ...old,
                    users: old.users.filter((u) => u.id !== user.id),
                  }))
                }
              >
                Delete
              </button>
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
        <button className={`connection-chip ${connection}`} onClick={connect}>
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
      <footer>
        <span>FlexiDim Web</span>
        <span>Local-first · Configuration saved on this device</span>
        <span>Recovered from iOS v2.97</span>
      </footer>
    </main>
  );
}
