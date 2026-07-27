/**
 * The recovered FlexiDim channel/output/accessory catalogue.
 *
 * Everything here was read out of the iOS 2.97 arm64 binary: the app builds
 * parallel (display-name, encoded-row) array pairs — one pair per module /
 * channel hardware family — at 0x10005d030-0x10005d8d8. See
 * `work/binary-findings.md` "Q5 REVISED" for the disassembly and the proof of
 * each column's meaning.
 *
 * Two things matter for parity and are easy to get wrong:
 *
 *  1. There is no single flat output-type list. A family offers only its own
 *     types, and the same display name can carry a different stored `hw` code
 *     in a different family.
 *  2. Accessory type is a separate two-value field, not an entry in the output
 *     type list. A channel is accessory-controlled because its load class is
 *     `accessory`, not because of its accessory-type index.
 */

/** Load class, from column 2 of the encoded rows. */
export type LoadClass = "onOff" | "dimmable" | "accessory";

const LOAD_CLASS_BY_CODE: Record<number, LoadClass> = {
  1: "onOff",
  2: "dimmable",
  3: "accessory",
};

export type ChannelTypeOption = {
  /** Display name, exactly as the iOS picker shows it. */
  name: string;
  /** The value stored in the channel's `hw` archive field. */
  hw: number;
  loadClass: LoadClass;
  /** Set only on the LED variants of the leading/trailing-edge family. */
  ledVariant: boolean;
  /** 1-based position in the family's picker. */
  displayPosition: number;
  /** 0-based index into the family's display-name array. */
  nameIndex: number;
  /**
   * Discrete/"enhanced" sub-mode: 1 on Enhanced DMX, 2 on Enhanced DALI, else
   * 0. This is NOT an accessory-type index — see the findings note.
   */
  subMode: number;
};

export type ChannelTypeFamily = {
  id: string;
  description: string;
  options: ChannelTypeOption[];
  /**
   * Whether the row-to-display-name binding is proven for this family.
   *
   * It is proven when the family's rows and names are the same length and every
   * name is claimed exactly once — then column 5 can only be the name index.
   * Three of the four recovered families satisfy this. `phaseControl` does not:
   * it has six selectable rows over five names, with column 5 repeating. Its
   * hardware facts (stored code, load class, LED flag, order) are still
   * verified; only which label sits on which row is uncertain, so the app must
   * not present those labels as authoritative.
   */
  nameBindingVerified: boolean;
};

/**
 * The encoded rows, verbatim from the binary, with the family name list they
 * are paired against. Kept in this literal form so the table can be diffed
 * against a fresh disassembly without decoding anything first.
 */
const RECOVERED_FAMILIES: {
  id: string;
  description: string;
  names: string[];
  rows: string[];
}[] = [
  {
    id: "onOffOnly",
    description: "Switched output only",
    names: ["On/Off"],
    rows: ["0|1|0|1|0|0"],
  },
  {
    id: "generalDimming",
    description: "General-purpose dimming and switching module",
    names: [
      "On/Off",
      "Dimmable",
      "Hard fired dimmable",
      "Full cycle dimmable",
      "Hard fired on/off",
      "Full cycle on/off",
    ],
    rows: [
      "1|1|0|1|0|0",
      "2|2|0|2|1|0",
      "38|2|0|3|2|0",
      "103|2|0|4|3|0",
      "36|1|0|5|4|0",
      "101|1|0|6|5|0",
    ],
  },
  {
    id: "protocolAndAccessory",
    description: "DMX, DALI and accessory outputs",
    names: ["DMX", "Enhanced DMX", "DALI", "Enhanced DALI", "Accessory"],
    rows: [
      "0|2|0|1|0|0",
      "0|2|0|4|1|1",
      "0|2|0|2|2|0",
      "0|2|0|5|3|2",
      "0|3|0|3|4|0",
    ],
  },
  {
    id: "phaseControl",
    description: "Leading/trailing edge phase-control module",
    names: [
      "On/Off",
      "Leading edge",
      "Trailing edge",
      "L.Edge LED",
      "T.Edge LED",
    ],
    rows: [
      "3|1|0|1|0|0",
      "1|2|0|2|1|0",
      "1|2|0|3|1|0",
      "2|2|1|4|2|0",
      "17|2|0|5|3|0",
      "18|2|1|6|4|0",
    ],
  },
];

function decodeRow(row: string, names: string[]): ChannelTypeOption {
  const columns = row.split("|").map((value) => Number(value));
  if (columns.length !== 6 || columns.some((value) => !Number.isFinite(value)))
    throw new Error(`Malformed recovered channel-type row: ${row}`);
  const [hw, loadCode, led, displayPosition, nameIndex, subMode] = columns;
  const name = names[nameIndex];
  if (name === undefined)
    throw new Error(
      `Recovered row ${row} indexes display name ${nameIndex}, which the family does not have`,
    );
  return {
    name,
    hw,
    loadClass: LOAD_CLASS_BY_CODE[loadCode] ?? "onOff",
    ledVariant: led === 1,
    displayPosition,
    nameIndex,
    subMode,
  };
}

export const CHANNEL_TYPE_FAMILIES: ChannelTypeFamily[] =
  RECOVERED_FAMILIES.map((family) => {
    // Presented in the picker's own order, not the row order.
    const options = family.rows
      .map((row) => decodeRow(row, family.names))
      .sort((left, right) => left.displayPosition - right.displayPosition);
    const claimed = new Set(options.map((option) => option.nameIndex));
    return {
      id: family.id,
      description: family.description,
      options,
      nameBindingVerified:
        family.rows.length === family.names.length &&
        claimed.size === family.names.length,
    };
  });

/**
 * The family used when a module's hardware family is unknown. Module-family
 * selection was not recovered from the binary (see the findings note), and the
 * general dimming family is the one that covers ordinary FlexiDim dimmer
 * modules, so it is the safe default for an editor.
 */
export const DEFAULT_CHANNEL_TYPE_FAMILY = "generalDimming";

export function channelTypeFamily(id = DEFAULT_CHANNEL_TYPE_FAMILY) {
  return (
    CHANNEL_TYPE_FAMILIES.find((family) => family.id === id) ??
    CHANNEL_TYPE_FAMILIES.find(
      (family) => family.id === DEFAULT_CHANNEL_TYPE_FAMILY,
    )!
  );
}

/** Every display name the catalogue can show, de-duplicated, in family order. */
export const ALL_CHANNEL_TYPE_NAMES: string[] = [
  ...new Set(
    CHANNEL_TYPE_FAMILIES.flatMap((family) =>
      family.options.map((option) => option.name),
    ),
  ),
];

/**
 * Resolve a stored `hw` code to a display name.
 *
 * `hw` is not unique — within `phaseControl` two rows share hw 1, and hw 0
 * appears in three families — so this is a first-match lookup, preferring the
 * given family. The stored code itself is always preserved; this only affects
 * what an installer is shown.
 */
export function channelTypeName(
  hw: number | undefined,
  familyId = DEFAULT_CHANNEL_TYPE_FAMILY,
): string | undefined {
  if (hw === undefined) return undefined;
  const preferred = channelTypeFamily(familyId).options.find(
    (option) => option.hw === hw,
  );
  if (preferred) return preferred.name;
  for (const family of CHANNEL_TYPE_FAMILIES) {
    const match = family.options.find((option) => option.hw === hw);
    if (match) return match.name;
  }
  return undefined;
}

/** Resolve a display name within a family to the option that stores it. */
export function channelTypeOption(
  name: string,
  familyId = DEFAULT_CHANNEL_TYPE_FAMILY,
): ChannelTypeOption | undefined {
  return channelTypeFamily(familyId).options.find(
    (option) => option.name === name,
  );
}

/**
 * Whether a stored `hw` code drives a dimmable load. Derived from the load
 * class rather than stored separately, so it cannot drift from the type.
 */
export function channelTypeIsDimmable(
  hw: number | undefined,
  familyId = DEFAULT_CHANNEL_TYPE_FAMILY,
): boolean | undefined {
  if (hw === undefined) return undefined;
  const preferred = channelTypeFamily(familyId).options.find(
    (option) => option.hw === hw,
  );
  const match =
    preferred ??
    CHANNEL_TYPE_FAMILIES.flatMap((family) => family.options).find(
      (option) => option.hw === hw,
    );
  return match ? match.loadClass === "dimmable" : undefined;
}

/**
 * The output types that can carry colour or colour-temperature information.
 *
 * Only the protocol outputs address a fixture capable of it: a DMX address or a
 * DALI group can drive an RGB or tunable-white luminaire, while a phase-control
 * or relay output has a single intensity and nothing else. Offering a colour
 * wheel on a triac dimmer would invent a capability the fixture does not have.
 */
const COLOUR_CAPABLE_TYPE_NAMES = new Set([
  "DMX",
  "Enhanced DMX",
  "DALI",
  "Enhanced DALI",
]);

/**
 * Whether a stored `hw` code addresses a fixture that can take colour or
 * Kelvin settings. Resolved through the same family-first lookup as the name.
 */
export function channelSupportsColour(
  hw: number | undefined,
  familyId = DEFAULT_CHANNEL_TYPE_FAMILY,
): boolean {
  const name = channelTypeName(hw, familyId);
  return name !== undefined && COLOUR_CAPABLE_TYPE_NAMES.has(name);
}

/**
 * Accessory types, exactly the two the app offers. There is deliberately no
 * "None" entry: the app's array has two elements, and a channel is accessory-
 * controlled through its load class instead.
 */
export const ACCESSORY_TYPE_NAMES = ["1-10V", "Blind control"] as const;

export function accessoryTypeName(index: number | undefined) {
  return index === undefined ? undefined : ACCESSORY_TYPE_NAMES[index];
}

/** A blind-control channel is the only one the blind commands apply to. */
export function isBlindControl(accessoryType: number | undefined) {
  return accessoryTypeName(accessoryType) === "Blind control";
}

/**
 * Switch types, with the "Not used" code-0 entry the app offers and the web
 * app previously omitted. Parallel name/code arrays at 0x10005d7dc.
 */
export const SWITCH_TYPES: { name: string; code: number; buttons: number }[] = [
  // "Not used" is a real, selectable type: it parks a switch address without
  // deleting the switch. It has no buttons.
  { name: "Not used", code: 0, buttons: 0 },
  { name: "2 channel opto", code: 2, buttons: 2 },
  { name: "8 channel opto", code: 8, buttons: 8 },
  { name: "4 scene", code: 13, buttons: 7 },
  { name: "8 scene", code: 15, buttons: 11 },
];

export function switchTypeByCode(code: number | undefined) {
  return SWITCH_TYPES.find((entry) => entry.code === code);
}

export function switchTypeByName(name: string) {
  return SWITCH_TYPES.find((entry) => entry.name === name);
}
