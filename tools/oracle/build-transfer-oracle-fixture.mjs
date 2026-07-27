// Build a wholly synthetic type-0 archive for the original-app transfer oracle.
// The ordinary golden fixture deliberately covers Bus B, which a type-0
// controller cannot address. This derivative keeps only Bus A so the iOS
// compiler can exercise its plaintext type-0 transfer path. This fixture is for
// transfer framing/state evidence; its from-scratch basic-assignment archive
// semantics do not yet round-trip into a byte-identical web-compiled image.

import fs from "node:fs";
import { buildLegacyArchive } from "../../app/fd4cfg-export.ts";
import { buildGoldenAppData } from "../../tests/golden-app-data.mjs";

const output = process.argv[2];
const includeSwitches = process.argv.includes("--include-switches");
const includeUsers = process.argv.includes("--include-users");
const siteIdArgument = process.argv.find((argument) =>
  argument.startsWith("--site-id="));
const distinctProfileLabels = process.argv.includes("--distinct-profile-labels");
const switchTypesArgument = process.argv.find((argument) =>
  argument.startsWith("--switch-types="));
const switchNumbersArgument = process.argv.find((argument) =>
  argument.startsWith("--switch-numbers="));
const nonDimmableChannels = process.argv.includes("--non-dimmable-channels");
const channelHardwareTypesArgument = process.argv.find((argument) =>
  argument.startsWith("--channel-hardware-types="));
const channelAccessoryTypesArgument = process.argv.find((argument) =>
  argument.startsWith("--channel-accessory-types="));
const wirelessGatewaysArgument = process.argv.find((argument) =>
  argument.startsWith("--wireless-gateways="));
const profileVersionsArgument = process.argv.find((argument) =>
  argument.startsWith("--profile-versions="));
if (!output) {
  console.error("usage: node --experimental-strip-types tools/oracle/build-transfer-oracle-fixture.mjs <output.fd4cfg>");
  process.exit(64);
}

const data = buildGoldenAppData();
const busBIds = new Set(
  data.modules.filter((module) => module.bus === "B").map((module) => module.id),
);
const removedChannelIds = new Set(
  data.channels
    .filter((channel) => busBIds.has(channel.moduleId))
    .map((channel) => channel.id),
);

data.site.id = siteIdArgument?.slice("--site-id=".length) || "FD4-GOLD";
data.site.siteType = 0;
const activeConfiguration =
  data.configurations?.find(
    (configuration) => configuration.id === data.activeConfigId,
  ) ?? data.configurations?.[0];
if (activeConfiguration) {
  activeConfiguration.siteId = data.site.id;
  activeConfiguration.controllerCode = "CFG10001";
}
// The standalone oracle dylib has no application resource bundle from which
// to load a named .DST rule file.
data.site.dst = "No Daylight Saving";
data.site.moduleOrderB = [];
if (wirelessGatewaysArgument) {
  data.site.wirelessGateways = wirelessGatewaysArgument
    .slice("--wireless-gateways=".length)
    .split(",")
    .filter(Boolean)
    .map((address) => ({ address, count: 1 }));
}
data.modules = data.modules.filter((module) => !busBIds.has(module.id));
data.channels = data.channels.filter((channel) => !removedChannelIds.has(channel.id));
for (const channel of data.channels) {
  // Use the baseline dimmable row that every type-0 module family exposes.
  channel.hardwareType = 1;
  channel.kind = "Dimmable";
  channel.dimmable = true;
  channel.accessoryType = 0;
  channel.accessoryModule = "None";
  if (nonDimmableChannels) channel.dimmable = false;
}
if (channelHardwareTypesArgument) {
  const hardwareTypes = channelHardwareTypesArgument
    .slice("--channel-hardware-types=".length)
    .split(",")
    .map(Number);
  if (
    hardwareTypes.length !== data.channels.length ||
    hardwareTypes.some((value) => !Number.isInteger(value))
  )
    throw new Error(
      "--channel-hardware-types must provide one integer per synthetic channel",
    );
  data.channels.forEach((channel, index) => {
    channel.hardwareType = hardwareTypes[index];
  });
}
if (channelAccessoryTypesArgument) {
  const accessoryTypes = channelAccessoryTypesArgument
    .slice("--channel-accessory-types=".length)
    .split(",")
    .map(Number);
  if (
    accessoryTypes.length !== data.channels.length ||
    accessoryTypes.some((value) => !Number.isInteger(value))
  )
    throw new Error(
      "--channel-accessory-types must provide one integer per synthetic channel",
    );
  data.channels.forEach((channel, index) => {
    channel.accessoryType = accessoryTypes[index];
  });
}
for (const scene of data.scenes) {
  // The legacy compiler indexes a mode table directly; use an explicit
  // no-follow mode instead of the web model's -1 "unset" sentinel.
  scene.nextSceneMode = 0;
  scene.nextSceneId = undefined;
  scene.previousSceneId = undefined;
  scene.extenderSceneId = undefined;
  for (const setting of Object.values(scene.channelSettings)) {
    setting.relativePercent = false;
    setting.flags &= ~0x80;
  }
  for (const channelId of removedChannelIds) {
    delete scene.levels[channelId];
    delete scene.channelSettings[channelId];
  }
}
for (const wallSwitch of data.switches) {
  wallSwitch.basic.channelIds = wallSwitch.basic.channelIds.filter(
    (channelId) => !removedChannelIds.has(channelId),
  );
  for (const channelId of removedChannelIds)
    delete wallSwitch.basic.channelSettings[channelId];
  // Keep a conservative, unambiguous from-scratch assignment: one channel
  // with On and Off actions. Richer combinations remain covered by the real
  // imported archive mutations, whose legacy ordering is known.
  const firstChannelId = wallSwitch.basic.channelIds[0];
  wallSwitch.basic.channelIds = firstChannelId ? [firstChannelId] : [];
  for (const channelId of Object.keys(wallSwitch.basic.channelSettings).map(Number)) {
    if (channelId !== firstChannelId) {
      delete wallSwitch.basic.channelSettings[channelId];
      continue;
    }
    wallSwitch.basic.channelSettings[channelId] = {
      ...wallSwitch.basic.channelSettings[channelId],
      assignOn: true,
      assignOff: true,
      assignDimming: false,
      assignChannelDimming: false,
    };
  }
  wallSwitch.basic.assignOn = true;
  wallSwitch.basic.assignOff = true;
  wallSwitch.basic.assignDimming = false;
  wallSwitch.basic.assignChannelDimming = false;
}
if (switchTypesArgument) {
  const switchTypes = switchTypesArgument
    .slice("--switch-types=".length)
    .split(",")
    .map(Number);
  if (
    switchTypes.length !== data.switches.length ||
    switchTypes.some((value) => !Number.isInteger(value))
  )
    throw new Error("--switch-types must provide one integer per synthetic switch");
  data.switches.forEach((wallSwitch, index) => {
    wallSwitch.type = switchTypes[index];
    wallSwitch.hardwareType = switchTypes[index];
  });
}
if (switchNumbersArgument) {
  const switchNumbers = switchNumbersArgument
    .slice("--switch-numbers=".length)
    .split(",")
    .map(Number);
  if (
    switchNumbers.length !== data.switches.length ||
    switchNumbers.some((value) => !Number.isInteger(value))
  )
    throw new Error("--switch-numbers must provide one integer per synthetic switch");
  data.switches.forEach((wallSwitch, index) => {
    wallSwitch.number = switchNumbers[index];
  });
}
if (distinctProfileLabels) {
  data.rooms.forEach((room, index) => {
    room.shortName = `RoomShort${index + 1}`;
  });
  data.switches.forEach((wallSwitch, index) => {
    wallSwitch.shortName = `SwitchShort${index + 1}`;
  });
  data.scenes.forEach((scene, index) => {
    scene.shortName = `SceneShort${index + 1}`;
  });
  data.channels.forEach((channel, index) => {
    channel.shortName = `ChannelShort${index + 1}`;
  });
}
if (!includeSwitches) {
  data.switches = [];
  data.assignments = [];
}
if (!includeUsers) data.users = [];
else {
  const profileVersions = profileVersionsArgument
    ? profileVersionsArgument
        .slice("--profile-versions=".length)
        .split(",")
        .map(Number)
    : [];
  if (
    profileVersionsArgument &&
    (profileVersions.length !== data.users.length ||
      profileVersions.some((value) => !Number.isInteger(value)))
  )
    throw new Error("--profile-versions must provide one integer per synthetic user");
  for (const user of data.users) {
    // The legacy sender parses this as eight hexadecimal bytes, two characters
    // at a time. Keep synthetic fixtures valid without borrowing a real key.
    user.key = "0011223344556677";
    user.securityCode = user.key;
    user.roomAccess = ["Lounge", "Kitchen"].map((roomName) => {
      const roomKey = data.rooms.find((room) => room.name === roomName)?.legacyKey;
      const switchKey = data.switches.find(
        (wallSwitch) => wallSwitch.name === `${roomName} Switch`,
      )?.legacyKey;
      if (roomKey === undefined)
        throw new Error(`synthetic room ${roomName} has no legacy key`);
      return switchKey === undefined ? String(roomKey) : `${roomKey}|${switchKey}`;
    });
    user.accessCount = user.roomAccess.length;
    user.roomIds = ["Lounge", "Kitchen"].flatMap((roomName) => {
      const room = data.rooms.find((candidate) => candidate.name === roomName);
      return room ? [room.id] : [];
    });
    user.switchIds = data.switches
      .filter((wallSwitch) => user.roomIds.includes(wallSwitch.roomId))
      .map((wallSwitch) => wallSwitch.id);
    if (profileVersionsArgument)
      user.profileVersion = profileVersions[data.users.indexOf(user)];
  }
}

fs.writeFileSync(output, buildLegacyArchive(data));
console.log(`wrote synthetic type-0 oracle fixture: ${output}`);
