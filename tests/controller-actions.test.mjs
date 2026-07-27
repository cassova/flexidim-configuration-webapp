import assert from "node:assert/strict";
import test from "node:test";
import {
  controllerActionState,
  gatedControllerActions,
} from "../app/controller-actions.ts";
import {
  SAFE_LOCAL_PROFILE,
  gatedMessageTypes,
} from "../bridge/controller-capabilities.mjs";

test("verified live control is offered without a reason attached", () => {
  for (const action of ["dim", "switch", "scene"]) {
    const state = controllerActionState(action);
    assert.equal(state.allowed, true, `${action} should be allowed`);
    assert.equal(state.reason, undefined);
  }
});

test("every write-gated action explains the specific missing evidence", () => {
  const gated = [
    "channelProfile",
    "moduleProfiles",
    "userProfiles",
    "switchDetect",
    "switchTypeDetect",
    "channelSearch",
    "blind",
  ];
  for (const action of gated) {
    const state = controllerActionState(action);
    assert.equal(state.allowed, false, `${action} must stay gated`);
    assert.match(state.reason, /^Not available: /);
    // A generic refusal is not good enough: the reason has to name what is
    // missing, or the UI cannot tell "unbuilt" from "unverified".
    assert.ok(
      state.reason.length > 40,
      `${action} reason is too vague: ${state.reason}`,
    );
    assert.ok(state.label && state.label !== action, `${action} needs a label`);
  }
});

test("the blind reason warns about the physical risk, not just the protocol gap", () => {
  // Blind motors are the one gated action that can damage hardware if a guessed
  // frame is wrong, so the reason has to say so.
  assert.match(controllerActionState("blind").reason, /end stop/);
});

test("a profile that enables a capability turns its control on", () => {
  const state = controllerActionState("blind", {
    ...SAFE_LOCAL_PROFILE,
    blindControl: true,
  });
  assert.equal(state.allowed, true);
  assert.equal(state.reason, undefined);
});

test("unknown actions are denied by the same registry as bridge commands", () => {
  const state = controllerActionState("somethingNew");
  assert.equal(state.allowed, false);
  assert.match(state.reason, /active controller profile/);
});

test("the safe type-0 profile exposes the oracle-proven full transfer", () => {
  assert.equal(controllerActionState("sync", null).allowed, true);
  assert.equal(controllerActionState("sync", undefined).allowed, true);
});

test("every action the UI describes as gated is actually gated by the bridge", () => {
  // Pin the two sides together even though the bridge also refuses anything
  // absent from its complete command registry.
  const bridgeGated = new Set(gatedMessageTypes());
  for (const action of gatedControllerActions())
    assert.ok(
      bridgeGated.has(action.messageType),
      `${action.messageType} is described as gated but the bridge does not gate it`,
    );
});

test("the gated summary lists every refused action under the safe profile", () => {
  const gated = gatedControllerActions();
  assert.equal(gated.length, 7);
  assert.ok(gated.every((action) => !action.allowed && action.reason));
  // Enabling one capability removes exactly that action from the summary.
  const withBlind = gatedControllerActions({
    ...SAFE_LOCAL_PROFILE,
    blindControl: true,
  });
  assert.equal(withBlind.length, 6);
  assert.equal(
    withBlind.some((action) => action.messageType === "blind"),
    false,
  );
});
