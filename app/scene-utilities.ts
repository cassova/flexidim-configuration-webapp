import type { AppData, Scene, SceneGroup, Assignment } from "./fd4cfg.ts";

/**
 * The three "Scene Creation Utilities" recovered from the iOS app.
 *
 * Source: `-[JCLScenesMasterViewController actionSheet:didDismissWithButtonIndex:]`
 * at 0x1000ab874, reached from the "Scene Creation Utilities" sheet. See
 * `work/binary-findings.md` Q8 for the recovered scene sets and rules.
 *
 * These are pure functions returning the objects to add, so the exact generated
 * shape can be asserted in tests rather than inspected through the UI.
 */

export type SceneUtility = "simple" | "extractor" | "security";

/**
 * The extractor-fan sequence, in the order the app creates it. Nine scenes —
 * note "Extractor Seq" (not "Sequence") and the two separate cancel scenes.
 */
export const EXTRACTOR_SCENE_NAMES = [
  "Extractor Night",
  "Extractor Seq",
  "Start Extractor Now",
  "Stop Extractor Now",
  "Extractor On",
  "Extractor On Night",
  "Extractor Off",
  "Cancel Ex On",
  "Cancel Ex Off",
] as const;

/** The security sequence's control scenes, in creation order. */
export const SECURITY_CONTROL_SCENE_NAMES = [
  "Initialise",
  "Stopping",
  "Starting",
  "Finish",
] as const;

/** Its trigger scenes: a long and a short name for each of start and stop. */
export const SECURITY_TRIGGER_SCENE_NAMES = [
  "Start",
  "Sec start",
  "Stop",
  "Sec stop",
] as const;

export const SECURITY_STEP_COUNT = 8;

/** The two levels Create Simple Scenes produces per room. */
export const SIMPLE_SCENE_LEVELS: { suffix: string; level: number }[] = [
  { suffix: "Bright", level: 100 },
  { suffix: "Medium", level: 50 },
];

/**
 * The physical buttons the post-generation prompt offers ("buttons 1, 2 & 3").
 *
 * A physical button maps to two logical slots (2b-1 and 2b), so physical
 * buttons 1-3 are logical slots 1, 3 and 5. Assigning logical 1/2/3 would put
 * two scenes on physical button 1 and none on button 3.
 */
export const UTILITY_BUTTON_SLOTS = [1, 3, 5];

export type SceneUtilityOptions = {
  /**
   * The post-generation prompt: "Put automatically created scenes on to buttons
   * 1, 2 & 3 if the button is not currently in use?" Offered after every
   * utility, not just Simple Scenes.
   */
  assignToButtons?: boolean;
  /** Create Simple Scenes' "Create rooms/areas only" option. */
  roomsOnly?: boolean;
  /** Icon for any created group, matching the scene-group default. */
  groupIcon?: string;
};

export type SceneUtilityResult = {
  scenes: Scene[];
  sceneGroups: SceneGroup[];
  assignments: Assignment[];
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function nextId(existing: { id: number }[]) {
  return existing.reduce((highest, item) => Math.max(highest, item.id), 0) + 1;
}

/**
 * A generated scene. `levels` and `channelSettings` are kept in step so a
 * generated scene behaves like an edited one.
 */
function makeScene(
  id: number,
  name: string,
  levels: Record<number, number>,
  utility: SceneUtility,
  group: { id?: number; name: string; path: string[] },
  extra: Partial<Scene> = {},
): Scene {
  return {
    id,
    name,
    shortName: name,
    group: group.name,
    groupId: group.id,
    folderPath: group.path,
    levels,
    channelSettings: Object.fromEntries(
      Object.entries(levels).map(([channelId, brightness]) => [
        Number(channelId),
        {
          brightness,
          fadeTime: 2,
          relativePercent: false,
          use100PercentTime: false,
          delay: 0,
          flags: 0,
        },
      ]),
    ),
    fade: 0,
    enabled: true,
    days: [...DAY_NAMES],
    time: "",
    utility,
    ...extra,
  };
}

/**
 * Create Simple Scenes.
 *
 * Recovered rule: "for each room/area that has a switch, the Basic Assignments
 * of the FIRST switch in the room choose the channels; rooms/areas are created
 * as necessary." First means first in the configuration's switch order, not the
 * lowest id or the one with the most channels.
 */
function simpleScenes(
  data: AppData,
  options: SceneUtilityOptions,
): SceneUtilityResult {
  const scenes: Scene[] = [];
  const assignments: Assignment[] = [];
  let sceneId = nextId([...data.scenes, ...(data.deletedScenes ?? [])]);

  for (const room of data.rooms) {
    // The FIRST switch in the room, in switch-list order.
    const wallSwitch = data.switches.find(
      (item) => item.roomId === room.id && item.basic?.channelIds?.length,
    );
    if (!wallSwitch) continue;
    if (options.roomsOnly) continue;
    const channelIds = wallSwitch.basic?.channelIds ?? [];
    const group = {
      id: undefined as number | undefined,
      name: room.name,
      path: [room.name],
    };
    const created = SIMPLE_SCENE_LEVELS.map(({ suffix, level }) =>
      makeScene(
        sceneId++,
        `${room.name} ${suffix}`,
        Object.fromEntries(channelIds.map((id) => [id, level])),
        "simple",
        group,
      ),
    );
    scenes.push(...created);
    if (options.assignToButtons)
      assignments.push(
        ...assignToFreeButtons(wallSwitch.id, created, data.assignments),
      );
  }
  return { scenes, sceneGroups: [], assignments };
}

/**
 * Assign generated scenes to physical buttons 1-3, skipping any button already
 * in use — "if the button is not currently in use".
 */
function assignToFreeButtons(
  switchId: number,
  created: Scene[],
  existing: Assignment[],
): Assignment[] {
  const assignments: Assignment[] = [];
  UTILITY_BUTTON_SLOTS.forEach((button, index) => {
    const scene = created[index];
    if (!scene) return;
    const taken = existing.some(
      (item) => item.switchId === switchId && item.button === button,
    );
    if (taken) return;
    assignments.push({ switchId, button, sceneId: scene.id });
  });
  return assignments;
}

/**
 * Create Extractor Sequence: one group holding the nine extractor scenes,
 * chained through next-scene so the timed fan sequence runs.
 */
function extractorSequence(
  data: AppData,
  options: SceneUtilityOptions,
): SceneUtilityResult {
  const sceneId = nextId([...data.scenes, ...(data.deletedScenes ?? [])]);
  const groupId = nextId(data.sceneGroups);
  const icon = options.groupIcon ?? "/flexidim/rooms/0.png";
  const group: SceneGroup = {
    id: groupId,
    name: "Extractor Seq",
    shortName: "Extractor",
    parentId: null,
    icon,
    displayRank: data.sceneGroups.length,
  };
  const target = { id: groupId, name: group.name, path: [group.name] };

  const created = EXTRACTOR_SCENE_NAMES.map((name, index) =>
    makeScene(sceneId + index, name, {}, "extractor", target, {
      beginNewSequence: index === 0,
    }),
  );
  // Chain each scene to the next so the sequence advances on its own. The last
  // scene ends the chain rather than looping, so a finished sequence stops.
  const chained = created.map((scene, index) => ({
    ...scene,
    nextSceneId: created[index + 1]?.id,
    nextSceneMode: created[index + 1] ? 0 : -1,
    nextSceneTime: created[index + 1] ? 10 : 0,
  }));

  return {
    scenes: chained,
    sceneGroups: [group],
    assignments: options.assignToButtons
      ? assignToFreeButtons(
          data.switches[0]?.id ?? 0,
          chained,
          data.assignments,
        ).filter(() => data.switches.length > 0)
      : [],
  };
}

/**
 * Create Security Sequence: an occupancy simulation.
 *
 * Recovered structure: a "Security Sequence" group containing "Steps" and
 * "Scenes" subfolders, "Step 1".."Step 8" in Steps, "Scene 1".."Scene 8" in
 * Scenes, the four control scenes, and the start/stop trigger pairs.
 */
function securitySequence(
  data: AppData,
  options: SceneUtilityOptions,
): SceneUtilityResult {
  let sceneId = nextId([...data.scenes, ...(data.deletedScenes ?? [])]);
  let groupId = nextId(data.sceneGroups);
  const icon = options.groupIcon ?? "/flexidim/rooms/0.png";

  const root: SceneGroup = {
    id: groupId++,
    name: "Security Sequence",
    shortName: "Security",
    parentId: null,
    icon,
    displayRank: data.sceneGroups.length,
  };
  const steps: SceneGroup = {
    id: groupId++,
    name: "Steps",
    shortName: "Steps",
    parentId: root.id,
    icon,
    displayRank: 0,
  };
  const targets: SceneGroup = {
    id: groupId++,
    name: "Scenes",
    shortName: "Scenes",
    parentId: root.id,
    icon,
    displayRank: 1,
  };

  const inSteps = {
    id: steps.id,
    name: steps.name,
    path: [root.name, steps.name],
  };
  const inTargets = {
    id: targets.id,
    name: targets.name,
    path: [root.name, targets.name],
  };
  const inRoot = { id: root.id, name: root.name, path: [root.name] };

  const stepScenes = Array.from({ length: SECURITY_STEP_COUNT }, (_, index) =>
    makeScene(sceneId++, `Step ${index + 1}`, {}, "security", inSteps, {
      beginNewSequence: index === 0,
    }),
  );
  const targetScenes = Array.from({ length: SECURITY_STEP_COUNT }, (_, index) =>
    makeScene(sceneId++, `Scene ${index + 1}`, {}, "security", inTargets),
  );
  const controlScenes = SECURITY_CONTROL_SCENE_NAMES.map((name) =>
    makeScene(sceneId++, name, {}, "security", inRoot),
  );
  const triggerScenes = SECURITY_TRIGGER_SCENE_NAMES.map((name) =>
    makeScene(sceneId++, name, {}, "security", inRoot),
  );

  // Each step runs its matching target scene through the extender, and hands on
  // to the next step. Step 8 returns to "Finish" so the simulation terminates
  // instead of running for ever.
  const finish = controlScenes.find((scene) => scene.name === "Finish");
  const chainedSteps = stepScenes.map((scene, index) => ({
    ...scene,
    extenderSceneId: targetScenes[index].id,
    runExtenderFirst: true,
    nextSceneId: stepScenes[index + 1]?.id ?? finish?.id,
    nextSceneMode: 0,
    // Occupancy simulation advances on a timer rather than instantly.
    nextSceneTime: 60,
  }));

  const scenes = [
    ...chainedSteps,
    ...targetScenes,
    ...controlScenes,
    ...triggerScenes,
  ];
  return {
    scenes,
    sceneGroups: [root, steps, targets],
    assignments: options.assignToButtons
      ? assignToFreeButtons(
          data.switches[0]?.id ?? 0,
          triggerScenes,
          data.assignments,
        ).filter(() => data.switches.length > 0)
      : [],
  };
}

/** Run one of the recovered scene-creation utilities. */
export function generateSceneUtility(
  utility: SceneUtility,
  data: AppData,
  options: SceneUtilityOptions = {},
): SceneUtilityResult {
  if (utility === "simple") return simpleScenes(data, options);
  if (utility === "extractor") return extractorSequence(data, options);
  return securitySequence(data, options);
}

/** The prompt the app shows after any utility runs, verbatim. */
export const UTILITY_BUTTON_PROMPT =
  "Put automatically created scenes on to buttons 1, 2 & 3 if the button is not currently in use?";
