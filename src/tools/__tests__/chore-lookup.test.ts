import { describe, expect, test } from "bun:test";
import { loadArchivedChoreById, loadChoreById } from "../chore-lookup";
import { DonetickError } from "@/errors";
import type { ToolContext } from "@/tools/context";
import type { RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");

const row = (id: number, name: string): RawChore =>
  ({ id, name, nextDueDate: null, assignedTo: null, priority: 0, status: 0,
     frequencyType: "once", createdBy: 1 }) as unknown as RawChore;

/**
 * cached and everywhere are deliberately different lists.
 *
 * Every other fake in the suite returns the same array from chores() and
 * allChores(), which made the fallback in loadChoreById indistinguishable from the
 * cached path: deleting it entirely failed nothing. That fallback is the whole
 * "someone added a chore in the web UI while our cache was warm" story, and it is
 * reached by nine tools.
 */
function ctxFor(
  cached: RawChore[],
  everywhere: RawChore[],
  details: () => Promise<unknown> = async () => {
    throw new DonetickError("chore not found", { status: 404 });
  },
) {
  let allChoresCalls = 0;
  let detailsCalls = 0;
  const service = {
    chores: async () => cached,
    allChores: async () => {
      allChoresCalls += 1;
      return everywhere;
    },
    choreDetails: async () => {
      detailsCalls += 1;
      return details();
    },
  };
  const ctx: ToolContext = { service: service as never, now: () => now, timezone: "America/New_York" };
  return { ctx, allChoresCalls: () => allChoresCalls, detailsCalls: () => detailsCalls };
}

describe("loadChoreById", () => {
  test("returns a chore that is in the cache without widening the search", async () => {
    const { ctx, allChoresCalls } = ctxFor([row(7, "Cached")], [row(9, "Elsewhere")]);

    expect((await loadChoreById(7, ctx)).name).toBe("Cached");
    expect(allChoresCalls()).toBe(0);
  });

  test("falls back to the unfiltered list for a chore the cache has never seen", async () => {
    // The web-UI case: the chore was created out of band, the caller already has its
    // id, and the cached list predates it.
    const { ctx, allChoresCalls } = ctxFor([row(7, "Cached")], [row(9, "Created in the web UI")]);

    expect((await loadChoreById(9, ctx)).name).toBe("Created in the web UI");
    expect(allChoresCalls()).toBe(1);
  });

  test("finds an archived chore, which the plain list omits", async () => {
    const { ctx } = ctxFor([], [row(11, "Archived")]);

    expect((await loadChoreById(11, ctx)).name).toBe("Archived");
  });

  test("reports a genuinely missing id rather than returning the wrong chore", async () => {
    const { ctx, detailsCalls } = ctxFor([row(7, "Cached")], [row(9, "Elsewhere")]);

    await expect(loadChoreById(404, ctx)).rejects.toThrow(/No chore with id 404/);
    expect(detailsCalls()).toBe(1);
  });

  test("a 500 from /details still reads as not found, since that is how it answers a missing id", async () => {
    const { ctx } = ctxFor([], [], async () => {
      throw new DonetickError("The Donetick instance returned an error.", { status: 500 });
    });

    await expect(loadChoreById(404, ctx)).rejects.toThrow(/No chore with id 404/);
  });

  test("a chore neither list carries but /details can read is called undescribable, not missing", async () => {
    // /details omits every list-only field and projectChore reports a default for
    // each rather than saying it does not know, so this server cannot describe the
    // chore truthfully. Saying it does not exist would send the user looking for
    // data that is there.
    const { ctx } = ctxFor([], [], async () => ({ id: 404, name: "Invisible" }));

    await expect(loadChoreById(404, ctx)).rejects.toThrow(/exists but is not in this account's chore list/);
  });

  test("a timeout keeps its own reason instead of becoming a missing chore", async () => {
    // A bare catch turned a timeout, a revoked token, or a genuine instance fault
    // into "that chore does not exist". This used to hold only for get_chore and
    // delete_chore, which had their own copy of the id path.
    const { ctx } = ctxFor([], [], async () => {
      throw new DonetickError("The request to https://donetick.test timed out after 15000ms.", { status: 0 });
    });

    const error = await loadChoreById(404, ctx).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/timed out/);
    expect((error as Error).message).not.toMatch(/No chore with id/);
  });

  test("an absent id is refused before either list is read", async () => {
    const { ctx, allChoresCalls } = ctxFor([row(7, "Cached")], []);

    await expect(loadChoreById(undefined, ctx)).rejects.toThrow();
    expect(allChoresCalls()).toBe(0);
  });
});

describe("loadArchivedChoreById", () => {
  // Its whole catch branch had no coverage: removing the DonetickError rethrow, or
  // the branch entirely, failed nothing.
  function archivedCtx(archived: RawChore[], active: RawChore[], archivedError?: Error) {
    const service = {
      chores: async () => active,
      allChores: async () => [...active, ...archived],
      archivedChores: async () => {
        if (archivedError) throw archivedError;
        return archived;
      },
    };
    return { service: service as never, now: () => now, timezone: "America/New_York" } as ToolContext;
  }

  test("returns an archived chore", async () => {
    const ctx = archivedCtx([row(11, "Archived")], []);
    expect((await loadArchivedChoreById(11, ctx)).name).toBe("Archived");
  });

  test("a chore that is merely active is told it is not archived, not that it was deleted", async () => {
    const ctx = archivedCtx([], [row(7, "Still active")]);

    await expect(loadArchivedChoreById(7, ctx)).rejects.toThrow(/not archived/);
  });

  test("an id that exists nowhere keeps the original not-found message", async () => {
    const ctx = archivedCtx([], [row(7, "Something else")]);

    await expect(loadArchivedChoreById(404, ctx)).rejects.toThrow(/archived chore list/);
  });

  test("a failure fetching the archived list keeps its DonetickError class", async () => {
    // Rewriting it to a plain Error drops invalidatesCache and indeterminate, which
    // guardWith and fail() read, turning a transport problem into a confident claim
    // about the chore's state.
    const boom = new DonetickError("instance is down", { status: 500, invalidatesCache: true });
    const ctx = archivedCtx([], [row(7, "In the active list")], boom);

    const error = await loadArchivedChoreById(7, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DonetickError);
    expect((error as DonetickError).invalidatesCache).toBe(true);
  });
});
