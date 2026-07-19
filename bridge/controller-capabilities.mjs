// Capabilities are deny-by-default. A mutating commissioning feature may only
// be enabled by a controller/firmware profile backed by captured traffic and a
// recoverable hardware test.
export const SAFE_LOCAL_PROFILE = Object.freeze({
  id: "type-0-live-only",
  siteTypes: [0],
  liveDim: true,
  liveSwitch: true,
  passiveChannelStatus: true,
  verify: false,
  channelProfiles: false,
  moduleProfiles: false,
  userProfiles: false,
  switchDetection: false,
  channelSearch: false,
  blindControl: false,
  remoteAccess: false,
  fullTransfer: false,
});

export function capabilityFor(messageType, profile = SAFE_LOCAL_PROFILE) {
  const mapping = {
    dim: "liveDim", switch: "liveSwitch", scene: "liveDim", verify: "verify",
    channelProfile: "channelProfiles", moduleProfiles: "moduleProfiles",
    userProfiles: "userProfiles", switchDetect: "switchDetection",
    switchTypeDetect: "switchDetection", blind: "blindControl", sync: "fullTransfer",
  };
  const capability = mapping[messageType];
  return capability ? Boolean(profile[capability]) : true;
}
