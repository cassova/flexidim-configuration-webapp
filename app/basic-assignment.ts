import type { AppData, WallSwitch } from "./fd4cfg.ts";

/**
 * Basic Assignment compilation, matching the recovered iOS behaviour.
 *
 * From the binary (see `work/binary-findings.md` Q6): a switch's basic
 * assignment is the `bsaChannels` array, serialised `bs0..bsN`, and
 * `-compileConfig` walks that array **in array order** to emit the assignment
 * records. The switch-level `op` key is `onOffPri` — a single boolean for the
 * whole switch, not a per-channel setting.
 *
 * This module produces the compiled record list and order. It deliberately does
 * NOT produce controller wire bytes: the compiled-image layout is not
 * protocol-verified (Phase 6), so only the model and its ordering are claimed.
 */

export type CompiledAssignmentChannel = {
  /** Position in the compiled stream, 0-based. This is the whole point. */
  order: number;
  channelId: number;
  /** The controller's channel address, when the channel has one. */
  controllerChannel?: number;
  assignOn: boolean;
  assignOff: boolean;
  assignDimming: boolean;
  assignChannelDimming: boolean;
  /** Fade in seconds, as edited. */
  onFade: number;
  offFade: number;
  /** Fade in the controller's half-second ticks, as stored and transmitted. */
  onFadeTicks: number;
  offFadeTicks: number;
};

export type CompiledAssignment = {
  switchId: number;
  /** The address the controller knows this switch by. */
  switchNumber: number;
  /**
   * The switch-level on/off priority flag (`op` / `onOffPri`). Recovered as a
   * per-switch boolean; which action it makes win is not fully recovered, so it
   * is carried through rather than interpreted.
   */
  onOffPriority: boolean;
  channels: CompiledAssignmentChannel[];
};

/** Seconds to the controller's half-second transition ticks. */
export function fadeTicks(seconds: number | undefined) {
  return Math.max(0, Math.round((seconds ?? 0) * 2));
}

/**
 * The switch-level on/off priority. Read from the switch rather than from any
 * channel: the archive has exactly one `op` per switch, and the per-channel
 * copies the importer fans out are a display convenience.
 */
export function onOffPriority(wallSwitch: WallSwitch) {
  return wallSwitch.basic?.onPriority ?? false;
}

/**
 * Compile one switch's basic assignment.
 *
 * `basic.channelIds` order is authoritative — it is the `bs0..bsN` order from
 * the archive — so it is never sorted here. A channel listed but missing from
 * the configuration is dropped, matching the referential-integrity rules.
 */
export function compileSwitchAssignment(
  wallSwitch: WallSwitch,
  data: AppData,
): CompiledAssignment {
  const byId = new Map(data.channels.map((channel) => [channel.id, channel]));
  const priority = onOffPriority(wallSwitch);
  const channels: CompiledAssignmentChannel[] = [];
  for (const channelId of wallSwitch.basic?.channelIds ?? []) {
    const channel = byId.get(channelId);
    if (!channel) continue;
    const settings = wallSwitch.basic?.channelSettings?.[channelId];
    const onFade = settings?.onFade ?? wallSwitch.basic?.onTime ?? 0;
    const offFade = settings?.offFade ?? wallSwitch.basic?.offTime ?? 0;
    channels.push({
      order: channels.length,
      channelId,
      controllerChannel: channel.controllerChannel,
      assignOn: settings?.assignOn ?? wallSwitch.basic?.assignOn ?? false,
      assignOff: settings?.assignOff ?? wallSwitch.basic?.assignOff ?? false,
      assignDimming:
        settings?.assignDimming ?? wallSwitch.basic?.assignDimming ?? false,
      assignChannelDimming:
        settings?.assignChannelDimming ??
        wallSwitch.basic?.assignChannelDimming ??
        false,
      onFade,
      offFade,
      onFadeTicks: fadeTicks(onFade),
      offFadeTicks: fadeTicks(offFade),
    });
  }
  return {
    switchId: wallSwitch.id,
    switchNumber: wallSwitch.number ?? wallSwitch.id,
    onOffPriority: priority,
    channels,
  };
}

/**
 * Compile every switch's basic assignment, in switch order.
 *
 * Switches are emitted in the configuration's own list order, which is the
 * `bsa` array order from the archive — again not sorted.
 */
export function compileBasicAssignments(data: AppData): CompiledAssignment[] {
  return data.switches.map((wallSwitch) =>
    compileSwitchAssignment(wallSwitch, data),
  );
}

/**
 * Move a channel within a switch's basic assignment, returning a new switch.
 *
 * Reordering is a real operation with a controller-visible effect, because the
 * compiled order follows this array — so the editor needs it, and it must move
 * rather than sort.
 */
export function moveAssignmentChannel(
  wallSwitch: WallSwitch,
  channelId: number,
  direction: -1 | 1,
): WallSwitch {
  const channelIds = [...(wallSwitch.basic?.channelIds ?? [])];
  const from = channelIds.indexOf(channelId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= channelIds.length) return wallSwitch;
  [channelIds[from], channelIds[to]] = [channelIds[to], channelIds[from]];
  return {
    ...wallSwitch,
    basic: { ...wallSwitch.basic!, channelIds },
  };
}
