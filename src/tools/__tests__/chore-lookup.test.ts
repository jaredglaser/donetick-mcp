import { describe, expect, test } from "bun:test";
import { loadChoreById } from "../chore-lookup";
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
function ctxFor(cached: RawChore[], everywhere: RawChore[]) {
  let allChoresCalls = 0;
  const service = {
    chores: async () => cached,
    allChores: async () => {
      allChoresCalls += 1;
      return everywhere;
    },
  };
  const ctx: ToolContext = { service: service as never, now: () => now, timezone: "America/New_York" };
  return { ctx, allChoresCalls: () => allChoresCalls };
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
    const { ctx } = ctxFor([row(7, "Cached")], [row(9, "Elsewhere")]);

    await expect(loadChoreById(404, ctx)).rejects.toThrow(/No chore with id 404/);
  });

  test("an absent id is refused before either list is read", async () => {
    const { ctx, allChoresCalls } = ctxFor([row(7, "Cached")], []);

    await expect(loadChoreById(undefined, ctx)).rejects.toThrow();
    expect(allChoresCalls()).toBe(0);
  });
});
