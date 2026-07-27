import { SAFE_LOCAL_PROFILE } from "./controller-capabilities.mjs";

/**
 * Messages the bridge answers by itself, without touching the Scene Controller.
 *
 * These are resolved BEFORE the deny-by-default capability refusal so the app
 * receives the specific, honest reason for a feature's state instead of a
 * generic "disabled by controller profile" status error. Returning a reply here
 * never writes to the controller.
 */
export function localResponse(message, profile = SAFE_LOCAL_PROFILE) {
  if (message?.type === "verify" && !profile.verify) {
    return {
      type: "verifyResult",
      state: "unavailable",
      message:
        "not available — the local CRC covers web configuration content only; controller verification frames are not protocol-verified",
    };
  }
  return null;
}
