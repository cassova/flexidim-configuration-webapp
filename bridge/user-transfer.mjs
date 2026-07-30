// User-profile-only sender, recovered from the original iOS app's
// -[JCLTabViewController sendUserData:userOnly:].
//
// This is the "send user profiles" action: it sends profiles without
// recompiling or re-downloading the configuration image. It is a separate,
// much shorter conversation than the full transfer in config-transfer.mjs,
// which reaches user payloads only after a whole-controller download.
//
// Evidence: tools/oracle/private/user_capture.m drives the original method
// with an in-memory output stream over synthetic archives. Each call to the
// original method — one timer tick — emits, verbatim:
//
//   first call (user cursor 0):  ff fc 00 00 00 00        prepare
//   every call while users left: all ff f2 chunks for the user at the cursor,
//                                then the cursor advances; returns "more"
//   call once the cursor is spent: ff f2 e0 7f 7f + 256 zeros   all users sent
//                                  ff fe 00 00 00 00            make permanent
//                                  returns "finished"
//
// A configuration with no users therefore emits prepare, terminator and
// make-permanent in a single call. Calls after completion re-emit the two
// terminal frames, exactly as the original does.
//
// Controller replies are NOT modelled here: the original user-only path writes
// on its timer without waiting for one, and no reply has ever been observed
// from real hardware. Sending remains gated by the caller.

import {
  allUsersTerminator,
  frame,
  userDataFrames,
} from "./config-transfer.mjs";

const MAX_USERS = 0xe0;

function prepareFrame() {
  return frame("prepare-user-data", [0xff, 0xfc, 0, 0, 0, 0]);
}

function makePermanentFrame() {
  return frame("make-user-data-permanent", [0xff, 0xfe, 0, 0, 0, 0]);
}

function normalizeUserPayloads(userPayloads) {
  if (!Array.isArray(userPayloads))
    throw new TypeError("userPayloads must be an array of UTF-8 strings or byte buffers");
  if (userPayloads.length > MAX_USERS)
    throw new RangeError(
      `the type-0 user index field supports at most ${MAX_USERS} users`,
    );
  return userPayloads.map((payload) =>
    typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload),
  );
}

class UserProfileTransferSession {
  constructor({ userPayloads = [] } = {}) {
    this.userPayloads = normalizeUserPayloads(userPayloads);
    this.userIndex = 0;
    this.started = false;
    this.complete = false;
  }

  snapshot() {
    return Object.freeze({
      userIndex: this.userIndex,
      userCount: this.userPayloads.length,
      started: this.started,
      complete: this.complete,
    });
  }

  /** One original timer tick. Returns the frames it writes, in order. */
  next() {
    const frames = [];
    if (!this.started) {
      frames.push(prepareFrame());
      this.started = true;
    }
    if (this.userIndex < this.userPayloads.length) {
      frames.push(
        ...userDataFrames(this.userPayloads[this.userIndex], this.userIndex),
      );
      this.userIndex += 1;
    } else {
      frames.push(allUsersTerminator(), makePermanentFrame());
      this.complete = true;
    }
    return Object.freeze({
      frames: Object.freeze(frames),
      snapshot: this.snapshot(),
    });
  }
}

/** Drive a whole user-only send offline and return every frame it writes. */
function compileUserProfileTranscript(options) {
  const session = new UserProfileTransferSession(options);
  const ticks = [];
  // The original repeats its terminal frames when called again; stop at the
  // first completing tick so a transcript holds one pass.
  while (!session.complete) ticks.push(session.next());
  return Object.freeze({
    ticks: Object.freeze(ticks),
    frames: Object.freeze(ticks.flatMap((tick) => [...tick.frames])),
    final: session.snapshot(),
  });
}

export {
  MAX_USERS,
  prepareFrame,
  makePermanentFrame,
  UserProfileTransferSession,
  compileUserProfileTranscript,
};
