import type { ChoreListRow } from "@/types";
import { DonetickError } from "@/errors";
import type { ToolContext } from "@/tools/context";

function requireChoreId(chore_id: number | undefined): number {
  if (typeof chore_id !== "number") {
    throw new Error(
      "chore_id is required. Use list_chores or get_chore to find the id for a chore you know by name.",
    );
  }
  return chore_id;
}

/** The chores list row, never GET /details: see ChoreListRow in types.ts. */
async function loadFrom(
  chore_id: number | undefined,
  fetchAll: () => Promise<ChoreListRow[]>,
  whichList: string,
): Promise<ChoreListRow> {
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
 * The single loader every tool resolves a chore id through.
 *
 * Falls back to the unfiltered list on a miss. A chore can be absent from the cached
 * active one without being archived, which is any chore created or edited elsewhere
 * inside the cache TTL. Without that fallback every tool that acts on an id would
 * report the chore does not exist.
 *
 * The /details probe below separates the three ways a lookup can come up empty:
 * genuinely absent, present but undescribable, and a read that failed for some other
 * reason.
 */
export async function loadChoreById(
  chore_id: number | undefined,
  ctx: ToolContext,
): Promise<ChoreListRow> {
  const id = requireChoreId(chore_id);
  const cached = (await ctx.service.chores()).find((chore) => chore.id === id);
  if (cached) return cached;

  const anywhere = (await ctx.service.allChores()).find((chore) => chore.id === id);
  if (anywhere) return anywhere;

  // /details is the not-found probe here, never a data source: it omits every
  // list-only field, and projectChore reports a default for each rather than saying
  // it does not know. A successful read means the chore exists but is invisible to
  // both lists, which this server cannot describe truthfully.
  try {
    await ctx.service.choreDetails(id);
  } catch (error) {
    // Only the statuses that actually mean "not there". A bare catch turned a
    // timeout, a revoked token, or a genuine instance fault into "that chore does
    // not exist", which sends the user looking for data they were told was gone.
    // The 500 is in here because /details answers a missing id with one.
    const missing = error instanceof DonetickError && (error.status === 404 || error.status >= 500);
    if (!missing) throw error;
    throw new Error(
      `No chore with id ${id} exists on this account. Use list_chores to see what is there.`,
    );
  }
  throw new Error(
    `Chore ${id} exists but is not in this account's chore list, so this server cannot read the fields it needs to describe it. Use list_chores to find it by name.`,
  );
}

/**
 * An archived chore is by definition absent from the active list, so unarchiving
 * has to look somewhere the default fetch does not reach.
 */
export async function loadArchivedChoreById(
  chore_id: number | undefined,
  ctx: ToolContext,
): Promise<ChoreListRow> {
  try {
    return await loadFrom(chore_id, () => ctx.service.archivedChores(), "the archived chore list");
  } catch (error) {
    // Only the not-found case. A DonetickError means the archived-list request itself
    // failed, and rewriting it here would drop the invalidatesCache and indeterminate
    // flags that guardWith and fail() read, turning a transport problem into a
    // confident claim about the chore's state.
    if (error instanceof DonetickError) throw error;

    // Otherwise the chore is very likely just not archived, and the shared message
    // blamed deletion for a chore sitting in the active list.
    const id = requireChoreId(chore_id);
    const active = (await ctx.service.chores()).some((chore) => chore.id === id);
    if (!active) throw error;
    throw new Error(
      `Chore ${id} is not archived, so there is nothing to unarchive. Use archive_chore to archive it.`,
    );
  }
}
