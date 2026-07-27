import { crc16X25 } from "../bridge/protocol.mjs";
import {
  canonicalJson,
  snapshotConfigContent,
  validateConfigContent,
  type AppData,
} from "./fd4cfg.ts";

/**
 * Local CRC over the web configuration content, using the controller's
 * CRC-16/X25. This is a change-detection checksum of the editable model —
 * it is NOT the compiled controller-image CRC, whose byte layout is not yet
 * protocol-verified (see PROTOCOL.md "Comparing and transferring").
 */
export function configContentCrc(data: AppData): string {
  // canonicalJson, not stringifyConfiguration: the latter is insertion-order
  // sensitive, which made this checksum change across an export/import round
  // trip even when the configuration was structurally identical.
  const canonical = canonicalJson(snapshotConfigContent(data));
  const bytes = new TextEncoder().encode(canonical);
  return crc16X25(bytes).toString(16).padStart(4, "0");
}

export type TransferReadiness = {
  ready: boolean;
  localCrc: string;
  /**
   * Problems with THIS configuration that an installer can act on — a missing
   * security code, a broken reference. These belong on screen.
   */
  blockers: string[];
  /** First actionable reason the transfer cannot begin, when present. */
  unavailableReason: string;
  /** Honest state the installer should review before any future transfer. */
  warnings: string[];
};

/** An honest whole-controller transfer readiness report. */
export function transferReadiness(data: AppData): TransferReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const issues = validateConfigContent(snapshotConfigContent(data));
  for (const issue of issues)
    blockers.push(`Configuration integrity: ${issue}`);

  if (!/^[\x20-\x7e]{16}$/.test(data.site.securityCode ?? ""))
    blockers.push(
      "The 16-character controller security code is missing or invalid.",
    );

  if ((data.site.siteType ?? 0) !== 0)
    blockers.push(
      `Site type ${data.site.siteType} sessions (remote/encrypted) are not enabled until their protocol profile is verified.`,
    );

  // Counts are shown to an installer, so the noun and its verb have to agree.
  const plural = (count: number, singular: string, verb: [string, string]) =>
    `${count} ${singular}${count === 1 ? "" : "s"} ${count === 1 ? verb[0] : verb[1]}`;

  if (data.site.modulesChanged)
    warnings.push(
      "Equipment (modules) changed since the configuration was last transferred by the original app.",
    );
  const changedHardware = data.channels.filter(
    (channel) => channel.hardwareChanged,
  ).length;
  if (changedHardware > 0)
    warnings.push(
      `${plural(changedHardware, "channel", ["carries", "carry"])} hardware changes that have not been sent to the controller.`,
    );
  const pendingUsers = data.users.filter(
    (user) => user.profileStatus === "pending",
  ).length;
  if (pendingUsers > 0)
    warnings.push(
      `${plural(pendingUsers, "user profile", ["has", "have"])} pending changes that have not been transferred.`,
    );
  const pendingModules = (data.modules ?? []).filter(
    (module) => module.pending,
  ).length;
  if (pendingModules > 0)
    warnings.push(
      `${plural(pendingModules, "module profile", ["is", "are"])} pending transmission.`,
    );
  const deletedItems = data.deletedItems?.length ?? 0;
  const deletedScenes = data.deletedScenes?.length ?? 0;
  if (deletedItems + deletedScenes > 0)
    warnings.push(
      `${plural(deletedItems + deletedScenes, "deleted item", ["is", "are"])} still recoverable in this configuration (${deletedItems} equipment, ${plural(deletedScenes, "scene", ["", ""]).trim()}); a transfer would remove them from the controller.`,
    );

  return {
    ready: blockers.length === 0,
    localCrc: configContentCrc(data),
    blockers,
    unavailableReason: blockers[0] ?? "",
    warnings,
  };
}
