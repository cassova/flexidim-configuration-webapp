import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTRACTOR_SCENE_NAMES,
  SECURITY_CONTROL_SCENE_NAMES,
  SECURITY_STEP_COUNT,
  SECURITY_TRIGGER_SCENE_NAMES,
  SIMPLE_SCENE_LEVELS,
  UTILITY_BUTTON_PROMPT,
  UTILITY_BUTTON_SLOTS,
  generateSceneUtility,
} from "../app/scene-utilities.ts";
import { buildGoldenAppData } from "./golden-app-data.mjs";

test("the extractor sequence creates the nine recovered scenes in order", () => {
  const result = generateSceneUtility("extractor", buildGoldenAppData());
  assert.deepEqual(
    result.scenes.map((scene) => scene.name),
    [
      "Extractor Night",
      "Extractor Seq",
      "Start Extractor Now",
      "Stop Extractor Now",
      "Extractor On",
      "Extractor On Night",
      "Extractor Off",
      "Cancel Ex On",
      "Cancel Ex Off",
    ],
  );
  // Nine, not eight: the app creates separate on and off cancel scenes.
  assert.equal(result.scenes.length, 9);
  assert.equal(EXTRACTOR_SCENE_NAMES.length, 9);
});

test("the extractor sequence chains through next-scene and terminates", () => {
  const result = generateSceneUtility("extractor", buildGoldenAppData());
  const scenes = result.scenes;
  for (let index = 0; index < scenes.length - 1; index += 1) {
    assert.equal(
      scenes[index].nextSceneId,
      scenes[index + 1].id,
      `${scenes[index].name} should hand on to ${scenes[index + 1].name}`,
    );
    assert.equal(scenes[index].nextSceneTime, 10);
  }
  // The last scene ends the chain rather than looping back, so a finished
  // sequence stops instead of cycling the fan for ever.
  const last = scenes.at(-1);
  assert.equal(last.nextSceneId, undefined);
  assert.equal(last.nextSceneMode, -1);
  // Only the first scene begins a new sequence.
  assert.deepEqual(
    scenes.map((scene) => Boolean(scene.beginNewSequence)),
    [true, false, false, false, false, false, false, false, false],
  );
});

test("the extractor sequence is created inside its own group", () => {
  const result = generateSceneUtility("extractor", buildGoldenAppData());
  assert.equal(result.sceneGroups.length, 1);
  const [group] = result.sceneGroups;
  assert.equal(group.name, "Extractor Seq");
  assert.equal(group.parentId, null);
  for (const scene of result.scenes) {
    assert.equal(scene.groupId, group.id);
    assert.deepEqual(scene.folderPath, ["Extractor Seq"]);
  }
});

test("the security sequence builds the Steps and Scenes subfolders", () => {
  const result = generateSceneUtility("security", buildGoldenAppData());
  const names = result.sceneGroups.map((group) => group.name);
  assert.deepEqual(names, ["Security Sequence", "Steps", "Scenes"]);
  const [root, steps, targets] = result.sceneGroups;
  assert.equal(root.parentId, null);
  // Both subfolders hang off the root group, not off each other.
  assert.equal(steps.parentId, root.id);
  assert.equal(targets.parentId, root.id);
});

test("the security sequence creates eight steps, eight targets, and the control and trigger scenes", () => {
  const result = generateSceneUtility("security", buildGoldenAppData());
  const named = (pattern) =>
    result.scenes.filter((scene) => pattern.test(scene.name)).map((s) => s.name);

  assert.deepEqual(
    named(/^Step \d$/),
    Array.from({ length: SECURITY_STEP_COUNT }, (_, i) => `Step ${i + 1}`),
  );
  assert.deepEqual(
    named(/^Scene \d$/),
    Array.from({ length: SECURITY_STEP_COUNT }, (_, i) => `Scene ${i + 1}`),
  );
  for (const control of SECURITY_CONTROL_SCENE_NAMES)
    assert.ok(
      result.scenes.some((scene) => scene.name === control),
      `missing control scene ${control}`,
    );
  for (const trigger of SECURITY_TRIGGER_SCENE_NAMES)
    assert.ok(
      result.scenes.some((scene) => scene.name === trigger),
      `missing trigger scene ${trigger}`,
    );
  // 8 steps + 8 targets + 4 control + 4 trigger.
  assert.equal(result.scenes.length, 24);
});

test("each security step runs its matching target through the extender", () => {
  const result = generateSceneUtility("security", buildGoldenAppData());
  const steps = result.scenes.filter((scene) => /^Step \d$/.test(scene.name));
  const targets = result.scenes.filter((scene) => /^Scene \d$/.test(scene.name));
  steps.forEach((step, index) => {
    assert.equal(
      step.extenderSceneId,
      targets[index].id,
      `${step.name} should extend ${targets[index].name}`,
    );
    assert.equal(step.runExtenderFirst, true);
    assert.equal(step.nextSceneTime, 60);
  });
});

test("the security steps chain onward and the last hands to Finish", () => {
  const result = generateSceneUtility("security", buildGoldenAppData());
  const steps = result.scenes.filter((scene) => /^Step \d$/.test(scene.name));
  const finish = result.scenes.find((scene) => scene.name === "Finish");
  for (let index = 0; index < steps.length - 1; index += 1)
    assert.equal(steps[index].nextSceneId, steps[index + 1].id);
  // Terminating at Finish is what stops the occupancy simulation.
  assert.equal(steps.at(-1).nextSceneId, finish.id);
});

test("simple scenes use the first switch in each room and only Bright and Medium", () => {
  const result = generateSceneUtility("simple", buildGoldenAppData());
  // The golden fixture has switches in Lounge (channels 1,2) and Kitchen (3).
  assert.deepEqual(
    result.scenes.map((scene) => scene.name),
    ["Lounge Bright", "Lounge Medium", "Kitchen Bright", "Kitchen Medium"],
  );
  // No "Off" scene: the recovered utility creates two levels per room.
  assert.equal(
    result.scenes.some((scene) => /Off$/.test(scene.name)),
    false,
  );
  assert.deepEqual(
    SIMPLE_SCENE_LEVELS.map((entry) => entry.level),
    [100, 50],
  );
});

test("simple scenes take their channels from the switch's basic assignment", () => {
  const result = generateSceneUtility("simple", buildGoldenAppData());
  const lounge = result.scenes.find((scene) => scene.name === "Lounge Bright");
  const kitchen = result.scenes.find((scene) => scene.name === "Kitchen Bright");
  // Lounge switch has channels 1 and 2 assigned; Kitchen switch has 3.
  assert.deepEqual(Object.keys(lounge.levels).map(Number).sort(), [1, 2]);
  assert.deepEqual(Object.keys(kitchen.levels).map(Number), [3]);
  assert.deepEqual(Object.values(lounge.levels), [100, 100]);
  const medium = result.scenes.find((scene) => scene.name === "Lounge Medium");
  assert.deepEqual(Object.values(medium.levels), [50, 50]);
});

test("rooms with no switch are skipped", () => {
  const result = generateSceneUtility("simple", buildGoldenAppData());
  // "Ground Floor" is a floor with no switch of its own.
  assert.equal(
    result.scenes.some((scene) => scene.name.startsWith("Ground Floor")),
    false,
  );
});

test("the rooms-only option creates no scenes", () => {
  const result = generateSceneUtility("simple", buildGoldenAppData(), {
    roomsOnly: true,
  });
  assert.deepEqual(result.scenes, []);
});

test("generated scenes keep levels and channel settings in step", () => {
  const result = generateSceneUtility("simple", buildGoldenAppData());
  for (const scene of result.scenes) {
    assert.deepEqual(
      Object.keys(scene.levels).sort(),
      Object.keys(scene.channelSettings).sort(),
    );
    for (const [channelId, level] of Object.entries(scene.levels))
      assert.equal(scene.channelSettings[channelId].brightness, level);
  }
});

test("button assignment targets physical buttons 1-3, which are logical slots 1, 3 and 5", () => {
  // A physical button owns two logical slots (2b-1 and 2b). Assigning logical
  // 1/2/3 would stack two scenes on physical button 1 and leave button 3 empty.
  assert.deepEqual(UTILITY_BUTTON_SLOTS, [1, 3, 5]);
  const data = buildGoldenAppData();
  data.assignments = [];
  const result = generateSceneUtility("simple", data, {
    assignToButtons: true,
  });
  const lounge = result.assignments.filter((entry) => entry.switchId === 1);
  assert.deepEqual(
    lounge.map((entry) => entry.button),
    [1, 3],
    "two generated scenes fill the first two physical buttons",
  );
});

test("a button already in use is not overwritten", () => {
  const data = buildGoldenAppData();
  // The golden fixture already assigns switch 1 buttons 1 and 2.
  const result = generateSceneUtility("simple", data, {
    assignToButtons: true,
  });
  const lounge = result.assignments.filter((entry) => entry.switchId === 1);
  // Button 1 is taken, so only button 3 is offered.
  assert.deepEqual(
    lounge.map((entry) => entry.button),
    [3],
  );
});

test("no assignments are produced unless the prompt was accepted", () => {
  for (const utility of ["simple", "extractor", "security"]) {
    const result = generateSceneUtility(utility, buildGoldenAppData());
    assert.deepEqual(
      result.assignments,
      [],
      `${utility} must not assign buttons without consent`,
    );
  }
});

test("the button prompt is offered after every utility, not just simple scenes", () => {
  const data = buildGoldenAppData();
  data.assignments = [];
  for (const utility of ["simple", "extractor", "security"]) {
    const result = generateSceneUtility(utility, data, {
      assignToButtons: true,
    });
    assert.ok(
      result.assignments.length > 0,
      `${utility} should be able to assign buttons`,
    );
  }
  assert.match(UTILITY_BUTTON_PROMPT, /buttons 1, 2 & 3/);
});

test("generated ids never collide with existing or deleted scenes", () => {
  const data = buildGoldenAppData();
  data.deletedScenes = [{ id: 900, name: "Recovered later" }];
  for (const utility of ["simple", "extractor", "security"]) {
    const result = generateSceneUtility(utility, data);
    const used = new Set([
      ...data.scenes.map((scene) => scene.id),
      ...data.deletedScenes.map((scene) => scene.id),
    ]);
    const ids = result.scenes.map((scene) => scene.id);
    assert.equal(new Set(ids).size, ids.length, `${utility} reused an id`);
    for (const id of ids)
      assert.equal(used.has(id), false, `${utility} collided on id ${id}`);
  }
});

test("generated scene groups never collide with existing groups", () => {
  const data = buildGoldenAppData();
  for (const utility of ["extractor", "security"]) {
    const result = generateSceneUtility(utility, data);
    const existing = new Set(data.sceneGroups.map((group) => group.id));
    const ids = result.sceneGroups.map((group) => group.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(existing.has(id), false);
  }
});

test("every generated scene is tagged with the utility that made it", () => {
  for (const utility of ["simple", "extractor", "security"]) {
    const result = generateSceneUtility(utility, buildGoldenAppData());
    for (const scene of result.scenes) assert.equal(scene.utility, utility);
  }
});
