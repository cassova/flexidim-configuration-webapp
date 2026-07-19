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
