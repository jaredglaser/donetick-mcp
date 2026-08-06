import type { RawChore } from "@/types";
import type { WriteContext } from "@/tools/write";

/**
 * Every tool that acts on a chore resolves it through here, from the chores list
 * rather than GET /details. The details view omits assignStrategy, assignees,
 * frequency, frequencyMetadata, isRolling, isPrivate, labelsV2, notification,
 * notificationMetadata, points and requireApproval, which is every field a write
 * needs, so using it as a merge base destroys them.
 */
async function loadFrom(
  chore_id: number | undefined,
  fetchAll: () => Promise<RawChore[]>,
  whichList: string,
): Promise<RawChore> {
  if (typeof chore_id !== "number") {
    throw new Error(
      "chore_id is required. Use list_chores or get_chore to find the id for a chore you know by name.",
    );
  }
  const all = await fetchAll();
  const found = all.find((chore) => chore.id === chore_id);
  if (!found) {
    throw new Error(
      `No chore with id ${chore_id} is in ${whichList}. It may have been deleted, or archived since the list was last read.`,
    );
  }
  return found;
}

export function loadChoreById(chore_id: number | undefined, ctx: WriteContext): Promise<RawChore> {
  return loadFrom(chore_id, () => ctx.service.chores(), "the active chore list");
}

/**
 * An archived chore is by definition absent from the active list, so unarchiving
 * has to look somewhere the default fetch does not reach.
 */
export function loadArchivedChoreById(
  chore_id: number | undefined,
  ctx: WriteContext,
): Promise<RawChore> {
  return loadFrom(chore_id, () => ctx.service.archivedChores(), "the archived chore list");
}
