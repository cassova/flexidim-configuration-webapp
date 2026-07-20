// Pure helpers for the Scene-to-Button test surface. Keeping this logic free of
// React and sockets lets archived switch behaviour be verified one press at a
// time before any frame reaches a real controller.

export function rawControllerButton(buttonCount, physicalPosition) {
  const hasBuiltIns = buttonCount >= 7 && buttonCount % 4 === 3;
  if (!hasBuiltIns) return physicalPosition;
  const mainButtons = buttonCount - 3;
  if (physicalPosition <= mainButtons + 2) return physicalPosition;
  // The iOS switchButtons table skips protocol code 11 for the third shifted
  // button: type 15 maps plate positions 9/10/11 to wire buttons 9/10/12.
  return physicalPosition + 1;
}

export function defaultOnOffCommands(wallSwitch, channels) {
  const basic = wallSwitch.basic;
  if (!basic?.channelIds?.length) return [];
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const stateChannels = basic.channelIds
    // Decide from the outputs this action actually turns on. An Off-only
    // channel legitimately remains at 0% after the On press and must not force
    // every subsequent press back into the On branch.
    .filter((id) => basic.channelSettings?.[id]?.assignOn ?? basic.assignOn)
    .map((id) => byId.get(id))
    .filter(Boolean);
  // This mirrors the app's Default On/Off decision: only turn off when every
  // participating output is already at 100%; otherwise restore the On state.
  const turnOn = !stateChannels.length || stateChannels.some((channel) => channel.level !== 100);
  return basic.channelIds.flatMap((id) => {
    const channel = byId.get(id);
    if (!channel) return [];
    const settings = basic.channelSettings?.[id];
    const assigned = turnOn
      ? (settings?.assignOn ?? basic.assignOn)
      : (settings?.assignOff ?? basic.assignOff);
    if (!assigned) return [];
    const seconds = turnOn
      ? (settings?.onFade ?? basic.onTime ?? 0)
      : (settings?.offFade ?? basic.offTime ?? 0);
    return [{
      id,
      level: turnOn ? 100 : 0,
      // The archive/UI model stores seconds; sendDiMessage uses half-second
      // transition ticks on the wire.
      transition: Math.max(0, Math.round(seconds * 2)),
    }];
  });
}
