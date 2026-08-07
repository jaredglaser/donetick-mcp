import { describe, expect, test } from "bun:test";
import { archiveChore, reassignChore, rescheduleChore, setPriority, unarchiveChore } from "../schedule";
import type { WriteContext } from "@/tools/write";
import type { Member, Project, RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");
const tz = "America/New_York";

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];
const projects: Project[] = [{ id: 4, name: "Household" }];

interface FakeOptions {
  chores?: RawChore[];
  archivedChores?: RawChore[];
  members?: Member[];
  projects?: Project[];
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
    archivedChores: async () => {
      calls.push("GET archivedChores");
      return opts.archivedChores ?? [];
    },
    members: async () => opts.members ?? members,
    projects: async () => opts.projects ?? projects,
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

function ctxFor(service: ReturnType<typeof fakeService>["service"]): WriteContext {
  return { service: service as never, now: () => now, timezone: tz };
}

// A stored updatedAt distinct from `now`, so a test asserting the sent value equals
// `now` and not this fails loudly if the implementation ever reads it from the chore.
const STALE_UPDATED_AT = "2020-01-01T00:00:00Z";

const listRow: RawChore = {
  id: 5,
  name: "Take out trash",
  description: null,
  nextDueDate: "2026-08-10T12:00:00Z",
  assignedTo: 1,
  assignees: [{ userId: 1 }],
  assignStrategy: "keep_last_assigned",
  labelsV2: [{ id: 10, name: "Kitchen" }],
  priority: 2,
  status: 0,
  frequencyType: "daily",
  frequency: 1,
  frequencyMetadata: { timezone: tz },
  isRolling: false,
  isActive: true,
  isPrivate: false,
  requireApproval: true,
  notification: false,
  notificationMetadata: null,
  completionWindow: null,
  points: 3,
  projectId: 4,
  createdBy: 1,
  updatedAt: STALE_UPDATED_AT,
  subTasks: [],
};

const archivedRow: RawChore = {
  ...listRow,
  id: 6,
  name: "Deep clean fridge",
  isActive: false,
};

describe("rescheduleChore", () => {
  test("sends the row's stored updatedAt, not the current time", async () => {
    // Measured on v0.1.76: every endpoint that takes a token accepts the stored
    // value, and PUT /:id/assignee writes whatever it receives into the row, so a
    // client whose clock runs ahead would stamp the chore with a future version and
    // lock it out of editing. The stored value is never in the future.
    const fake = fakeService({ chores: [listRow] });

    await rescheduleChore({ chore_id: 5, due_date: "2026-08-15" }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.updatedAt).toBe(STALE_UPDATED_AT);
  });

  test("targets /api/v1/chores/<id>/dueDate", async () => {
    const fake = fakeService({ chores: [listRow] });

    await rescheduleChore({ chore_id: 5, due_date: "2026-08-15" }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/5/dueDate");
  });

  test("reports the date it sent, not the response body", async () => {
    const fake = fakeService({
      chores: [listRow],
      put: () => ({ ...listRow, nextDueDate: "1999-01-01T00:00:00Z" }),
    });

    const outcome = await rescheduleChore({ chore_id: 5, due_date: "2026-08-15" }, ctxFor(fake.service));

    expect(outcome.due_date).not.toMatch(/1999/);
    expect(outcome.due_date).toContain("2026-08-15");
  });

  test("due_date: null clears the schedule", async () => {
    const fake = fakeService({ chores: [listRow] });

    const outcome = await rescheduleChore({ chore_id: 5, due_date: null }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.dueDate).toBeNull();
    expect(outcome.due_date).toBeNull();
  });

  test("resolves a relative phrase like 'next friday' through parseDueDate", async () => {
    const fake = fakeService({ chores: [listRow] });

    // 2026-08-06 is a Thursday in America/New_York, so "next friday" is 08-07, 09:00 local.
    const outcome = await rescheduleChore({ chore_id: 5, due_date: "next friday" }, ctxFor(fake.service));

    expect(outcome.due_date).toBe("2026-08-07T13:00:00.000Z");
  });

  test("invalidates the cache, including on failure", async () => {
    const failing = fakeService({
      chores: [listRow],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(
      rescheduleChore({ chore_id: 5, due_date: "2026-08-15" }, ctxFor(failing.service)),
    ).rejects.toThrow("instance unreachable");
    expect(failing.invalidations()).toBe(1);

    const succeeding = fakeService({ chores: [listRow] });
    await rescheduleChore({ chore_id: 5, due_date: "2026-08-15" }, ctxFor(succeeding.service));
    expect(succeeding.invalidations()).toBe(1);
  });

  test("errors clearly on a chore id absent from the cached list", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      rescheduleChore({ chore_id: 999, due_date: "2026-08-15" }, ctxFor(fake.service)),
    ).rejects.toThrow(/999/);
  });
});

describe("reassignChore", () => {
  test("uses the fast endpoint when the person is already an assignee, sending userId and updatedAt", async () => {
    const fake = fakeService({ chores: [listRow] });

    await reassignChore({ chore_id: 5, assignee: "Jared Glaser" }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/5/assignee");
    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.assignee).toBe(1);
    // This endpoint stores the token it is given, so it must never be a clock
    // reading: a client running ahead would stamp the row with a future version.
    expect(sent.updatedAt).toBe(STALE_UPDATED_AT);
  });

  test("falls through to a full edit when the person is not on the chore", async () => {
    const fake = fakeService({ chores: [listRow] });

    await reassignChore({ chore_id: 5, assignee: "Sam" }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/");
    expect(fake.calls).not.toContain("PUT /api/v1/chores/5/assignee");
  });

  test("the full-edit body's assignees union old and new, and assignedTo is the new person", async () => {
    const fake = fakeService({ chores: [listRow] });

    await reassignChore({ chore_id: 5, assignee: "Sam" }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as { assignees: Array<{ userId: number }>; assignedTo: number };
    expect(sent.assignees.map((a) => a.userId).sort()).toEqual([1, 2]);
    expect(sent.assignedTo).toBe(2);
  });

  test("a full edit preserves frequencyType, points, and requireApproval", async () => {
    const fake = fakeService({ chores: [listRow] });

    await reassignChore({ chore_id: 5, assignee: "Sam" }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.frequencyType).toBe("daily");
    expect(sent.points).toBe(3);
    expect(sent.requireApproval).toBe(true);
  });

  test("an unknown assignee errors listing known members", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      reassignChore({ chore_id: 5, assignee: "Nobody" }, ctxFor(fake.service)),
    ).rejects.toThrow(/Jared Glaser/);
    expect(fake.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("invalidates the cache, including on failure", async () => {
    const failing = fakeService({
      chores: [listRow],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(
      reassignChore({ chore_id: 5, assignee: "Jared Glaser" }, ctxFor(failing.service)),
    ).rejects.toThrow("instance unreachable");
    expect(failing.invalidations()).toBe(1);
  });
});

describe("setPriority", () => {
  test("maps P1 to 1", async () => {
    const fake = fakeService({ chores: [listRow] });

    await setPriority({ chore_id: 5, priority: "P1" }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.priority).toBe(1);
    expect(fake.calls).toContain("PUT /api/v1/chores/5/priority");
  });

  test("maps none to 0", async () => {
    const fake = fakeService({ chores: [listRow] });

    await setPriority({ chore_id: 5, priority: "none" }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.priority).toBe(0);
  });

  test("rejects an invalid label, stating P1 is the most urgent", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(setPriority({ chore_id: 5, priority: "urgent" }, ctxFor(fake.service))).rejects.toThrow(
      /P1.*most urgent/i,
    );
    expect(fake.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("accepts a raw integer 0 to 4", async () => {
    const fake = fakeService({ chores: [listRow] });

    await setPriority({ chore_id: 5, priority: 3 }, ctxFor(fake.service));

    const sent = fake.bodies[0]!.body as Record<string, unknown>;
    expect(sent.priority).toBe(3);
  });

  test("rejects an out-of-range raw integer", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(setPriority({ chore_id: 5, priority: 7 }, ctxFor(fake.service))).rejects.toThrow(/0.*4/);
  });

  test("invalidates the cache, including on failure", async () => {
    const failing = fakeService({
      chores: [listRow],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(
      setPriority({ chore_id: 5, priority: "P2" }, ctxFor(failing.service)),
    ).rejects.toThrow("instance unreachable");
    expect(failing.invalidations()).toBe(1);
  });
});

describe("archiveChore", () => {
  test("PUTs the archive endpoint", async () => {
    const fake = fakeService({ chores: [listRow] });

    const outcome = await archiveChore({ chore_id: 5 }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/5/archive");
    expect(fake.bodies[0]!.body).toEqual({});
    expect(outcome.name).toBe("Take out trash");
  });

  test("invalidates the cache, including on failure", async () => {
    const failing = fakeService({
      chores: [listRow],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(archiveChore({ chore_id: 5 }, ctxFor(failing.service))).rejects.toThrow(
      "instance unreachable",
    );
    expect(failing.invalidations()).toBe(1);
  });
});

describe("unarchiveChore", () => {
  test("PUTs the unarchive endpoint, resolving the id against the archived list, not the active cache", async () => {
    const fake = fakeService({ chores: [], archivedChores: [archivedRow] });

    const outcome = await unarchiveChore({ chore_id: 6 }, ctxFor(fake.service));

    expect(fake.calls).toContain("PUT /api/v1/chores/6/unarchive");
    expect(fake.calls).not.toContain("GET chores");
    expect(fake.bodies[0]!.body).toEqual({});
    expect(outcome.name).toBe("Deep clean fridge");
  });

  test("invalidates the cache, including on failure", async () => {
    const failing = fakeService({
      archivedChores: [archivedRow],
      put: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(unarchiveChore({ chore_id: 6 }, ctxFor(failing.service))).rejects.toThrow(
      "instance unreachable",
    );
    expect(failing.invalidations()).toBe(1);
  });

  test("errors clearly on a chore id absent from the archived list", async () => {
    const fake = fakeService({ archivedChores: [] });

    await expect(unarchiveChore({ chore_id: 999 }, ctxFor(fake.service))).rejects.toThrow(/999/);
  });
});
