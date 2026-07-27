import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESSORY_TYPE_NAMES,
  ALL_CHANNEL_TYPE_NAMES,
  CHANNEL_TYPE_FAMILIES,
  SWITCH_TYPES,
  accessoryTypeName,
  channelSupportsColour,
  channelTypeFamily,
  channelTypeIsDimmable,
  channelTypeName,
  channelTypeOption,
  isBlindControl,
  switchTypeByCode,
  switchTypeByName,
} from "../app/channel-catalogue.ts";

test("every recovered family decodes and keeps its picker order", () => {
  assert.equal(CHANNEL_TYPE_FAMILIES.length, 4);
  for (const family of CHANNEL_TYPE_FAMILIES) {
    assert.ok(family.options.length > 0, `${family.id} has no options`);
    const positions = family.options.map((option) => option.displayPosition);
    assert.deepEqual(
      positions,
      [...positions].sort((left, right) => left - right),
      `${family.id} is not in display order`,
    );
    // Display positions are 1-based and contiguous in the iOS picker.
    assert.deepEqual(
      positions,
      positions.map((_, index) => index + 1),
      `${family.id} display positions are not contiguous`,
    );
  }
});

test("the general dimming family matches the recovered rows exactly", () => {
  // Paired directly against F2 in work/binary-findings.md: this pairing is what
  // pins column 2 as the load class, so a regression here invalidates the rest.
  const options = channelTypeFamily("generalDimming").options;
  assert.deepEqual(
    options.map((option) => [option.name, option.hw, option.loadClass]),
    [
      ["On/Off", 1, "onOff"],
      ["Dimmable", 2, "dimmable"],
      ["Hard fired dimmable", 38, "dimmable"],
      ["Full cycle dimmable", 103, "dimmable"],
      ["Hard fired on/off", 36, "onOff"],
      ["Full cycle on/off", 101, "onOff"],
    ],
  );
});

test("the protocol family carries plain DMX, the enhanced sub-modes and the accessory class", () => {
  const options = channelTypeFamily("protocolAndAccessory").options;
  assert.deepEqual(
    options.map((option) => option.name),
    ["DMX", "DALI", "Accessory", "Enhanced DMX", "Enhanced DALI"],
  );
  // "DMX" is a real type the earlier flat 14-name list omitted entirely.
  assert.ok(options.some((option) => option.name === "DMX"));
  // The enhanced variants are distinguished by the sub-mode column, and that
  // column is NOT an accessory-type index.
  assert.equal(
    options.find((option) => option.name === "Enhanced DMX").subMode,
    1,
  );
  assert.equal(
    options.find((option) => option.name === "Enhanced DALI").subMode,
    2,
  );
  // Accessory-ness lives in the load class.
  assert.equal(
    options.find((option) => option.name === "Accessory").loadClass,
    "accessory",
  );
});

test("the phase-control family keeps all six rows and reports its name binding as unproven", () => {
  const family = channelTypeFamily("phaseControl");
  // Six selectable rows over five names, with column 5 repeating, so the
  // label-to-row binding cannot be proven the way the other families' can.
  assert.equal(family.options.length, 6);
  assert.equal(family.nameBindingVerified, false);
  // The hardware facts are still verified: stored codes, load classes and the
  // LED flag come straight from the recovered rows.
  assert.deepEqual(
    family.options.map((option) => [
      option.hw,
      option.loadClass,
      option.ledVariant,
    ]),
    [
      [3, "onOff", false],
      [1, "dimmable", false],
      [1, "dimmable", false],
      [2, "dimmable", true],
      [17, "dimmable", false],
      [18, "dimmable", true],
    ],
  );
  // Two rows carry hw 1. Keeping both is deliberate: dropping one would
  // silently shorten an installer's picker.
  assert.equal(family.options.filter((option) => option.hw === 1).length, 2);
});

test("the families whose rows and names pair one-to-one are marked verified", () => {
  for (const id of ["onOffOnly", "generalDimming", "protocolAndAccessory"])
    assert.equal(
      channelTypeFamily(id).nameBindingVerified,
      true,
      `${id} should pair bijectively`,
    );
});

test("the same display name can store a different hw code per family", () => {
  // "On/Off" is hw 0, 1 and 3 depending on the module family. A single flat
  // list cannot represent this, which is why the catalogue is family-scoped.
  assert.equal(channelTypeOption("On/Off", "onOffOnly").hw, 0);
  assert.equal(channelTypeOption("On/Off", "generalDimming").hw, 1);
  assert.equal(channelTypeOption("On/Off", "phaseControl").hw, 3);
});

test("a stored hw code resolves within its own family before any other", () => {
  // hw 2 means different things per family, which is the whole reason the
  // lookup is family-scoped rather than global.
  assert.equal(channelTypeName(2, "generalDimming"), "Dimmable");
  assert.notEqual(channelTypeName(2, "phaseControl"), "Dimmable");
  // Unknown codes are reported as unknown rather than silently mislabelled.
  assert.equal(channelTypeName(999, "generalDimming"), undefined);
  assert.equal(channelTypeName(undefined), undefined);
});

test("a code absent from the requested family still resolves from the catalogue", () => {
  // 17 and 18 only exist in phaseControl. Asking as a general module must still
  // name them rather than showing nothing.
  assert.ok(channelTypeName(17, "generalDimming"));
  assert.ok(channelTypeName(18, "generalDimming"));
  // hw 101 exists only in generalDimming, so it resolves from any family.
  assert.equal(channelTypeName(101, "phaseControl"), "Full cycle on/off");
});

test("dimmable is derived from the load class, never stored separately", () => {
  assert.equal(channelTypeIsDimmable(2, "generalDimming"), true);
  assert.equal(channelTypeIsDimmable(38, "generalDimming"), true);
  assert.equal(channelTypeIsDimmable(1, "generalDimming"), false);
  assert.equal(channelTypeIsDimmable(36, "generalDimming"), false);
  assert.equal(channelTypeIsDimmable(101, "generalDimming"), false);
  assert.equal(channelTypeIsDimmable(999), undefined);
});

test("accessory types are exactly the two recovered values, with no None entry", () => {
  assert.deepEqual([...ACCESSORY_TYPE_NAMES], ["1-10V", "Blind control"]);
  assert.equal(accessoryTypeName(0), "1-10V");
  assert.equal(accessoryTypeName(1), "Blind control");
  assert.equal(accessoryTypeName(2), undefined);
});

test("blind commands apply only to a blind-control accessory", () => {
  assert.equal(isBlindControl(1), true);
  assert.equal(isBlindControl(0), false);
  assert.equal(isBlindControl(undefined), false);
});

test("the switch catalogue includes the Not used code-0 type", () => {
  assert.deepEqual(
    SWITCH_TYPES.map((entry) => [entry.name, entry.code]),
    [
      ["Not used", 0],
      ["2 channel opto", 2],
      ["8 channel opto", 8],
      ["4 scene", 13],
      ["8 scene", 15],
    ],
  );
  assert.equal(switchTypeByCode(0).name, "Not used");
  assert.equal(switchTypeByCode(0).buttons, 0);
  assert.equal(switchTypeByName("8 scene").code, 15);
  assert.equal(switchTypeByName("8 scene").buttons, 11);
  assert.equal(switchTypeByCode(99), undefined);
});

test("the flat name list covers every family without duplicates", () => {
  const names = ALL_CHANNEL_TYPE_NAMES;
  assert.equal(new Set(names).size, names.length);
  for (const family of CHANNEL_TYPE_FAMILIES)
    for (const option of family.options) assert.ok(names.includes(option.name));
  // The two accessory types are not output types and must not leak in.
  for (const accessory of ACCESSORY_TYPE_NAMES)
    assert.equal(
      names.includes(accessory),
      false,
      `${accessory} is an accessory type, not an output type`,
    );
});

test("only DMX and DALI output types can carry colour or Kelvin", () => {
  // A DMX address or DALI group can drive an RGB or tunable-white luminaire.
  assert.equal(channelSupportsColour(0, "protocolAndAccessory"), true);
  for (const name of ["DMX", "Enhanced DMX", "DALI", "Enhanced DALI"]) {
    const option = channelTypeOption(name, "protocolAndAccessory");
    assert.equal(
      channelSupportsColour(option.hw, "protocolAndAccessory"),
      true,
      `${name} should be colour capable`,
    );
  }
});

test("intensity-only output types are not offered colour controls", () => {
  // A triac dimmer or relay has one intensity and no colour, so offering a
  // colour wheel would invent a capability the fixture does not have.
  for (const name of [
    "On/Off",
    "Dimmable",
    "Hard fired dimmable",
    "Full cycle on/off",
  ]) {
    const option = channelTypeOption(name, "generalDimming");
    assert.equal(
      channelSupportsColour(option.hw, "generalDimming"),
      false,
      `${name} must not be colour capable`,
    );
  }
  assert.equal(channelSupportsColour(undefined), false);
  assert.equal(channelSupportsColour(999), false);
});
