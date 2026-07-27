// Synthetic FlexiDim site used to build the committed golden `.fd4cfg`
// fixture. Real recovered coder keys and layout, entirely fake values: no
// data from any private reference archive appears here.

/** @returns {import("../app/fd4cfg.ts").AppData} */
export function buildGoldenAppData() {
  const site = {
    name: "Golden Test House",
    id: "FD4-GOLD",
    ip: "192.168.77.50",
    port: 15273,
    routerPort: 15273,
    description: "Synthetic golden fixture",
    address: "1 Fixture Way, Testville",
    contact: "Golden Tester",
    email: "golden@example.test",
    phone: "01234 567890",
    latitude: "51.50000",
    longitude: "-0.12000",
    timezone: "Europe/London",
    dst: "UK / Europe",
    remote: false,
    remoteServer: "",
    securityCode: "GOLDENFIXTURE016",
    autoDetect: true,
    addressLines: ["1 Fixture Way", "Testville", "", ""],
    siteType: 0,
    routerInbound: true,
    wirelessGateways: [{ address: "gateway-one", count: 2 }],
    moduleOrderA: [7000, 7010],
    moduleOrderB: [8000],
    updatedAt: "2026-01-02T03:04:05.000Z",
  };

  const rooms = [
    { id: 1, name: "Ground Floor", floor: "FlexiDim", icon: "/flexidim/rooms/0.png", parentId: null, shortName: "Ground", areaType: "Floor", displayRank: 0, hardwareType: 0, hardwareIndex: 0, legacyKey: 101 },
    { id: 2, name: "Lounge", floor: "Ground Floor", icon: "/flexidim/rooms/3.png", parentId: 1, shortName: "Lounge", displayRank: 1, hardwareType: 0, hardwareIndex: 0, legacyKey: 102 },
    { id: 3, name: "Kitchen", floor: "Ground Floor", icon: "/flexidim/rooms/10.png", parentId: 1, shortName: "Kitchen", displayRank: 2, hardwareType: 0, hardwareIndex: 0, legacyKey: 103 },
  ];

  const channels = [
    // Bus-A module 7000, channels 1-2; bus-A module 7010 channel 1; bus-B
    // module 8000 channel 1. Address order must follow the stored module
    // order, not the numeric module IDs.
    { id: 1, name: "Lounge Ceiling", roomId: 2, module: "Module 7000 / Ch1", kind: "Dimmable", level: 0, moduleId: 7000, moduleIndex: 1, channelIndex: 1, controllerChannel: 1, accessoryModule: "None", accessoryType: 0, minimum: 5, maximum: 100, maximumPermissible: 95, defaultLevel: 80, shortName: "Ceiling", displayRank: 0, hardwareType: 2, dimmable: true, hardwareChanged: false, legacyKey: 201 },
    { id: 2, name: "Lounge Lamps", roomId: 2, module: "Module 7000 / Ch2", kind: "Hard fired dimmable", level: 0, moduleId: 7000, moduleIndex: 2, channelIndex: 2, controllerChannel: 2, accessoryModule: "None", accessoryType: 0, minimum: 0, maximum: 100, maximumPermissible: 100, defaultLevel: 100, shortName: "Lamps", displayRank: 1, hardwareType: 38, dimmable: true, hardwareChanged: true, legacyKey: 202 },
    { id: 3, name: "Kitchen Spots", roomId: 3, module: "Module 7010 / Ch1", kind: "Full cycle on/off", level: 0, moduleId: 7010, moduleIndex: 1, channelIndex: 1, controllerChannel: 9, accessoryModule: "None", accessoryType: 0, minimum: 10, maximum: 90, maximumPermissible: 90, defaultLevel: 60, shortName: "Spots", displayRank: 2, hardwareType: 101, dimmable: false, hardwareChanged: false, legacyKey: 203 },
    { id: 4, name: "Kitchen Blind", roomId: 3, module: "Module 8000 / Ch1", kind: "Accessory", level: 0, moduleId: 8000, moduleIndex: 1, channelIndex: 1, controllerChannel: 17, accessoryModule: "Blind controller", accessoryType: 1, minimum: 0, maximum: 100, maximumPermissible: 100, defaultLevel: 0, shortName: "Blind", displayRank: 3, hardwareType: 0, dimmable: false, hardwareChanged: false, legacyKey: 204 },
  ];

  const switches = [
    {
      id: 1, name: "Lounge Switch", roomId: 2, kind: "8 scene", buttons: 11, type: 15, number: 1,
      shortName: "Lounge SW", displayRank: 0, hardwareType: 15, legacyKey: 301,
      basic: {
        channelIds: [1, 2],
        assignOn: true, assignOff: true, assignDimming: true, assignChannelDimming: false,
        onTime: 1, offTime: 2, offPriority: 0, onPriority: true,
        channelSettings: {
          1: { assignOn: true, assignOff: true, assignDimming: true, assignChannelDimming: false, onPriority: true, offPriority: false, onFade: 1, offFade: 2 },
          2: { assignOn: true, assignOff: false, assignDimming: false, assignChannelDimming: true, onPriority: true, offPriority: false, onFade: 0.5, offFade: 3 },
        },
      },
    },
    {
      id: 2, name: "Kitchen Switch", roomId: 3, kind: "4 scene", buttons: 7, type: 13, number: 2,
      shortName: "Kitchen SW", displayRank: 1, hardwareType: 13, legacyKey: 302,
      basic: {
        channelIds: [3],
        assignOn: true, assignOff: true, assignDimming: false, assignChannelDimming: false,
        onTime: 0, offTime: 0, offPriority: 1, onPriority: false,
        channelSettings: {
          3: { assignOn: true, assignOff: true, assignDimming: false, assignChannelDimming: false, onPriority: false, offPriority: true, onFade: 0, offFade: 0 },
        },
      },
    },
  ];

  const sceneGroups = [
    { id: 1, name: "Downstairs", shortName: "Down", parentId: null, icon: "/flexidim/rooms/0.png", displayRank: 0, legacyKey: 401 },
    { id: 2, name: "Evening", shortName: "Eve", parentId: 1, icon: "/flexidim/rooms/3.png", displayRank: 1, legacyKey: 402 },
  ];

  const scenes = [
    {
      id: 1, name: "Relax", shortName: "Relax", group: "Evening", groupId: 2, folderPath: ["Downstairs", "Evening"],
      levels: { 1: 40, 2: 25 },
      channelSettings: {
        1: { brightness: 40, fadeTime: 2, relativePercent: false, use100PercentTime: false, delay: 0, flags: 0 },
        2: { brightness: 25, fadeTime: 4, relativePercent: true, use100PercentTime: false, delay: 1.5, flags: 0x80 },
      },
      fade: 4, enabled: true, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: "",
      autoStart: false, nextSceneId: 2, nextSceneMode: 1, nextSceneTime: 120, nextSceneDay: 0,
      previousSceneId: undefined, extenderSceneId: undefined, runExtenderFirst: false, beginNewSequence: false,
      period1: 0, period2: 0, stateFlag: 0, flags: 0, legacyKey: 403, displayRank: 4, locked: false, sceneType: 0,
    },
    {
      id: 2, name: "Bright", shortName: "Bright", group: "Downstairs", groupId: 1, folderPath: ["Downstairs"],
      levels: { 1: 100, 3: 100 },
      channelSettings: {
        1: { brightness: 100, fadeTime: 0.5, relativePercent: false, use100PercentTime: true, delay: 0, flags: 0x10 },
        3: { brightness: 100, fadeTime: 0.5, relativePercent: false, use100PercentTime: false, delay: 0, flags: 0 },
      },
      fade: 1, enabled: true, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: "",
      autoStart: true, nextSceneId: undefined, nextSceneMode: -1, nextSceneTime: 0, nextSceneDay: 0,
      previousSceneId: 1, extenderSceneId: undefined, runExtenderFirst: false, beginNewSequence: true,
      period1: 1, period2: 0, stateFlag: 2, flags: 0xa0, legacyKey: 404, displayRank: 1, locked: true, sceneType: 0,
    },
  ];

  const periods = [
    { id: 1, name: "Evenings", start: "17:30", end: "23:00", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], enabled: true, startMode: 0, endMode: 0, legacyIndex: 0 },
    // Real archives carry unnamed period rows; they must survive.
    { id: 2, name: "", start: "06:00", end: "08:30", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], enabled: true, startMode: 1, endMode: 2, legacyIndex: 1 },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: index + 3,
      name: "",
      start: "00:00",
      end: "00:00",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      enabled: true,
      startMode: 0,
      endMode: 0,
      legacyIndex: index + 2,
    })),
  ];

  const stateFlags = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    name: index === 0 ? "Guests present" : "",
    legacyIndex: index + 10,
  }));

  const users = [
    { id: 1, name: "Owner", remote: false, changes: true, key: "OWNERKEY01234567", securityCode: "OWNERKEY01234567", legacyKey: 501, roomIds: [], switchIds: [], roomAccess: ["Lounge", "Kitchen"], accessCount: 2, profileVersion: 3, profileStatus: "imported" },
  ];

  const assignments = [
    { switchId: 1, button: 1, sceneId: 1 },
    { switchId: 1, button: 2, sceneId: 2 }, // second press of physical button 1
    { switchId: 2, button: 1, sceneId: 2 },
  ];

  return {
    site,
    configurations: [
      { id: 1, siteId: site.id, name: site.name, description: site.description, lastUpdated: site.updatedAt },
    ],
    activeConfigId: 1,
    rooms,
    channels,
    switches,
    sceneGroups,
    scenes,
    deletedScenes: [],
    periods,
    stateFlags,
    users,
    assignments,
    modules: [
      { id: 7000, name: "Module 7000", bus: "A", enabled: true, pending: false, position: 0 },
      { id: 7010, name: "Module 7010", bus: "A", enabled: true, pending: false, position: 1 },
      { id: 8000, name: "Module 8000", bus: "B", enabled: true, pending: false, position: 2 },
    ],
    deletedItems: [],
  };
}
