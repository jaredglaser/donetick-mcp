import { describe, expect, test } from "bun:test";
import { setSubtaskCompleted } from "../subtasks";
import { DonetickError } from "@/errors";
import type { ToolContext } from "@/tools/context";
import type { RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");
const tz = "America/New_York";

interface FakeOptions {
  chores?: RawChore[];
  put?: (path: string, body?: unknown) => unknown | Promise<unknown>;
}

function fakeService(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];
  let invalidations = 0;

  const service = {
    chores: async () => {
      calls.push("GET chores");
      return opts.chores ?? [];
    },
    allChores: async () => opts.chores ?? [],
    // loadChoreById probes /details before it reports an id as missing, so a fake
    // without one turns "no such chore" into a TypeError.
    choreDetails: async () => {
      throw new DonetickError("chore not found", { status: 404 });
    },
    write: async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } finally {
        invalidations += 1;
      }
    },
    client: {
      put: async (path: string, body?: unknown) => {
        calls.push(`PUT ${path}`);
        bodies.push({ path, body });
        if (!opts.put) return undefined;
        return opts.put(path, body);
      },
    },
  };

  return { service, calls, bodies, invalidations: () => invalidations };
}

function ctxFor(service: ReturnType<typeof fakeService>["service"]): ToolContext {
  return { service: service as never, now: () => now, timezone: tz };
}

const baseChore: RawChore = {
  id: 5,
  name: "Clean kitchen",
  description: null,
  nextDueDate: "2026-08-10T12:00:00Z",
  assignedTo: 1,
  priority: 2,
  status: 0,
  frequencyType: "daily",
  frequency: 1,
  createdBy: 1,
  subTasks: [
    { id: 101, choreId: 5, name: "wipe counters", completedAt: null, orderId: 0 },
    { id: 102, choreId: 5, name: "sweep floor", completedAt: "2026-08-05T10:00:00Z", orderId: 1 },
  ],
};

describe("setSubtaskCompleted", () => {
  test("resolves by name and sends a timestamp when checking", async () => {
    const fake = fakeService({ chores: [baseChore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "wipe counters", completed: true },
      ctxFor(fake.service),
    );

    expect(fake.calls).toContain("PUT /api/v1/chores/5/subtask");
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent).toEqual({ id: 101, choreId: 5, completedAt: now.toISOString() });
    expect(outcome).toEqual({
      chore_id: 5,
      chore_name: "Clean kitchen",
      subtask: "wipe counters",
      completed: true,
    });
  });

  test("unchecking sends completedAt: null", async () => {
    const fake = fakeService({ chores: [baseChore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "sweep floor", completed: false },
      ctxFor(fake.service),
    );

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent).toEqual({ id: 102, choreId: 5, completedAt: null });
    expect(outcome.completed).toBe(false);
  });

  test("matches by substring", async () => {
    const fake = fakeService({ chores: [baseChore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "counters", completed: true },
      ctxFor(fake.service),
    );

    expect(outcome.subtask).toBe("wipe counters");
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.id).toBe(101);
  });

  test("an ambiguous subtask name lists the candidates", async () => {
    const chore: RawChore = {
      ...baseChore,
      subTasks: [
        { id: 201, choreId: 5, name: "clean sink", completedAt: null, orderId: 0 },
        { id: 202, choreId: 5, name: "clean stove", completedAt: null, orderId: 1 },
      ],
    };
    const fake = fakeService({ chores: [chore] });

    await expect(
      setSubtaskCompleted({ chore_id: 5, subtask: "clean", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/clean sink.*clean stove/s);
    expect(fake.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("a chore with no subtasks says so and makes no request", async () => {
    const chore: RawChore = { ...baseChore, subTasks: [] };
    const fake = fakeService({ chores: [chore] });

    await expect(
      setSubtaskCompleted({ chore_id: 5, subtask: "anything", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/Clean kitchen.*no subtasks/is);
    expect(fake.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("a chore id that is not in the list errors clearly", async () => {
    const fake = fakeService({ chores: [baseChore] });

    await expect(
      setSubtaskCompleted({ chore_id: 999, subtask: "wipe counters", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/999/);
  });

  test("missing chore_id errors", async () => {
    const fake = fakeService({ chores: [baseChore] });

    await expect(
      setSubtaskCompleted({ subtask: "wipe counters", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/chore_id/i);
  });

  test("the cache is invalidated, including when the PUT throws", async () => {
    const failing = fakeService({
      chores: [baseChore],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(
      setSubtaskCompleted({ chore_id: 5, subtask: "wipe counters", completed: true }, ctxFor(failing.service)),
    ).rejects.toThrow("instance unreachable");
    expect(failing.invalidations()).toBe(1);

    const succeeding = fakeService({ chores: [baseChore] });
    await setSubtaskCompleted({ chore_id: 5, subtask: "wipe counters", completed: true }, ctxFor(succeeding.service));
    expect(succeeding.invalidations()).toBe(1);
  });

  test("a subtask whose completedAt is an empty string or absent is treated as not-done in the ambiguity hint", async () => {
    // Neither name equals the query "water" outright, so both survive to the
    // substring tier and the match is genuinely ambiguous, unlike the "water
    // plants" / "water plants upstairs" case in resolve.ts's own doc comment
    // where the shorter name wins outright at the exact-match tier.
    const chore: RawChore = {
      ...baseChore,
      subTasks: [
        { id: 301, choreId: 5, name: "water ferns", completedAt: "" as unknown as null, orderId: 0 },
        { id: 302, choreId: 5, name: "water succulents", completedAt: undefined as unknown as null, orderId: 1 },
      ],
    };
    const fake = fakeService({ chores: [chore] });

    await expect(
      setSubtaskCompleted({ chore_id: 5, subtask: "water", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/water ferns.*not done.*water succulents.*not done/s);
  });

  test("checking an already-checked subtask still issues the PUT", async () => {
    const fake = fakeService({ chores: [baseChore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "sweep floor", completed: true },
      ctxFor(fake.service),
    );

    expect(fake.calls.filter((c) => c.startsWith("PUT")).length).toBe(1);
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.completedAt).toBe(now.toISOString());
    expect(outcome.completed).toBe(true);
  });

  test("unchecking an already-unchecked subtask still issues the PUT", async () => {
    const fake = fakeService({ chores: [baseChore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "wipe counters", completed: false },
      ctxFor(fake.service),
    );

    expect(fake.calls.filter((c) => c.startsWith("PUT")).length).toBe(1);
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.completedAt).toBeNull();
    expect(outcome.completed).toBe(false);
  });

  test("two subtasks whose names differ only by case are ambiguous under case-insensitive matching unless the query matches one exactly", async () => {
    const chore: RawChore = {
      ...baseChore,
      subTasks: [
        { id: 401, choreId: 5, name: "Mop Floor", completedAt: null, orderId: 0 },
        { id: 402, choreId: 5, name: "mop floor", completedAt: null, orderId: 1 },
      ],
    };
    const fake = fakeService({ chores: [chore] });

    const outcome = await setSubtaskCompleted(
      { chore_id: 5, subtask: "Mop Floor", completed: true },
      ctxFor(fake.service),
    );
    expect(outcome.subtask).toBe("Mop Floor");
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.id).toBe(401);

    await expect(
      setSubtaskCompleted({ chore_id: 5, subtask: "mop", completed: true }, ctxFor(fake.service)),
    ).rejects.toThrow(/Mop Floor.*mop floor/s);
  });

  test("the timestamp sent is ctx.now(), not a wall-clock read", async () => {
    const frozen = new Date("2030-01-01T00:00:00Z");
    const fake = fakeService({ chores: [baseChore] });

    await setSubtaskCompleted(
      { chore_id: 5, subtask: "wipe counters", completed: true },
      { service: fake.service as never, now: () => frozen, timezone: tz },
    );

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.completedAt).toBe(frozen.toISOString());
  });
});
