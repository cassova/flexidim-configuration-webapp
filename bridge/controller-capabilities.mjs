// Capabilities are deny-by-default. Full transfer is the one commissioning
// path enabled for type 0: its sender is byte-identical to the executed iOS
// oracle, and the original app's complete transfer/reset flow was observed on
// the installed firmware 4.0 controller.
export const SAFE_LOCAL_PROFILE = Object.freeze({
  id: "type-0-live-only",
  siteTypes: [0],
  liveDim: true,
  liveSwitch: true,
  passiveChannelStatus: true,
  verify: true,
  channelProfiles: false,
  moduleProfiles: false,
  userProfiles: false,
  switchDetection: false,
  channelSearch: false,
  // The period-flag and pending-scene request frames are recovered byte for
  // byte (ff f1 00 / ff f1 01) but no reply has been observed, so they stay off.
  statusRequests: false,
  blindControl: false,
  remoteAccess: false,
  fullTransfer: true,
});

// Complete bridge command registry. `null` means a local/session operation that
// is explicitly allowed without a controller feature flag. Unknown commands
// are refused: adding a handler without adding it here cannot silently expose a
// new controller write.
const CAPABILITY_BY_MESSAGE = {
  connect: null,
  discover: null,
  transferDryRun: null,
  transferSafetyStatus: null,
  transferCancel: null,
  transferEmergencyStop: null,
  transferSafetyReset: null,
  transferAudit: null,
  dim: "liveDim", switch: "liveSwitch", scene: "liveDim", verify: "verify",
  channelProfile: "channelProfiles", moduleProfiles: "moduleProfiles",
  userProfiles: "userProfiles", switchDetect: "switchDetection",
  switchTypeDetect: "switchDetection", channelSearch: "channelSearch",
  periodFlags: "statusRequests", pendingScenes: "statusRequests",
  blind: "blindControl", sync: "fullTransfer",
};

export function capabilityFor(messageType, profile = SAFE_LOCAL_PROFILE) {
  if (!Object.hasOwn(CAPABILITY_BY_MESSAGE, messageType)) return false;
  const capability = CAPABILITY_BY_MESSAGE[messageType];
  return capability === null ? true : Boolean(profile[capability]);
}

/** The message types this build gates, for tests and capability summaries. */
export function gatedMessageTypes(profile = SAFE_LOCAL_PROFILE) {
  return Object.entries(CAPABILITY_BY_MESSAGE)
    .filter(([, capability]) => !profile[capability])
    .map(([messageType]) => messageType);
}

export function registeredMessageTypes() {
  return Object.freeze(Object.keys(CAPABILITY_BY_MESSAGE));
}
