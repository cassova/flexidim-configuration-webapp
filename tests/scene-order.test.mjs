import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWN_SCENE_FLAG_MASK,
  SCENE_FLAG_AUTO_START,
  SCENE_FLAG_BEGIN_NEW_SEQUENCE,
  UNRECOVERED_SCENE_FLAGS,
  editScene,
  moveScene,
  moveSceneGroup,
  orderedScenes,
  reparentScene,
  sceneFlag,
  sceneIsLocked,
  scenesReferencingScene,
  switchesAffectedByScene,
  unknownSceneFlagBits,
  withSceneFlag,
} from "../app/scene-order.ts";
import { buildGoldenAppData } from "./golden-app-data.mjs";

// --- Flags ------------------------------------------------------------------

test("the two established flag bits read back correctly", () => {
  const scene = { id: 1, flags: SCENE_FLAG_AUTO_START };
  assert.equal(sceneFlag(scene, SCENE_FLAG_AUTO_START), true);
  assert.equal(sceneFlag(scene, SCENE_FLAG_BEGIN_NEW_SEQUENCE), false);
  assert.equal(sceneFlag({ id: 1 }, SCENE_FLAG_AUTO_START), false);
});

test("setting a known flag preserves every bit the build does not understand", () => {
  // 0x41 are bits with no recovered meaning. Editing auto-start must not touch
  // them, or a round-trip would silently drop controller behaviour.
  const scene = { id: 1, flags: 0x41 };
  const on = withSceneFlag(scene, SCENE_FLAG_AUTO_START, true);
  assert.equal(on.flags, 0x41 | SCENE_FLAG_AUTO_START);
  const off = withSceneFlag(on, SCENE_FLAG_AUTO_START, false);
  assert.equal(off.flags, 0x41, "unknown bits must survive a clear");
});

test("clearing a flag that was never set is a no-op on the rest", () => {
  const scene = { id: 1, flags: 0x20 };
  assert.equal(withSceneFlag(scene, SCENE_FLAG_AUTO_START, false).flags, 0x20);
});

test("unknown flag bits are reported rather than silently ignored", () => {
  assert.equal(unknownSceneFlagBits({ id: 1, flags: 0xa0 }), 0);
  assert.equal(unknownSceneFlagBits({ id: 1, flags: 0xa1 }), 1);
  assert.equal(unknownSceneFlagBits({ id: 1, flags: 0x0f }), 0x0f);
  assert.equal(KNOWN_SCENE_FLAG_MASK, 0xa0);
});

test("the flags whose bit positions were not recovered are named, not guessed", () => {
  // Writing a guessed bit for these would change controller behaviour on
  // evidence we do not have.
  assert.deepEqual([...UNRECOVERED_SCENE_FLAGS], [
    "noExtender",
    "extenderSceneBC",
  ]);
});

// --- Ordering ---------------------------------------------------------------

test("scenes sort by displayRank with a stable id tiebreak", () => {
  const scenes = [
    { id: 3, displayRank: 1 },
    { id: 1, displayRank: 1 },
    { id: 2, displayRank: 0 },
    { id: 4 },
  ];
  // Scene 4 has no rank, so it defaults to 0 and ties with scene 2; the id
  // tiebreak puts 2 first. Scenes 1 and 3 tie at rank 1, so 1 precedes 3.
  assert.deepEqual(
    orderedScenes(scenes).map((scene) => scene.id),
    [2, 4, 1, 3],
  );
});

test("moving a scene reorders it within its group and renumbers densely", () => {
  const scenes = [
    { id: 1, groupId: 1, displayRank: 0 },
    { id: 2, groupId: 1, displayRank: 1 },
    { id: 3, groupId: 1, displayRank: 2 },
  ];
  const moved = moveScene(scenes, 3, -1);
  assert.deepEqual(
    orderedScenes(moved).map((scene) => scene.id),
    [1, 3, 2],
  );
  // Dense 0..n-1 ranks: gaps or duplicates would make the next move ambiguous.
  assert.deepEqual(
    orderedScenes(moved).map((scene) => scene.displayRank),
    [0, 1, 2],
  );
});

test("moving a scene never disturbs another group", () => {
  const scenes = [
    { id: 1, groupId: 1, displayRank: 0 },
    { id: 2, groupId: 1, displayRank: 1 },
    { id: 9, groupId: 2, displayRank: 7 },
  ];
  const moved = moveScene(scenes, 2, -1);
  assert.equal(moved.find((scene) => scene.id === 9).displayRank, 7);
});

test("moving past either end of a group is a no-op", () => {
  const scenes = [
    { id: 1, groupId: 1, displayRank: 0 },
    { id: 2, groupId: 1, displayRank: 1 },
  ];
  assert.deepEqual(moveScene(scenes, 1, -1), scenes);
  assert.deepEqual(moveScene(scenes, 2, 1), scenes);
  assert.deepEqual(moveScene(scenes, 99, 1), scenes);
});

test("scene groups reorder only among their own siblings", () => {
  const groups = [
    { id: 1, parentId: null, displayRank: 0 },
    { id: 2, parentId: null, displayRank: 1 },
    { id: 3, parentId: 1, displayRank: 0 },
  ];
  const moved = moveSceneGroup(groups, 2, -1);
  assert.deepEqual(
    moved.filter((g) => g.parentId === null).map((g) => [g.id, g.displayRank]),
    [
      [1, 1],
      [2, 0],
    ],
  );
  // The child group is untouched.
  assert.equal(moved.find((g) => g.id === 3).displayRank, 0);
});

test("reparenting places the scene last in its new group and closes the old gap", () => {
  const scenes = [
    { id: 1, groupId: 1, displayRank: 0 },
    { id: 2, groupId: 1, displayRank: 1 },
    { id: 3, groupId: 1, displayRank: 2 },
    { id: 4, groupId: 2, displayRank: 0 },
  ];
  const moved = reparentScene(scenes, 2, 2, "Target", ["Target"]);
  const target = moved.find((scene) => scene.id === 2);
  assert.equal(target.groupId, 2);
  assert.equal(target.group, "Target");
  assert.deepEqual(target.folderPath, ["Target"]);
  // Last in the new group.
  assert.deepEqual(
    orderedScenes(moved.filter((s) => s.groupId === 2)).map((s) => s.id),
    [4, 2],
  );
  // The old group renumbers with no hole where the scene was.
  assert.deepEqual(
    orderedScenes(moved.filter((s) => s.groupId === 1)).map((s) => [
      s.id,
      s.displayRank,
    ]),
    [
      [1, 0],
      [3, 1],
    ],
  );
});

test("reparenting into the same group changes nothing", () => {
  const scenes = [{ id: 1, groupId: 1, displayRank: 0 }];
  assert.deepEqual(reparentScene(scenes, 1, 1, "Same", ["Same"]), scenes);
});

// --- Locking ----------------------------------------------------------------

test("a locked scene refuses edits", () => {
  const locked = { id: 1, name: "Locked", locked: true };
  assert.equal(sceneIsLocked(locked), true);
  assert.equal(editScene(locked, { name: "Renamed" }).name, "Locked");
  assert.equal(editScene(locked, { fade: 5 }).fade, undefined);
});

test("an unlocked scene accepts edits", () => {
  const scene = { id: 1, name: "Open" };
  assert.equal(sceneIsLocked(scene), false);
  assert.equal(editScene(scene, { name: "Renamed" }).name, "Renamed");
});

test("a locked scene can still be unlocked", () => {
  // Otherwise locking would be irreversible.
  const locked = { id: 1, name: "Locked", locked: true };
  assert.equal(editScene(locked, { locked: false }).locked, false);
  // But unlocking cannot be smuggled in alongside another change.
  const sneaky = editScene(locked, { locked: false, name: "Renamed" });
  assert.equal(sneaky.name, "Locked");
});

// --- Affected switches ------------------------------------------------------

test("affected switches lists every button that runs a scene", () => {
  const data = buildGoldenAppData();
  // Golden: switch 1 button 2 and switch 2 button 1 both run scene 2.
  const affected = switchesAffectedByScene(data, 2);
  assert.deepEqual(
    affected.map((entry) => [entry.wallSwitch.id, entry.buttons]),
    [
      [1, [2]],
      [2, [1]],
    ],
  );
});

test("a scene on no button affects no switches", () => {
  const data = buildGoldenAppData();
  assert.deepEqual(switchesAffectedByScene(data, 999), []);
});

test("multiple buttons on one switch are grouped and sorted", () => {
  const data = buildGoldenAppData();
  data.assignments = [
    { switchId: 1, button: 5, sceneId: 1 },
    { switchId: 1, button: 1, sceneId: 1 },
  ];
  const affected = switchesAffectedByScene(data, 1);
  assert.equal(affected.length, 1);
  assert.deepEqual(affected[0].buttons, [1, 5]);
});

test("scenes linked to a scene are found through next, previous and extender", () => {
  const data = buildGoldenAppData();
  // Golden scene 1 has nextSceneId 2; scene 2 has previousSceneId 1.
  assert.deepEqual(
    scenesReferencingScene(data, 2).map((scene) => scene.id),
    [1],
  );
  assert.deepEqual(
    scenesReferencingScene(data, 1).map((scene) => scene.id),
    [2],
  );
  data.scenes[0].extenderSceneId = 2;
  assert.deepEqual(
    scenesReferencingScene(data, 2).map((scene) => scene.id),
    [1],
  );
});

test("a scene never counts as referencing itself", () => {
  const data = buildGoldenAppData();
  data.scenes[0].nextSceneId = data.scenes[0].id;
  assert.equal(
    scenesReferencingScene(data, data.scenes[0].id).some(
      (scene) => scene.id === data.scenes[0].id,
    ),
    false,
  );
});
