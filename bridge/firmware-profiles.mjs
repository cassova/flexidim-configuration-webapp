import { SAFE_LOCAL_PROFILE } from "./controller-capabilities.mjs";

/**
 * Controller firmware acceptance matrix.
 *
 * A capability is enabled by EVIDENCE, never by optimism. Each profile records
 * what was actually observed on which hardware, so "why is this button
 * disabled?" has a documented answer and enabling one is a deliberate,
 * reviewable act rather than a flag flip.
 *
 * `evidence` levels:
 *   hardware — exercised against a real controller and the result observed
 *   binary   — read out of the iOS 2.97 binary but never seen on the wire
 *   none     — assumed; must not enable anything
 */
export const EVIDENCE_LEVELS = ["none", "binary", "hardware"];

/**
 * The acceptance matrix. `identify` matches what a controller tells us about
 * itself; today nothing does, so only the fallback profile is ever selected.
 */
export const FIRMWARE_PROFILES = Object.freeze([
  {
    id: "type-0-live-only",
    description:
      "Site-type-0 local plaintext session. The only profile validated against real hardware.",
    siteTypes: [0],
    /** No controller has been observed announcing a version, so this matches nothing. */
    identify: null,
    fallback: true,
    capabilities: SAFE_LOCAL_PROFILE,
    evidence: {
      discovery: "hardware",
      authentication: "hardware",
      liveDim: "hardware",
      liveSwitch: "binary",
      passiveChannelStatus: "hardware",
      verify: "hardware",
      channelProfiles: "none",
      moduleProfiles: "none",
      userProfiles: "none",
      switchDetection: "none",
      channelSearch: "none",
      // Frames recovered from the binary; no reply observed on hardware yet.
      statusRequests: "binary",
      blindControl: "none",
      remoteAccess: "none",
      // The original iOS app completed a full transfer against the installed
      // firmware 4.0 controller; the web sender matches the executed
      // original-app oracle frame-for-frame. Private block counts stay ignored.
      fullTransfer: "hardware",
    },
    notes:
      "Dim frames, the f2 status scan and the read-only verify exchange were confirmed on hardware. The original iOS app's full transfer/reset lifecycle completed on installed firmware 4.0, and the web sender matches its executed oracle transcript byte-for-byte.",
  },
]);

/** The profile used when a controller cannot be identified. */
export function fallbackFirmwareProfile() {
  const profile = FIRMWARE_PROFILES.find((entry) => entry.fallback);
  if (!profile) throw new Error("the firmware matrix has no fallback profile");
  return profile;
}

/**
 * Select a profile for a controller. Anything unrecognised gets the fallback,
 * which is the deny-by-default one — an unknown controller must never be
 * treated as more capable than a known one.
 */
export function firmwareProfileFor(identity = {}) {
  const matched = FIRMWARE_PROFILES.find(
    (entry) => entry.identify && entry.identify.version === identity.version,
  );
  return matched ?? fallbackFirmwareProfile();
}

function enabledCapabilities(profile) {
  return Object.entries(profile.capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([capability]) => capability);
}

/**
 * Capabilities a profile enables with NO evidence at all.
 *
 * This must always be empty — it is the invariant that keeps the matrix honest.
 * Note the bar is "some evidence", not "hardware evidence": a non-destructive
 * live command read out of the binary may be enabled, because the worst case is
 * a frame the controller ignores. Anything that writes configuration needs
 * hardware evidence and is listed separately below.
 */
export function unevidencedCapabilities(profile) {
  return enabledCapabilities(profile).filter(
    (capability) =>
      !profile.evidence[capability] || profile.evidence[capability] === "none",
  );
}

/**
 * Capabilities enabled on binary evidence alone. Not a failure, but they are
 * the ones most likely to be wrong on unfamiliar firmware, so they are surfaced
 * rather than buried.
 */
export function binaryOnlyCapabilities(profile) {
  return enabledCapabilities(profile).filter(
    (capability) => profile.evidence[capability] === "binary",
  );
}

/**
 * Capabilities that change stored controller configuration. These may only be
 * enabled with hardware evidence, because a wrong guess is not recoverable by
 * retrying.
 */
export const DESTRUCTIVE_CAPABILITIES = Object.freeze([
  "channelProfiles",
  "moduleProfiles",
  "userProfiles",
  "switchDetection",
  "channelSearch",
  "statusRequests",
  "blindControl",
  "fullTransfer",
]);

/** Destructive capabilities enabled without hardware evidence. Must be empty. */
export function underEvidencedWrites(profile) {
  return enabledCapabilities(profile)
    .filter((capability) => DESTRUCTIVE_CAPABILITIES.includes(capability))
    .filter((capability) => profile.evidence[capability] !== "hardware");
}
