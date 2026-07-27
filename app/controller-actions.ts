import {
  SAFE_LOCAL_PROFILE,
  capabilityFor,
} from "../bridge/controller-capabilities.mjs";

/**
 * What each controller action is called, and what evidence it is still waiting
 * for. The bridge already refuses these; the point of this module is that the
 * UI can say *why* before the user presses anything, instead of offering a
 * button that produces a generic protocol error.
 *
 * The capability names come from the bridge's own mapping, so a profile that
 * later enables a feature turns its control on in one place.
 */
const PENDING_EVIDENCE: Record<string, { label: string; evidence: string }> = {
  verify: {
    label: "Compare with Scene Controller",
    evidence: "the controller CRC comparison frames are not protocol-verified",
  },
  channelProfile: {
    label: "Send channel configuration",
    evidence:
      "channel profile transmission has no captured original-app traffic to validate against",
  },
  moduleProfiles: {
    label: "Send module profiles",
    evidence:
      "module profile transmission has no captured original-app traffic to validate against",
  },
  userProfiles: {
    label: "Send user profile",
    evidence:
      "the user-profile transfer command is not protocol-verified",
  },
  switchDetect: {
    label: "Identify switch by button press",
    evidence: "switch identification frames are not protocol-verified",
  },
  switchTypeDetect: {
    label: "Detect switch types",
    evidence: "switch type detection frames are not protocol-verified",
  },
  channelSearch: {
    label: "Search for channel",
    evidence: "the channel search command is not protocol-verified",
  },
  blind: {
    label: "Blind control",
    evidence:
      "blind open/close/position commands are not protocol-verified, and a wrong frame can drive a blind motor against its end stop",
  },
};

export type ControllerActionState = {
  allowed: boolean;
  label: string;
  /** Present only when the action is unavailable. */
  reason?: string;
};

/**
 * Whether a controller action can be attempted under the active profile.
 *
 * This uses the bridge's complete deny-by-default registry. Known ordinary
 * live/session commands are explicitly allowed there; an unknown type is
 * blocked on both sides instead of silently becoming a new write path.
 */
export function controllerActionState(
  messageType: string,
  profile: Record<string, unknown> | null = null,
): ControllerActionState {
  const active = profile ?? SAFE_LOCAL_PROFILE;
  const allowed = capabilityFor(messageType, active);
  const pending = PENDING_EVIDENCE[messageType];
  const label = pending?.label ?? messageType;
  if (allowed) return { allowed: true, label };
  return {
    allowed: false,
    label,
    reason: pending
      ? `Not available: ${pending.evidence}.`
      : `Not available: ${messageType} is disabled by the active controller profile.`,
  };
}

/** Every action this build knows is gated, for a capability summary. */
export function gatedControllerActions(
  profile: Record<string, unknown> | null = null,
) {
  return Object.keys(PENDING_EVIDENCE)
    .map((messageType) => ({
      messageType,
      ...controllerActionState(messageType, profile),
    }))
    .filter((action) => !action.allowed);
}
