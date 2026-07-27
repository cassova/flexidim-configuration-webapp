import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFd4XltDocument,
  parseFd4XltDocument,
  parseLegacyFd4Config,
} from "../app/fd4cfg.ts";
import { configContentCrc } from "../app/transfer-readiness.ts";
import { buildLegacyArchive } from "../app/fd4cfg-export.ts";
import { buildGoldenAppData } from "./golden-app-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "golden.fd4cfg");
const snapshotPath = path.join(here, "fixtures", "golden-import.json");

const toArrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const importBytes = (bytes) => parseLegacyFd4Config(toArrayBuffer(bytes));
const roundTrip = (appData) => importBytes(buildLegacyArchive(appData));
const withoutDerivedProfileOrder = (appData) => ({
  ...appData,
  channels: appData.channels.map((channel) => {
    const copy = { ...channel };
    delete copy.profileOrder;
    return copy;
  }),
});

test("golden fixture is a valid NSKeyedArchiver binary plist", () => {
  const bytes = readFileSync(fixturePath);
  assert.equal(bytes.subarray(0, 8).toString("latin1"), "bplist00");
  const imported = importBytes(bytes);
  assert.equal(imported.site.id, "FD4-GOLD");
});

test("golden fixture import matches the field-by-field snapshot", () => {
  const imported = importBytes(readFileSync(fixturePath));
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), snapshot);
});

test("import → export → import is lossless for the golden fixture", () => {
  const first = importBytes(readFileSync(fixturePath));
  const second = roundTrip(first);
  assert.deepEqual(second, first);
});

test("exports controller-significant fields exactly", () => {
  const imported = importBytes(readFileSync(fixturePath));
  const golden = buildGoldenAppData();

  // Both module buses import in stored controller-address order.
  assert.deepEqual(imported.site.moduleOrderA, [7000, 7010]);
  assert.deepEqual(imported.site.moduleOrderB, [8000]);
  assert.deepEqual(
    imported.modules.map((module) => [module.id, module.bus]),
    [[7000, "A"], [7010, "A"], [8000, "B"]],
  );
  // Channel wire addresses derive from the stored module positions.
  assert.deepEqual(
    imported.channels.map((channel) => channel.controllerChannel),
    [1, 2, 9, 17],
  );
  // Hardware limits and accessory types survive.
  assert.deepEqual(
    imported.channels.map((channel) => [
      channel.minimum,
      channel.maximum,
      channel.maximumPermissible,
      channel.defaultLevel,
      channel.accessoryType,
      channel.dimmable,
    ]),
    golden.channels.map((channel) => [
      channel.minimum,
      channel.maximum,
      channel.maximumPermissible,
      channel.defaultLevel,
      channel.accessoryType,
      channel.dimmable,
    ]),
  );
  // The iOS table always has ten timed rows. Unnamed rows survive with their
  // solar modes, and the following 25 archived objects are state-flag labels.
  assert.equal(imported.periods.length, 10);
  assert.equal(imported.periods[1].name, "");
  assert.equal(imported.periods[1].startMode, 1);
  assert.equal(imported.periods[1].endMode, 2);
  assert.equal(imported.stateFlags.length, 25);
  assert.equal(imported.stateFlags[0].name, "Guests present");
  // Scene timing, relative-percent and 100%-time flags survive.
  const relax = imported.scenes.find((scene) => scene.name === "Relax");
  assert.equal(relax.channelSettings[2].relativePercent, true);
  assert.equal(relax.channelSettings[2].delay, 1.5);
  const bright = imported.scenes.find((scene) => scene.name === "Bright");
  assert.equal(bright.channelSettings[1].use100PercentTime, true);
  assert.equal(bright.locked, true);
  assert.equal(bright.autoStart, true);
  assert.equal(bright.beginNewSequence, true);
  assert.equal(bright.previousSceneId, relax.id);
  assert.equal(relax.nextSceneId, bright.id);
  // Users keep their key, access order and profile version.
  assert.equal(imported.users[0].key, "OWNERKEY01234567");
  assert.deepEqual(imported.users[0].roomAccess, ["Lounge", "Kitchen"]);
  assert.equal(imported.users[0].profileVersion, 3);
  // Button assignments keep first/second-press slots.
  assert.deepEqual(imported.assignments, [
    { switchId: 1, button: 1, sceneId: relax.id },
    { switchId: 1, button: 2, sceneId: bright.id },
    { switchId: 2, button: 1, sceneId: bright.id },
  ]);
});

test("web edits survive an export to the iOS archive", () => {
  const imported = importBytes(readFileSync(fixturePath));
  imported.site.name = "Renamed House";
  imported.channels[0].name = "Renamed Channel";
  imported.channels[0].defaultLevel = 55;
  imported.scenes[0].channelSettings[1].brightness = 33;
  imported.scenes[0].levels[1] = 33;
  imported.configurations[0].controllerCode = "CTRL0001";
  // Editing the resolved access projection must rebuild the legacy rmN path
  // from stable room/switch archive keys, not preserve stale raw strings.
  imported.users[0].roomIds = [2];
  imported.users[0].switchIds = [1];
  // Remove one button assignment: it must not resurface from raw slots.
  imported.assignments = imported.assignments.filter(
    (assignment) =>
      !(assignment.switchId === 2 && assignment.button === 1),
  );
  const again = roundTrip(imported);
  assert.equal(again.site.name, "Renamed House");
  assert.equal(again.channels[0].name, "Renamed Channel");
  assert.equal(again.channels[0].defaultLevel, 55);
  assert.equal(again.scenes[0].channelSettings[1].brightness, 33);
  assert.equal(again.configurations[0].controllerCode, "CTRL0001");
  assert.deepEqual(again.users[0].roomIds, [2]);
  assert.deepEqual(again.users[0].switchIds, [1]);
  assert.deepEqual(again.users[0].roomAccess, ["102|301"]);
  assert.deepEqual(
    again.assignments.filter((assignment) => assignment.switchId === 2),
    [],
  );
});

test("unknown archive fields survive import → export → import", () => {
  const imported = importBytes(readFileSync(fixturePath));
  // Simulate fields from a newer iOS build than the web model understands:
  // an unmodeled per-object key and a trailing top-level slot.
  imported.channels[0].legacy.zz9 = 4321;
  imported.switches[0].legacy.settings.zz8 = "future-switch-field";
  const rawTop = imported.site.legacy.top;
  const count = (slot) => Number(rawTop[`$${slot}`]);
  const extraBase = 30 + rawTop.modc + rawTop.modcB + rawTop.hwc;
  const switchCountSlot = extraBase + 4;
  const sceneCountSlot = switchCountSlot + 1 + count(switchCountSlot);
  const periodCountSlot = sceneCountSlot + 1 + count(sceneCountSlot);
  const userCountSlot = periodCountSlot + 1 + count(periodCountSlot);
  const trailingSlot = userCountSlot + 1 + count(userCountSlot);
  rawTop[`$${trailingSlot}`] = "trailing-future-field";

  const again = roundTrip(imported);
  assert.equal(again.channels[0].legacy.zz9, 4321);
  assert.equal(again.switches[0].legacy.settings.zz8, "future-switch-field");
  assert.equal(again.site.legacy.top[`$${trailingSlot}`], "trailing-future-field");
  // And the round trip of the modified model is itself stable.
  assert.deepEqual(roundTrip(again), again);
});

test("a from-scratch web site exports without any legacy archive", () => {
  const golden = buildGoldenAppData();
  const imported = roundTrip(golden);
  assert.equal(imported.site.name, golden.site.name);
  assert.equal(imported.site.securityCode, golden.site.securityCode);
  assert.deepEqual(imported.site.moduleOrderA, golden.site.moduleOrderA);
  assert.deepEqual(imported.site.moduleOrderB, golden.site.moduleOrderB);
  assert.equal(imported.channels.length, golden.channels.length);
  assert.equal(imported.scenes.length, golden.scenes.length);
  assert.equal(imported.periods.length, golden.periods.length);
  assert.equal(imported.stateFlags.length, golden.stateFlags.length);
  assert.equal(imported.users.length, golden.users.length);
  assert.equal(imported.assignments.length, golden.assignments.length);
  // A regenerated archive must round-trip losslessly from then on.
  assert.deepEqual(roundTrip(imported), imported);
});

test(".fd4xlt translation documents create a fresh starting-point config", () => {
  // Recovered format: text sections, not a binary archive. Scene fields on a
  // switch-scene row are the first and second press of one physical button.
  const document = [
    "#SWITCHES <number> <Type> <name/location>",
    "# Type 15 = 8 scene : Type 13 = 4 scene : Type 2 = 2 channel opto : Type 8 = 8 channel opto",
    "1,15,Hall Switch",
    "2,13,Porch Switch",
    "#CHANNELS <number> <dimmable> <name/location>",
    "1,1,Hall Ceiling",
    "2,0,Porch Light",
    "#SWITCH-SCENES <switch number:button number> <scene1 name/location> <scene2 name/location>",
    "1:1,Welcome,All Off",
    "2:3,Porch On,",
  ].join("\r\n");
  const buffer = new TextEncoder().encode(document).buffer;
  const imported = parseLegacyFd4Config(buffer);
  assert.equal(imported.switches.length, 2);
  assert.equal(imported.switches[0].type, 15);
  assert.equal(imported.switches[0].buttons, 11);
  assert.equal(imported.channels.length, 2);
  assert.equal(imported.channels[1].dimmable, false);
  // Fresh starting point: no basic assignments content, periods or users.
  assert.equal(imported.periods.length, 0);
  assert.equal(imported.users.length, 0);
  assert.equal(imported.configurations[0].description, "Created as starting point");
  // Physical button 1 → logical slots 1 and 2; button 3 → logical slot 5.
  const welcome = imported.scenes.find((scene) => scene.name === "Welcome");
  const allOff = imported.scenes.find((scene) => scene.name === "All Off");
  const porchOn = imported.scenes.find((scene) => scene.name === "Porch On");
  assert.deepEqual(imported.assignments, [
    { switchId: 1, button: 1, sceneId: welcome.id },
    { switchId: 1, button: 2, sceneId: allOff.id },
    { switchId: 2, button: 5, sceneId: porchOn.id },
  ]);
  // Export → import round-trips the equipment and button map.
  const again = parseFd4XltDocument(buildFd4XltDocument(imported));
  assert.deepEqual(
    again.switches.map((item) => [item.number, item.type, item.name]),
    imported.switches.map((item) => [item.number, item.type, item.name]),
  );
  assert.deepEqual(
    again.channels.map((item) => [item.dimmable, item.name]),
    imported.channels.map((item) => [item.dimmable, item.name]),
  );
  assert.deepEqual(again.assignments, imported.assignments);
});

// The private reference archive is not part of the repository. When present
// locally, prove the round trip on real data without printing any of it.
const referencePath = process.env.FLEXIDIM_REFERENCE_ARCHIVE ?? "";
test(
  "import → export → import is lossless for the local reference archive",
  { skip: !existsSync(referencePath) },
  () => {
    const first = importBytes(readFileSync(referencePath));
    const second = roundTrip(first);
    try {
      // Foundation dictionary bucket order is intentionally re-derived by the
      // iOS importer after an export; it is transfer metadata rather than an
      // archived channel field. Everything actually stored must remain equal.
      assert.deepEqual(
        withoutDerivedProfileOrder(second),
        withoutDerivedProfileOrder(first),
      );
    } catch {
      // Do not let assert print private archive content.
      throw new Error(
        "Reference archive round trip changed the imported model",
      );
    }
    assert.equal(second.periods.length, first.periods.length);
  },
);

test("both module buses import without disturbing controller address order", () => {
  const imported = importBytes(readFileSync(fixturePath));

  // Bus assignment survives: the golden site has two bus-A modules and one
  // bus-B module, written to the archive as separate ID runs.
  assert.deepEqual(
    imported.modules.map((module) => [module.id, module.bus]),
    [
      [7000, "A"],
      [7010, "A"],
      [8000, "B"],
    ],
  );
  // Stored positions stay in the archive's own order, A then B. Sorting by
  // module id would reorder a site whose bus-B IDs sort below its bus-A IDs.
  assert.deepEqual(
    imported.modules.map((module) => module.position),
    [0, 1, 2],
  );
  assert.deepEqual(imported.site.moduleOrderA, [7000, 7010]);
  assert.deepEqual(imported.site.moduleOrderB, [8000]);

  // Channel addresses follow the combined stored order, so a bus-B channel
  // keeps the address the controller already uses for it.
  const addressFor = (id) =>
    imported.channels.find((channel) => channel.id === id)?.controllerChannel;
  assert.equal(addressFor(1), 1, "module 7000 channel 1");
  assert.equal(addressFor(3), 9, "module 7010 channel 1");
  assert.equal(addressFor(4), 17, "module 8000 (bus B) channel 1");
});

test("a bus-B site survives export and re-import with its buses intact", () => {
  const first = importBytes(readFileSync(fixturePath));
  const again = importBytes(Buffer.from(buildLegacyArchive(first)));
  assert.deepEqual(
    again.modules.map((module) => [module.id, module.bus, module.position]),
    first.modules.map((module) => [module.id, module.bus, module.position]),
  );
  assert.deepEqual(again.site.moduleOrderB, first.site.moduleOrderB);
  assert.deepEqual(
    again.channels.map((channel) => channel.controllerChannel),
    first.channels.map((channel) => channel.controllerChannel),
  );
});

test("the local checksum is stable across import → export → import", () => {
  // The whole point of a change-detection checksum is that it changes ONLY when
  // the configuration changes. It was previously computed with an
  // insertion-order-sensitive serialiser, so a round trip that reordered keys
  // inside the preserved `legacy` bags moved the checksum while the model stayed
  // structurally identical — the app reported a difference that did not exist.
  const first = importBytes(readFileSync(fixturePath));
  const second = roundTrip(first);
  assert.deepStrictEqual(second, first, "the round trip must be lossless");
  assert.equal(
    configContentCrc(second),
    configContentCrc(first),
    "identical models must produce identical checksums",
  );
});

test("the checksum ignores key order but still catches real edits", () => {
  const first = importBytes(readFileSync(fixturePath));
  // Same data, different key insertion order: must hash the same.
  const reordered = {
    ...first,
    channels: first.channels.map((channel) => {
      const flipped = {};
      for (const key of Object.keys(channel).reverse()) flipped[key] = channel[key];
      return flipped;
    }),
  };
  assert.equal(configContentCrc(reordered), configContentCrc(first));

  // A genuine change must still move it.
  const edited = {
    ...first,
    channels: first.channels.map((channel, index) =>
      index === 0 ? { ...channel, maximum: 77 } : channel,
    ),
  };
  assert.notEqual(configContentCrc(edited), configContentCrc(first));
});

test("array order still counts, because the controller depends on it", () => {
  // Module order sets channel addresses and basic-assignment order is the
  // compiled order, so reordering an array IS a change even though reordering
  // object keys is not.
  const first = importBytes(readFileSync(fixturePath));
  const swapped = {
    ...first,
    modules: [first.modules[1], first.modules[0], ...first.modules.slice(2)],
  };
  assert.notEqual(configContentCrc(swapped), configContentCrc(first));
});

test("export → import → export produces byte-identical files", () => {
  // The exporter is not expected to reproduce the ORIGINAL iOS file byte for
  // byte (it rebuilds the archive, and int widths and object ordering differ).
  // It must, however, be deterministic and self-consistent: exporting the model
  // twice, with an import in between, has to yield the same bytes. Otherwise a
  // "download config, re-import, download again" cycle would show spurious
  // differences to anyone diffing the files.
  const first = importBytes(readFileSync(fixturePath));
  const exportedOnce = Buffer.from(buildLegacyArchive(first));
  const reimported = importBytes(exportedOnce);
  const exportedTwice = Buffer.from(buildLegacyArchive(reimported));
  assert.equal(
    exportedTwice.equals(exportedOnce),
    true,
    "a second export of the same configuration must be byte-identical",
  );
});
