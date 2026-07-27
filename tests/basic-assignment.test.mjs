import assert from "node:assert/strict";
import test from "node:test";
import {
  compileBasicAssignments,
  compileSwitchAssignment,
  fadeTicks,
  moveAssignmentChannel,
  onOffPriority,
} from "../app/basic-assignment.ts";
import {
  BUS_B_FIRST_MODULE_NUMBER,
  controllerModuleNumber,
  moduleNumberToBusPosition,
} from "../app/flexidim-addressing.mjs";
import { buildGoldenAppData } from "./golden-app-data.mjs";

test("compiled order follows the stored bs0..bsN array, not channel id order", () => {
  const data = buildGoldenAppData();
  // Store the channels deliberately out of numeric order.
  data.switches[0].basic.channelIds = [2, 1];
  const compiled = compileSwitchAssignment(data.switches[0], data);
  assert.deepEqual(
    compiled.channels.map((channel) => channel.channelId),
    [2, 1],
    "compileConfig walks bsaChannels in array order; sorting would change what the controller receives",
  );
  assert.deepEqual(
    compiled.channels.map((channel) => channel.order),
    [0, 1],
  );
});

test("on/off priority is a single switch-level flag", () => {
  const data = buildGoldenAppData();
  // The golden switch 1 has onPriority true, switch 2 false.
  assert.equal(onOffPriority(data.switches[0]), true);
  assert.equal(onOffPriority(data.switches[1]), false);
  assert.equal(compileSwitchAssignment(data.switches[0], data).onOffPriority, true);
  assert.equal(compileSwitchAssignment(data.switches[1], data).onOffPriority, false);
});

test("a switch's priority applies to the whole switch, not per channel", () => {
  const data = buildGoldenAppData();
  const compiled = compileSwitchAssignment(data.switches[0], data);
  // There is exactly one `op` in the archive, so there is exactly one flag on
  // the compiled record and none on its channels.
  assert.equal(typeof compiled.onOffPriority, "boolean");
  for (const channel of compiled.channels)
    assert.equal("onOffPriority" in channel, false);
});

test("per-channel flags and fades come from the channel, falling back to the switch", () => {
  const data = buildGoldenAppData();
  const compiled = compileSwitchAssignment(data.switches[0], data);
  const [first, second] = compiled.channels;
  assert.deepEqual(
    [first.assignOn, first.assignOff, first.assignDimming, first.assignChannelDimming],
    [true, true, true, false],
  );
  assert.deepEqual(
    [second.assignOn, second.assignOff, second.assignDimming, second.assignChannelDimming],
    [true, false, false, true],
  );
  assert.equal(first.onFade, 1);
  assert.equal(second.onFade, 0.5);
});

test("fades compile to the controller's half-second ticks", () => {
  assert.equal(fadeTicks(0), 0);
  assert.equal(fadeTicks(0.5), 1);
  assert.equal(fadeTicks(1), 2);
  assert.equal(fadeTicks(3), 6);
  // Negative and missing values cannot become negative tick counts.
  assert.equal(fadeTicks(-5), 0);
  assert.equal(fadeTicks(undefined), 0);
  // Sub-tick values round rather than truncate to zero.
  assert.equal(fadeTicks(0.3), 1);

  const data = buildGoldenAppData();
  const compiled = compileSwitchAssignment(data.switches[0], data);
  assert.equal(compiled.channels[0].onFadeTicks, 2);
  assert.equal(compiled.channels[1].onFadeTicks, 1);
  assert.equal(compiled.channels[1].offFadeTicks, 6);
});

test("compiled channels carry the controller address, not the logical id", () => {
  const data = buildGoldenAppData();
  const compiled = compileSwitchAssignment(data.switches[1], data);
  // Golden channel 3 sits on the second module, controller address 9.
  assert.equal(compiled.channels[0].channelId, 3);
  assert.equal(compiled.channels[0].controllerChannel, 9);
});

test("a basic assignment referencing a deleted channel drops it instead of emitting a hole", () => {
  const data = buildGoldenAppData();
  data.switches[0].basic.channelIds = [1, 999, 2];
  const compiled = compileSwitchAssignment(data.switches[0], data);
  assert.deepEqual(
    compiled.channels.map((channel) => channel.channelId),
    [1, 2],
  );
  // Order must close up so the compiled stream has no gap.
  assert.deepEqual(
    compiled.channels.map((channel) => channel.order),
    [0, 1],
  );
});

test("every switch compiles, in configuration order", () => {
  const data = buildGoldenAppData();
  const compiled = compileBasicAssignments(data);
  assert.deepEqual(
    compiled.map((entry) => entry.switchId),
    [1, 2],
  );
  assert.deepEqual(
    compiled.map((entry) => entry.switchNumber),
    [1, 2],
  );
});

test("a switch with no basic assignment compiles to an empty channel list", () => {
  const data = buildGoldenAppData();
  delete data.switches[0].basic;
  const compiled = compileSwitchAssignment(data.switches[0], data);
  assert.deepEqual(compiled.channels, []);
  assert.equal(compiled.onOffPriority, false);
});

test("moving a channel changes the compiled order and nothing else", () => {
  const data = buildGoldenAppData();
  const moved = moveAssignmentChannel(data.switches[0], 2, -1);
  assert.deepEqual(moved.basic.channelIds, [2, 1]);
  // The settings map is untouched: moving is not editing.
  assert.deepEqual(
    Object.keys(moved.basic.channelSettings).sort(),
    Object.keys(data.switches[0].basic.channelSettings).sort(),
  );
  assert.deepEqual(
    compileSwitchAssignment(moved, data).channels.map((c) => c.channelId),
    [2, 1],
  );
});

test("moving past either end is a no-op rather than a wrap", () => {
  const data = buildGoldenAppData();
  const wallSwitch = data.switches[0];
  assert.deepEqual(
    moveAssignmentChannel(wallSwitch, 1, -1).basic.channelIds,
    [1, 2],
  );
  assert.deepEqual(
    moveAssignmentChannel(wallSwitch, 2, 1).basic.channelIds,
    [1, 2],
  );
  // An unknown channel cannot reorder anything.
  assert.deepEqual(
    moveAssignmentChannel(wallSwitch, 999, -1).basic.channelIds,
    [1, 2],
  );
});

// --- Module numbering (recovered from moduleForModuleNumber:) ---

test("bus A numbers from 1 and bus B from 16", () => {
  // The bus-B search initialises its counter to 0x10 and indexes modulesB as
  // number-15, so 16 is the first bus-B module and bus A holds at most 15.
  assert.equal(controllerModuleNumber("A", 0), 1);
  assert.equal(controllerModuleNumber("A", 14), 15);
  assert.equal(controllerModuleNumber("B", 0), BUS_B_FIRST_MODULE_NUMBER);
  assert.equal(controllerModuleNumber("B", 0), 16);
  assert.equal(controllerModuleNumber("B", 3), 19);
  // An unplaced module has no number, matching the -1 the app returns.
  assert.equal(controllerModuleNumber("A", -1), -1);
});

test("a module number round-trips back to its bus and position", () => {
  for (const [bus, position] of [
    ["A", 0],
    ["A", 14],
    ["B", 0],
    ["B", 7],
  ]) {
    const number = controllerModuleNumber(bus, position);
    assert.deepEqual(moduleNumberToBusPosition(number), {
      bus,
      positionInBus: position,
    });
  }
});

test("module numbers the controller would not resolve are reported as unresolvable", () => {
  assert.equal(moduleNumberToBusPosition(0), undefined);
  assert.equal(moduleNumberToBusPosition(-1), undefined);
  assert.equal(moduleNumberToBusPosition(1.5), undefined);
});

test("the two buses share one module-number space without colliding", () => {
  const numbers = new Set();
  for (let position = 0; position < 15; position += 1)
    numbers.add(controllerModuleNumber("A", position));
  for (let position = 0; position < 15; position += 1)
    numbers.add(controllerModuleNumber("B", position));
  assert.equal(numbers.size, 30, "bus A and bus B numbers must not overlap");
});
