import type { RawChore } from "@/types";
import type { WriteContext } from "@/tools/write";

function requireChoreId(chore_id: number | undefined): number {
  if (typeof chore_id !== "number") {
    throw new Error(
      "chore_id is required. Use list_chores or get_chore to find the id for a chore you know by name.",
    );
  }
  return chore_id;
}

/** The chores list row, never GET /details: see assertListRowShape in chore-request.ts. */
async function loadFrom(
  chore_id: number | undefined,
  fetchAll: () => Promise<RawChore[]>,
  whichList: string,
): Promise<RawChore> {
  const id = requireChoreId(chore_id);
  const all = await fetchAll();
  const found = all.find((chore) => chore.id === id);
  if (!found) {
    throw new Error(
      `No chore with id ${id} is in ${whichList}. It may have been deleted, or archived since the list was last read.`,
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

