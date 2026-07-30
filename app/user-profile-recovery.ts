// What happens in the send dialog after user profiles have been written.
//
// Ground truth (PROTOCOL.md): once the frames are sent, the controller applies
// them and restarts — the house lights come on about a minute and three quarters
// in — and it does NOT finish on its own. A Compare read-back is what completes
// the reset. The connection we sent over stops reporting the controller's real
// state, and automatic reconnect polling proved unreliable in practice, so the
// operator drives the final step:
//
//   1. WAIT     a two-minute countdown while the controller restarts.
//   2. READY    "Reconnect & Sync" becomes available; the operator confirms the
//               lights are on and presses it.
//   3. SYNC     reconnect the way the Connect button does, then Compare, which
//               triggers the controller's final reset.
//
// A failed sync returns to READY so it can simply be pressed again.
//
// Pure state machine: timing is injected and it reaches the world only through
// onView (render), reconnect (open a controller session) and sendVerify
// (Compare) — so it is unit-testable with fake timers.

export type RecoveryPhase =
  | "idle"
  | "waiting"
  | "ready"
  | "syncing"
  | "success"
  | "failed"
  | "stopped";

/** The subset of phases that are ever rendered (never idle/stopped). */
export type RecoveryViewPhase = Exclude<RecoveryPhase, "idle" | "stopped">;

export interface RecoveryView {
  phase: RecoveryViewPhase;
  message: string;
  /** Length of the restart countdown, for the UI's live timer. */
  countdownMs?: number;
  /** Whether "Reconnect & Sync" should be enabled. */
  canSync: boolean;
}

export const USER_PROFILE_RECOVERY_TIMING = {
  /** The restart countdown before syncing is offered. */
  countdownMs: 120_000,
  /** How long a sync attempt gets to establish a connection. */
  connectTimeoutMs: 15_000,
  /** How long to wait for the Compare result once connected. */
  compareResultTimeoutMs: 30_000,
} as const;

export const USER_PROFILE_RECOVERY_MESSAGES = {
  waiting:
    "User profiles sent. The Scene Controller is now applying them and restarting, which takes a couple of minutes — the lights will come on while it does. Please don't send commands or make changes until it has finished.",
  ready:
    "If the lighting system appears to have restarted — the lights are on — press “Reconnect & Sync” to re-establish the connection and complete the reset. If the lights are still off, wait a little longer and then press it.",
  syncing:
    "Reconnecting to the Scene Controller and syncing to complete its reset…",
  success:
    "Reconnected and synced. The Scene Controller is completing its final reset and should be back to normal within about 30 seconds, and the switches will work again.",
  failed:
    "Couldn't reconnect and sync with the Scene Controller. Give it a little longer, then press “Reconnect & Sync” again — if the switches still don't respond after several minutes, it may need to be power-cycled.",
} as const;

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerKey = "countdown" | "connect" | "result";

export interface RecoveryOptions {
  onView: (view: RecoveryView) => void;
  reconnect: () => void;
  sendVerify: () => void;
  timing?: typeof USER_PROFILE_RECOVERY_TIMING;
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

export class UserProfileRecovery {
  private phaseValue: RecoveryPhase = "idle";
  private timers: Partial<Record<TimerKey, TimerHandle>> = {};
  private readonly onView: (view: RecoveryView) => void;
  private readonly reconnectFn: () => void;
  private readonly sendVerify: () => void;
  private readonly timing: typeof USER_PROFILE_RECOVERY_TIMING;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  constructor(options: RecoveryOptions) {
    this.onView = options.onView;
    this.reconnectFn = options.reconnect;
    this.sendVerify = options.sendVerify;
    this.timing = options.timing ?? USER_PROFILE_RECOVERY_TIMING;
    // The defaults MUST be wrapped, not `?? setTimeout`. Stored on the instance,
    // a bare reference is invoked as `this.setTimeoutFn(...)`, which passes this
    // object as the receiver — and a browser's `setTimeout` requires `window`,
    // so it throws "Illegal invocation". Node does not, which is why unit tests
    // never saw it: in the browser every timer arm threw and the flow parked.
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  get phase(): RecoveryPhase {
    return this.phaseValue;
  }

  private clearTimer(key: TimerKey) {
    const handle = this.timers[key];
    if (handle !== undefined) {
      this.clearTimeoutFn(handle);
      delete this.timers[key];
    }
  }

  private clearAllTimers() {
    (["countdown", "connect", "result"] as const).forEach((key) =>
      this.clearTimer(key),
    );
  }

  /** Render a view without letting a UI error break the flow. */
  private report(view: RecoveryView) {
    this.safely(() => this.onView(view));
  }

  private safely(action: () => void) {
    try {
      action();
    } catch {
      // A callback failing must never stop the flow from progressing.
    }
  }

  /** Begin the restart countdown. */
  start() {
    if (this.phaseValue !== "idle") return;
    this.clearAllTimers();
    this.phaseValue = "waiting";
    // Arm before rendering: if rendering throws, the countdown must still run.
    this.timers.countdown = this.setTimeoutFn(
      () => this.becomeReady(),
      this.timing.countdownMs,
    );
    this.report({
      phase: "waiting",
      message: USER_PROFILE_RECOVERY_MESSAGES.waiting,
      countdownMs: this.timing.countdownMs,
      canSync: false,
    });
  }

  private becomeReady() {
    if (this.phaseValue !== "waiting") return;
    this.phaseValue = "ready";
    this.report({
      phase: "ready",
      message: USER_PROFILE_RECOVERY_MESSAGES.ready,
      canSync: true,
    });
  }

  /**
   * The operator pressed "Reconnect & Sync": reconnect, then Compare. Available
   * once the countdown has finished, and again after a failed attempt.
   */
  reconnectAndSync() {
    if (this.phaseValue !== "ready" && this.phaseValue !== "failed") return false;
    this.clearAllTimers();
    this.phaseValue = "syncing";
    this.timers.connect = this.setTimeoutFn(
      () => this.fail(),
      this.timing.connectTimeoutMs,
    );
    this.report({
      phase: "syncing",
      message: USER_PROFILE_RECOVERY_MESSAGES.syncing,
      canSync: false,
    });
    this.safely(() => this.reconnectFn());
    return true;
  }

  /** The bridge reported the controller connected: Compare to finish the reset. */
  connectionEstablished() {
    if (this.phaseValue !== "syncing") return;
    this.clearTimer("connect");
    this.clearTimer("result");
    this.timers.result = this.setTimeoutFn(
      () => this.fail(),
      this.timing.compareResultTimeoutMs,
    );
    this.safely(() => this.sendVerify());
  }

  /** The reconnect could not reach the controller. */
  reconnectFailed() {
    if (this.phaseValue !== "syncing") return;
    this.fail();
  }

  /** Fed a verifyResult state: "match"/"different" answer, anything else fails. */
  compareResult(state: string) {
    if (this.phaseValue !== "syncing") return;
    // Any answer — match OR different — means the controller performed the
    // read-back, which is what triggers its final reset.
    if (state === "match" || state === "different") {
      this.clearAllTimers();
      this.phaseValue = "success";
      this.report({
        phase: "success",
        message: USER_PROFILE_RECOVERY_MESSAGES.success,
        canSync: false,
      });
      return;
    }
    this.fail();
  }

  /** A sync attempt did not complete; offer the button again. */
  private fail() {
    if (this.phaseValue !== "syncing") return;
    this.clearAllTimers();
    this.phaseValue = "failed";
    this.report({
      phase: "failed",
      message: USER_PROFILE_RECOVERY_MESSAGES.failed,
      canSync: true,
    });
  }

  /** Operator closed the popup / cancelled. */
  stop() {
    this.clearAllTimers();
    this.phaseValue = "stopped";
  }
}
