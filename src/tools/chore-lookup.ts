import type { RawChore } from "@/types";
import type { ToolContext } from "@/tools/context";

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

/**
 * Falls back to the unfiltered list on a miss. A chore can be absent from the cached
 * active one without being archived, which is any chore created or edited elsewhere
 * inside the cache TTL. get_chore already resolves those; without this the nine tools
 * that act on what it returns would report the chore does not exist.
 */
export async function loadChoreById(
  chore_id: number | undefined,
  ctx: ToolContext,
): Promise<RawChore> {
  const id = requireChoreId(chore_id);
  const cached = (await ctx.service.chores()).find((chore) => chore.id === id);
  if (cached) return cached;

  const anywhere = (await ctx.service.allChores()).find((chore) => chore.id === id);
  if (anywhere) return anywhere;

  throw new Error(
    `No chore with id ${id} exists on this account. Use list_chores to see what is there.`,
  );
}

/**
 * An archived chore is by definition absent from the active list, so unarchiving
 * has to look somewhere the default fetch does not reach.
 */
export function loadArchivedChoreById(
  chore_id: number | undefined,
  ctx: ToolContext,
): Promise<RawChore> {
  return loadFrom(chore_id, () => ctx.service.archivedChores(), "the archived chore list");
}

