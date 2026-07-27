/**
 * Translate the addressing used by the archived iOS model to the one-byte
 * address sent to the Scene Controller.
 *
 * FlexiDim modules contain eight channels.  `modulePosition` is the module's
 * position in the site's stored modules array (not its module number and not
 * a hexadecimal high nibble).
 */
export function controllerChannelAddress(modulePosition, channelIndex) {
  if (!Number.isInteger(modulePosition) || modulePosition < 0) return channelIndex;
  return modulePosition * 8 + channelIndex;
}

/**
 * The first module number on bus B.
 *
 * Recovered from `-[JCLFDConfig moduleForModuleNumber:]`: the bus-B search
 * initialises its counter to 0x10 and indexes `modulesB` as `number - 15`, so
 * bus B starts at module number 16 and bus A can hold at most 15 modules. One
 * module-number space, two backing arrays.
 */
export const BUS_B_FIRST_MODULE_NUMBER = 16;

/**
 * The module number the controller knows a module by.
 *
 * `positionInBus` is the module's zero-based position within its own bus array.
 * Bus A numbers from 1; bus B numbers from 16.
 */
export function controllerModuleNumber(bus, positionInBus) {
  if (!Number.isInteger(positionInBus) || positionInBus < 0) return -1;
  return bus === "B"
    ? BUS_B_FIRST_MODULE_NUMBER + positionInBus
    : positionInBus + 1;
}

/**
 * Split a module number back into its bus and zero-based position, mirroring
 * `moduleForModuleNumber:`. Returns undefined for numbers the controller would
 * not resolve (it returns -1 for those).
 */
export function moduleNumberToBusPosition(number) {
  if (!Number.isInteger(number) || number < 1) return undefined;
  if (number >= BUS_B_FIRST_MODULE_NUMBER)
    return { bus: "B", positionInBus: number - BUS_B_FIRST_MODULE_NUMBER };
  return { bus: "A", positionInBus: number - 1 };
}
