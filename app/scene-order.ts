import type { AppData, Scene, SceneGroup, WallSwitch } from "./fd4cfg.ts";

/**
 * Scene flags, ordering, locking and affected-switch lookup.
 *
 * FLAGS — the archive's `fl` is a bitfield. From the binary (Q7): the bits
 * correspond to the scene-detail toggles `autoStart`, `extenderNewSeq`,
 * `noExtender` and `extenderSceneBC`. The scene coder stores `fl` verbatim
 * (0x10005bba8) and never fans it out, and the fan-out in `-compileConfig` is
 * too heavily spilled to read, so only two masks are established by convention
 * and observed archives. The other two are NOT known.
 *
 * The rule this module enforces: bits we do not understand are preserved
 * untouched. Editing a known toggle must never clear an unknown bit.
 */

/** Auto-start. Established by convention and consistent with real archives. */
export const SCENE_FLAG_AUTO_START = 0x80;
/** "Begin new sequence" (`extenderNewSeq`). */
export const SCENE_FLAG_BEGIN_NEW_SEQUENCE = 0x20;

/** Every bit this build claims to understand. */
export const KNOWN_SCENE_FLAG_MASK =
  SCENE_FLAG_AUTO_START | SCENE_FLAG_BEGIN_NEW_SEQUENCE;

/**
 * Toggles the original app shows whose bit positions were not recovered. They
 * are listed so the UI can say so rather than write a guessed bit.
 */
export const UNRECOVERED_SCENE_FLAGS = ["noExtender", "extenderSceneBC"] as const;

export function sceneFlag(scene: Scene, mask: number) {
  return Boolean((scene.flags ?? 0) & mask);
}

/**
 * Set or clear a known flag bit, leaving every other bit exactly as it was.
 * This is why the mask is applied rather than the value replaced.
 */
export function withSceneFlag(scene: Scene, mask: number, on: boolean): Scene {
  const flags = on ? (scene.flags ?? 0) | mask : (scene.flags ?? 0) & ~mask;
  return { ...scene, flags };
}

/** Bits set in a scene that this build cannot explain. Must round-trip. */
export function unknownSceneFlagBits(scene: Scene) {
  return (scene.flags ?? 0) & ~KNOWN_SCENE_FLAG_MASK;
}

// --- Ordering ---------------------------------------------------------------

/**
 * Scenes in display order.
 *
 * `dr` is displayRank — a manual sort order, not a duration. Ties fall back to
 * id so the order is total and stable; an unstable order would make the list
 * jump around as unrelated edits happen.
 */
export function orderedScenes<T extends { displayRank?: number; id: number }>(
  items: T[],
): T[] {
  return [...items].sort(
    (left, right) =>
      (left.displayRank ?? 0) - (right.displayRank ?? 0) || left.id - right.id,
  );
}

/**
 * Move a scene one place within its own group, returning every scene with
 * renumbered ranks.
 *
 * Ranks are rewritten densely from 0 after the swap: leaving gaps or duplicates
 * makes a later move ambiguous.
 */
export function moveScene(
  scenes: Scene[],
  sceneId: number,
  direction: -1 | 1,
): Scene[] {
  const target = scenes.find((scene) => scene.id === sceneId);
  if (!target) return scenes;
  const siblings = orderedScenes(
    scenes.filter((scene) => scene.groupId === target.groupId),
  );
  const from = siblings.findIndex((scene) => scene.id === sceneId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= siblings.length) return scenes;
  [siblings[from], siblings[to]] = [siblings[to], siblings[from]];
  const ranks = new Map(siblings.map((scene, index) => [scene.id, index]));
  return scenes.map((scene) =>
    ranks.has(scene.id)
      ? { ...scene, displayRank: ranks.get(scene.id) }
      : scene,
  );
}

/** Move a scene group one place among its siblings, renumbering ranks. */
export function moveSceneGroup(
  groups: SceneGroup[],
  groupId: number,
  direction: -1 | 1,
): SceneGroup[] {
  const target = groups.find((group) => group.id === groupId);
  if (!target) return groups;
  const siblings = orderedScenes(
    groups.filter((group) => group.parentId === target.parentId),
  );
  const from = siblings.findIndex((group) => group.id === groupId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= siblings.length) return groups;
  [siblings[from], siblings[to]] = [siblings[to], siblings[from]];
  const ranks = new Map(siblings.map((group, index) => [group.id, index]));
  return groups.map((group) =>
    ranks.has(group.id)
      ? { ...group, displayRank: ranks.get(group.id)! }
      : group,
  );
}

/**
 * Move a scene into a different group, placing it last and renumbering both the
 * old and new group's ranks so neither is left with a hole.
 */
export function reparentScene(
  scenes: Scene[],
  sceneId: number,
  groupId: number | undefined,
  groupName: string,
  folderPath: string[],
): Scene[] {
  const target = scenes.find((scene) => scene.id === sceneId);
  if (!target || target.groupId === groupId) return scenes;
  const previousGroupId = target.groupId;
  const moved = scenes.map((scene) =>
    scene.id === sceneId
      ? { ...scene, groupId, group: groupName, folderPath }
      : scene,
  );
  const renumber = (list: Scene[], id: number | undefined) => {
    const ranks = new Map(
      orderedScenes(list.filter((scene) => scene.groupId === id)).map(
        (scene, index) => [scene.id, index],
      ),
    );
    return list.map((scene) =>
      ranks.has(scene.id)
        ? { ...scene, displayRank: ranks.get(scene.id) }
        : scene,
    );
  };
  // The moved scene goes last in its new group: a large rank sorts to the end,
  // then the dense renumber turns it into the correct final index.
  return renumber(
    renumber(
      moved.map((scene) =>
        scene.id === sceneId
          ? { ...scene, displayRank: Number.MAX_SAFE_INTEGER }
          : scene,
      ),
      groupId,
    ),
    previousGroupId,
  );
}

// --- Locking ----------------------------------------------------------------

/**
 * Whether a scene is locked (`lk`). A locked scene is read-only in the original
 * app: it can be run but not edited.
 */
export function sceneIsLocked(scene: Scene) {
  return Boolean(scene.locked);
}

/**
 * Apply an edit to a scene, refusing it when the scene is locked.
 *
 * Returning the scene unchanged rather than throwing matches the app, where a
 * locked scene's controls are simply inert. `locked` itself is always editable,
 * otherwise a scene could never be unlocked.
 */
export function editScene(scene: Scene, patch: Partial<Scene>): Scene {
  const onlyLockChange =
    Object.keys(patch).length === 1 && "locked" in patch;
  if (sceneIsLocked(scene) && !onlyLockChange) return scene;
  return { ...scene, ...patch };
}

// --- Affected switches ------------------------------------------------------

/**
 * The switches whose buttons run a scene.
 *
 * This is the app's "affected switches" function: before changing or deleting a
 * scene an installer needs to know which wall switches will change behaviour.
 */
export function switchesAffectedByScene(
  data: AppData,
  sceneId: number,
): { wallSwitch: WallSwitch; buttons: number[] }[] {
  const buttonsBySwitch = new Map<number, number[]>();
  for (const assignment of data.assignments) {
    if (assignment.sceneId !== sceneId) continue;
    const buttons = buttonsBySwitch.get(assignment.switchId) ?? [];
    buttons.push(assignment.button);
    buttonsBySwitch.set(assignment.switchId, buttons);
  }
  return data.switches
    .filter((wallSwitch) => buttonsBySwitch.has(wallSwitch.id))
    .map((wallSwitch) => ({
      wallSwitch,
      buttons: [...buttonsBySwitch.get(wallSwitch.id)!].sort(
        (left, right) => left - right,
      ),
    }));
}

/**
 * Scenes that reference a scene through next-scene, previous-scene or the
 * extender. Deleting a scene silently breaks these links otherwise.
 */
export function scenesReferencingScene(data: AppData, sceneId: number) {
  return data.scenes.filter(
    (scene) =>
      scene.id !== sceneId &&
      (scene.nextSceneId === sceneId ||
        scene.previousSceneId === sceneId ||
        scene.extenderSceneId === sceneId),
  );
}
