import { describe, expect, test } from "bun:test";
import {
  approveChore,
  completeChore,
  nudgeChore,
  rejectChore,
  skipChore,
  undoChore,
} from "../actions";
import { setSubtaskCompleted } from "../subtasks";
import type { ToolContext } from "@/tools/context";
import type { Member, RawChore } from "@/types";

const now = new Date("2026-08-06T16:00:00Z");
const tz = "America/New_York";

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];

interface FakeOptions {
  chores?: RawChore[];
  members?: Member[];
  post?: (path: string, body?: unknown) => unknown | Promise<unknown>;
}

function fakeService(opts: FakeOptions = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let invalidations = 0;
  let memberInvalidations = 0;

  const service = {
    chores: async () => {
      calls.push({ method: "GET", path: "chores" });
      return opts.chores ?? [];
    },
    allChores: async () => opts.chores ?? [],
    members: async () => opts.members ?? members,
    write: async <T>(operation: () => Promise<T>, options: { movesPoints?: boolean } = {}): Promise<T> => {
      try {
        return await operation();
      } finally {
        invalidations += 1;
        // Mirrors the real service: the member cache is invalidated inside the same
        // finally, so a write that lands and then fails still moves it.
        if (options.movesPoints === true) memberInvalidations += 1;
      }
    },
    invalidateMembers: () => {
      memberInvalidations += 1;
    },
    client: {
      post: async (path: string, body?: unknown) => {
        calls.push({ method: "POST", path, body });
        if (!opts.post) return {};
        return opts.post(path, body);
      },
    },
  };

  return { service, calls, invalidations: () => invalidations, memberInvalidations: () => memberInvalidations };
}

function ctxFor(service: ReturnType<typeof fakeService>["service"]): ToolContext {
  return { service: service as never, now: () => now, timezone: tz };
}

const listRow: RawChore = {
  id: 7,
  name: "Take out trash",
  description: null,
  nextDueDate: "2026-08-10T13:00:00Z",
  assignedTo: 1,
  assignees: [{ userId: 1 }],
  assignStrategy: "keep_last_assigned",
  priority: 2,
  status: 0,
  frequencyType: "interval",
  frequency: 3,
  frequencyMetadata: { unit: "days" },
  isRolling: false,
  isActive: true,
  isPrivate: false,
  requireApproval: false,
  notification: false,
  notificationMetadata: null,
  completionWindow: null,
  points: 3,
  projectId: null,
  createdBy: 1,
  subTasks: [],
};

describe("completeChore", () => {
  test("the body always carries completedTime and never completedAt or completedDate", async () => {
    const fake = fakeService({ chores: [listRow] });

    await completeChore({ chore_id: 7, completed_at: "yesterday" }, ctxFor(fake.service));

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v1/chores/7/do");
    const body = post.body as Record<string, unknown>;
    expect(body).toHaveProperty("completedTime");
    expect(body).not.toHaveProperty("completedAt");
    expect(body).not.toHaveProperty("completedDate");
  });

  test("an empty completed_at means now, not a due-date parse error", async () => {
    // completed_at is an optional string, so "" passes schema validation. Making an
    // empty due date a parse error was right for the tools that write one, and it
    // reached here too: the whole completion failed with format help that does not
    // mention completions. Absent means Donetick uses its own clock.
    const fake = fakeService({ chores: [listRow] });

    const result = await completeChore({ chore_id: 7, completed_at: "" }, ctxFor(fake.service));

    expect(result.completed).toBe(true);
    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("completedTime");
  });

  test("a whitespace-only completed_at is treated the same way", async () => {
    const fake = fakeService({ chores: [listRow] });

    await completeChore({ chore_id: 7, completed_at: "   " }, ctxFor(fake.service));

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("completedTime");
  });

  test("rejects a future completed_at before making any request", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      completeChore({ chore_id: 7, completed_at: "in 3 days" }, ctxFor(fake.service)),
    ).rejects.toThrow(/future/i);

    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a completed_at of exactly now is accepted, not treated as future", async () => {
    const fake = fakeService({ chores: [{ ...listRow, isRolling: true }] });

    const result = await completeChore(
      { chore_id: 7, completed_at: now.toISOString() },
      ctxFor(fake.service),
    );

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect((post.body as Record<string, unknown>).completedTime).toBe(now.toISOString());
    // Pinned decision: exactly now is not "past", so it is not reported as a backdate
    // even on a rolling chore.
    expect(result.message).not.toMatch(/rolling/i);
  });

  test("sends notes, not the deprecated note field", async () => {
    const fake = fakeService({ chores: [listRow] });

    await completeChore({ chore_id: 7, note: "bins were full" }, ctxFor(fake.service));

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.notes).toBe("bins were full");
    expect(body).not.toHaveProperty("note");
  });

  test("resolves completed_by to the member's id", async () => {
    const fake = fakeService({ chores: [listRow] });

    await completeChore({ chore_id: 7, completed_by: "Sam" }, ctxFor(fake.service));

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.completedBy).toBe(2);
  });

  test("an unknown completed_by errors and lists known members", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      completeChore({ chore_id: 7, completed_by: "Waldo" }, ctxFor(fake.service)),
    ).rejects.toThrow(/Waldo.*Jared Glaser.*Sam/s);
  });

  test("detects pending approval from a response at status 3 that carries no message field at all", async () => {
    // The live response is the full chore object at status 3, with no message key
    // anywhere on it. A check that reads a message here would never fire.
    const fake = fakeService({
      chores: [{ ...listRow, requireApproval: true }],
      post: () => ({ ...listRow, requireApproval: true, status: 3 }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.completed).toBe(false);
    expect(result.pending_approval).toBe(true);
    expect(result.next_due_date).toBe(listRow.nextDueDate);
    expect(result.message).toMatch(/approval/i);
    expect(result.message).toMatch(/approve_chore/);
  });

  test("an ordinary completion reports completed true and the next due date from the response", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => ({ ...listRow, nextDueDate: "2026-08-13T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.completed).toBe(true);
    expect(result.pending_approval).toBe(false);
    expect(result.next_due_date).toBe("2026-08-13T13:00:00Z");
  });

  test("a completion response with no nextDueDate reports unknown, not the pre-completion date", async () => {
    // The value read before the write is the occurrence that was just completed.
    // Reporting it under a field named next_due_date is indistinguishable from a
    // verified answer, and nextDueDateOf exists precisely to tell absent from null.
    const fake = fakeService({ chores: [listRow], post: () => ({}) });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.next_due_date).toBeNull();
    expect(result.message).toMatch(/unknown/);
  });

  test("returns the chore id so undo is reachable without a name lookup", async () => {
    const fake = fakeService({ chores: [listRow] });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.id).toBe(7);
  });

  test("backdating a rolling chore mentions the shifted occurrence", async () => {
    const fake = fakeService({ chores: [{ ...listRow, isRolling: true }] });

    const result = await completeChore({ chore_id: 7, completed_at: "yesterday" }, ctxFor(fake.service));

    expect(result.message).toMatch(/rolling/i);
  });

  test('completed_at "today" before 09:00 records now rather than being refused as future', async () => {
    // parseDueDate resolves a bare day to 09:00, which is right for a due date and
    // wrong for a completion: at 07:30 local, "today" resolved to later this
    // morning and the future check rejected something the user had just done.
    const earlyMorning = new Date("2026-08-06T11:30:00Z"); // 07:30 America/New_York
    const fake = fakeService({ chores: [listRow] });
    const ctx = { service: fake.service as never, now: () => earlyMorning, timezone: tz };

    const result = await completeChore({ chore_id: 7, completed_at: "today" }, ctx);

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.completedTime).toBe(earlyMorning.toISOString());
    expect(result.completed).toBe(true);
  });

  test("the same date in a different year is refused, not clamped to now", async () => {
    // isSameCalendarDay compares year, month and day. Dropping the year made "the
    // 15th of June" next year look like today, so a future completion was clamped to
    // now and recorded as a plain success instead of being refused.
    const fake = fakeService({ chores: [listRow] });

    await expect(
      completeChore({ chore_id: 7, completed_at: "2027-08-06" }, ctxFor(fake.service)),
    ).rejects.toThrow(/future/i);
  });

  test("the same day-of-month in a different month is refused too", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      completeChore({ chore_id: 7, completed_at: "2026-12-06" }, ctxFor(fake.service)),
    ).rejects.toThrow(/future/i);
  });

  test('completed_at "today" means now at every hour, not 09:00', async () => {
    // This test asserted the opposite, on the reasoning that 09:00 was already in the
    // past so there was nothing to clamp. There was: parseDueDate resolves a bare day
    // to 09:00 for a due date, and a completion asked for at 16:00 local was recorded
    // seven hours early. At 22:00 it was thirteen, and the backdate then set
    // isPastCompletion and made the result explain that a rolling chore's next
    // occurrence had moved earlier because of it.
    const afternoon = new Date("2026-08-06T20:00:00Z"); // 16:00 America/New_York
    const fake = fakeService({ chores: [listRow] });
    const ctx = { service: fake.service as never, now: () => afternoon, timezone: tz };

    await completeChore({ chore_id: 7, completed_at: "today" }, ctx);

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.completedTime).toBe(afternoon.toISOString());
  });

  test('"today" late in the evening is not reported as a backdated completion', async () => {
    // The consequence, rather than the value: isPastCompletion drives a note about
    // having moved a rolling chore's next occurrence, which was untrue and unasked for.
    const evening = new Date("2026-08-07T02:00:00Z"); // 22:00 on the 6th, America/New_York
    const fake = fakeService({ chores: [{ ...listRow, isRolling: true }] });
    const ctx = { service: fake.service as never, now: () => evening, timezone: tz };

    const result = await completeChore({ chore_id: 7, completed_at: "today" }, ctx);

    expect(result.message).not.toMatch(/backdat/i);
  });

  test('"yesterday" still records yesterday rather than being clamped to now', async () => {
    // The clamp is for the calendar day the caller is on. Widening it to every bare
    // day would throw away the one thing completed_at is for.
    const afternoon = new Date("2026-08-06T20:00:00Z");
    const fake = fakeService({ chores: [listRow] });
    const ctx = { service: fake.service as never, now: () => afternoon, timezone: tz };

    await completeChore({ chore_id: 7, completed_at: "yesterday" }, ctx);

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.completedTime).toBe("2026-08-05T13:00:00.000Z");
  });

  test("an explicit future time later today is refused, not quietly rewritten to now", async () => {
    // The clamp above exists for a bare day, whose 09:00 the caller never asked for.
    // Keyed on the calendar day alone it also swallowed a stated time: "I did it at
    // 20:00 tonight", asked at noon, recorded noon and answered plain success. The
    // schema promises a future time is rejected, so this is the case that has to
    // stay on the refusing side of the line.
    const noon = new Date("2026-08-06T16:00:00Z"); // 12:00 America/New_York
    const fake = fakeService({ chores: [listRow] });
    const ctx = { service: fake.service as never, now: () => noon, timezone: tz };

    await expect(
      completeChore({ chore_id: 7, completed_at: "2026-08-06T20:00:00-04:00" }, ctx),
    ).rejects.toThrow(/future/i);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("an explicit earlier time today is kept exactly, not clamped to now", async () => {
    const noon = new Date("2026-08-06T16:00:00Z"); // 12:00 America/New_York
    const fake = fakeService({ chores: [listRow] });
    const ctx = { service: fake.service as never, now: () => noon, timezone: tz };

    await completeChore({ chore_id: 7, completed_at: "2026-08-06T08:00:00-04:00" }, ctx);

    const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.completedTime).toBe("2026-08-06T12:00:00.000Z");
  });

  test("a future day is still refused, so the clamp does not swallow a real mistake", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      completeChore({ chore_id: 7, completed_at: "tomorrow" }, ctxFor(fake.service)),
    ).rejects.toThrow(/future/i);
  });

  test("backdating a non-rolling chore does not mention rolling", async () => {
    const fake = fakeService({ chores: [{ ...listRow, isRolling: false }] });

    const result = await completeChore({ chore_id: 7, completed_at: "yesterday" }, ctxFor(fake.service));

    expect(result.message).not.toMatch(/rolling/i);
  });

  test("invalidates the cache on success", async () => {
    const fake = fakeService({ chores: [listRow] });

    await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(fake.invalidations()).toBe(1);
  });

  test("invalidates the cache even when the request fails", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("instance unreachable");
      },
    });

    await expect(completeChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      "instance unreachable",
    );
    expect(fake.invalidations()).toBe(1);
  });
});

describe("skipChore", () => {
  test("posts to the skip endpoint", async () => {
    const fake = fakeService({ chores: [listRow] });

    await skipChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(fake.calls.find((c) => c.method === "POST")?.path).toBe("/api/v1/chores/7/skip");
  });

  test("invalidates the cache on success and on failure", async () => {
    const ok = fakeService({ chores: [listRow] });
    await skipChore({ chore_id: 7 }, ctxFor(ok.service));
    expect(ok.invalidations()).toBe(1);

    const failing = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("nope");
      },
    });
    await expect(skipChore({ chore_id: 7 }, ctxFor(failing.service))).rejects.toThrow("nope");
    expect(failing.invalidations()).toBe(1);
  });
});

describe("point totals after a write that moves them", () => {
  // list_members reads a cache with a five minute TTL and advertises point standings.
  // write() invalidates the chore cache only, deliberately, so the three tools that
  // move points have to say so themselves.
  test("complete invalidates the member cache", async () => {
    const fake = fakeService({ chores: [listRow] });
    await completeChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(fake.memberInvalidations()).toBe(1);
  });

  test("approve invalidates the member cache", async () => {
    const fake = fakeService({ chores: [listRow] });
    await approveChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(fake.memberInvalidations()).toBe(1);
  });

  test("undo invalidates the member cache", async () => {
    const fake = fakeService({ chores: [listRow] });
    await undoChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(fake.memberInvalidations()).toBe(1);
  });

  test("skip does not, since skipping awards nothing", async () => {
    const fake = fakeService({ chores: [listRow] });
    await skipChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(fake.memberInvalidations()).toBe(0);
  });
});

describe("a next occurrence that lands in the past", () => {
  // The note used to state the adaptive cause unconditionally. Donetick steps from
  // the previous due date rather than from the completion, so any chore finished more
  // than one period late lands behind: being a day late on a daily chore is enough,
  // and that is the common case the adaptive explanation was wrong about.
  const past = "2026-08-01T13:00:00Z"; // before the fixed clock

  test("a plain recurring chore is told it stepped from the previous due date", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "daily" }],
      post: () => ({ ...listRow, nextDueDate: past }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).toMatch(/already in the past/);
    expect(result.message).toMatch(/steps from the previous due date/);
    expect(result.message).not.toMatch(/adaptive/i);
  });

  test("an adaptive chore gets the adaptive explanation, which is true only there", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "adaptive" }],
      post: () => ({ ...listRow, nextDueDate: past }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).toMatch(/adaptive recurrence/i);
    expect(result.message).toMatch(/does not recover on its own/);
  });

  test("a rolling adaptive chore gets the adaptive reason, not the rolling one", async () => {
    // Measured: adaptive scheduling ignores isRolling entirely, and a rolling
    // adaptive chore completed early lands in the past exactly as a non-rolling one
    // does. Testing isRolling first gave it the wrong mechanism and dropped the
    // adaptive sentence's actionable half, that it does not recover on its own.
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "adaptive", isRolling: true }],
      post: () => ({ ...listRow, nextDueDate: "2026-08-01T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).toMatch(/adaptive recurrence/i);
    expect(result.message).toMatch(/does not recover on its own/);
    expect(result.message).not.toMatch(/completion date you gave it/);
  });

  test("a rolling chore completed at the present time is not told about a date it did not give", async () => {
    // rollingNote is gated on isPastCompletion; this branch was not, so it said "the
    // completion date you gave it" when no completed_at was passed at all.
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "daily", isRolling: true }],
      post: () => ({ ...listRow, nextDueDate: "2026-08-01T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).toMatch(/in the past/);
    expect(result.message).not.toMatch(/completion date you gave it/);
  });

  test("a rolling chore backdated does get the completion-date wording", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "daily", isRolling: true }],
      post: () => ({ ...listRow, nextDueDate: "2026-08-01T13:00:00Z" }),
    });

    const result = await completeChore(
      { chore_id: 7, completed_at: "yesterday" },
      ctxFor(fake.service),
    );

    expect(result.message).toMatch(/completion date you gave it/);
  });

  test("an ordinary completion says nothing about it", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => ({ ...listRow, nextDueDate: "2026-09-01T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).not.toMatch(/in the past/);
  });
});

describe("acting on a chore that is not in the active lists", () => {
  // Donetick allows every one of these and says nothing. The note names both causes
  // of isActive false, archived and completed-one-off, because the row cannot tell
  // them apart and an earlier version claimed the first about chores in the second
  // state.
  const inactive = { ...listRow, isActive: false } as RawChore;

  test("completing one succeeds and says it is out of the active lists", async () => {
    const fake = fakeService({ chores: [inactive] });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.completed).toBe(true);
    expect(result.message).toMatch(/not in your active lists/);
    expect(result.message).toMatch(/one-off that has already been completed/);
  });

  test("the note does not claim the chore was archived, which may not be true", async () => {
    const fake = fakeService({ chores: [inactive] });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).not.toMatch(/unarchive_chore/);
  });

  test("skipping one says the same", async () => {
    const fake = fakeService({ chores: [{ ...inactive, status: 0 }] });

    const result = await skipChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).toMatch(/not in your active lists/);
  });

  test("an active chore says nothing about it", async () => {
    const fake = fakeService({ chores: [listRow] });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.message).not.toMatch(/active lists/);
  });
});

describe("skipChore against a timer", () => {
  // Confirmed against a live v0.1.76 instance: with a timer running, skip returned
  // 200, the due date did not move, the chore stayed at status 1, and the only
  // history row was the Started one. Donetick's SkipChore switch matches neither
  // case when the Started row has a null performedAt, and its default returns a nil
  // error, which commits a transaction that wrote nothing.
  for (const [status, label] of [
    [1, "running"],
    [2, "paused"],
  ] as const) {
    test(`refuses a chore with a ${label} timer instead of reporting a skip that did not happen`, async () => {
      const fake = fakeService({ chores: [{ ...listRow, status }] });

      await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
        new RegExp(`${label} timer`),
      );
      expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
    });
  }

  test("points at complete_chore, which works from either timer state", async () => {
    const fake = fakeService({ chores: [{ ...listRow, status: 1 }] });
    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(/Complete it/);
  });

  test("a chore with no timer skips normally", async () => {
    const fake = fakeService({ chores: [{ ...listRow, status: 0 }] });
    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).resolves.toBeDefined();
  });

  test("a pending-approval chore is refused for its own reason, not the timer one", async () => {
    // Measured on v0.1.76: skipping at status 3 drops the chore to idle, advances
    // the due date, orphans the pending history row and pays nothing, and
    // approve_chore then reports nothing is pending. Worse than the timer case,
    // which is only a no-op: this destroys work someone else did. This test used to
    // assert the skip went through.
    const fake = fakeService({ chores: [{ ...listRow, status: 3 }] });

    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      /waiting on sign-off/,
    );
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("undoChore", () => {
  test("rejects a name, pointing at the id complete_chore returned", async () => {
    const fake = fakeService({ chores: [listRow] });

    await expect(
      undoChore({ name: "Take out trash" } as never, ctxFor(fake.service)),
    ).rejects.toThrow(/chore_id/);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("errors clearly when chore_id is absent entirely", async () => {
    const fake = fakeService();

    await expect(undoChore({}, ctxFor(fake.service))).rejects.toThrow(/chore_id/);
  });

  test("posts to the undo endpoint using the id alone, without looking up the chore list", async () => {
    const fake = fakeService();

    await undoChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(fake.calls.find((c) => c.method === "POST")?.path).toBe("/api/v1/chores/7/undo");
    // A just-completed non-recurring chore has isActive: false and is absent from the
    // active list, so undo must never depend on finding it there.
    expect(fake.calls.some((c) => c.method === "GET")).toBe(false);
  });

  test("contradicts Donetick's window excuse, which sends the caller after the wrong cause", async () => {
    const fake = fakeService({
      post: () => {
        throw new Error(
          "Donetick rejected the request: No recent action found to undo (actions can only be undone within 5 minutes)",
        );
      },
    });

    // Verified live against a completion one second old: the window is not what
    // failed, so "wait less" is the one remedy guaranteed not to work.
    const error = await undoChore({ chore_id: 7 }, ctxFor(fake.service)).catch((e: Error) => e);
    expect(error.message).toMatch(/retrying will not help/);
    expect(error.message).toMatch(/local offset/);
  });

  test("passes an unrelated failure through untouched", async () => {
    const fake = fakeService({
      post: () => {
        throw new Error("Donetick rejected the request: chore not found");
      },
    });

    await expect(undoChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      /^Donetick rejected the request: chore not found$/,
    );
  });

  test("invalidates the cache on success and on failure", async () => {
    const ok = fakeService();
    await undoChore({ chore_id: 7 }, ctxFor(ok.service));
    expect(ok.invalidations()).toBe(1);

    const failing = fakeService({
      post: () => {
        throw new Error("No recent action found to undo");
      },
    });
    await expect(undoChore({ chore_id: 7 }, ctxFor(failing.service))).rejects.toThrow(
      "No recent action found to undo",
    );
    expect(failing.invalidations()).toBe(1);
  });
});

describe("approveChore", () => {
  test("posts to the approve endpoint", async () => {
    const fake = fakeService({ chores: [listRow] });

    const result = await approveChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(fake.calls.find((c) => c.method === "POST")?.path).toBe("/api/v1/chores/7/approve");
    expect(result).toMatchObject({ id: 7, name: "Take out trash", decision: "approved" });
  });

  test("a chore that is not pending approval surfaces Donetick's 400 intelligibly rather than crashing", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("Donetick rejected the request: chore is not pending approval");
      },
    });

    await expect(approveChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      /not pending approval/,
    );
  });

  test("invalidates the cache on success and on failure", async () => {
    const ok = fakeService({ chores: [listRow] });
    await approveChore({ chore_id: 7 }, ctxFor(ok.service));
    expect(ok.invalidations()).toBe(1);

    const failing = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("nope");
      },
    });
    await expect(approveChore({ chore_id: 7 }, ctxFor(failing.service))).rejects.toThrow("nope");
    expect(failing.invalidations()).toBe(1);
  });
});

describe("rejectChore", () => {
  test("posts to the reject endpoint", async () => {
    const fake = fakeService({ chores: [listRow] });

    const result = await rejectChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(fake.calls.find((c) => c.method === "POST")?.path).toBe("/api/v1/chores/7/reject");
    expect(result).toMatchObject({ id: 7, name: "Take out trash", decision: "rejected" });
  });

  test("invalidates the cache on success and on failure", async () => {
    const ok = fakeService({ chores: [listRow] });
    await rejectChore({ chore_id: 7 }, ctxFor(ok.service));
    expect(ok.invalidations()).toBe(1);

    const failing = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("nope");
      },
    });
    await expect(rejectChore({ chore_id: 7 }, ctxFor(failing.service))).rejects.toThrow("nope");
    expect(failing.invalidations()).toBe(1);
  });
});

describe("nudgeChore", () => {
  test("refuses in a single-member circle without making a request", async () => {
    const fake = fakeService({ chores: [listRow], members: [members[0]!] });

    await expect(nudgeChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(/only.*member/i);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("sends the required body shape, defaulting all_assignees and message", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => ({ message: "Nudge sent to 1 user(s) across 2 device(s)" }),
    });

    const result = await nudgeChore({ chore_id: 7 }, ctxFor(fake.service));

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/v1/chores/7/nudge");
    expect(post.body).toEqual({ all_assignees: false, message: "" });
    expect(result.delivered).toBe(true);
  });

  test("passes through an explicit message and all_assignees", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => ({ message: "Nudge sent to 2 user(s) across 3 device(s)" }),
    });

    await nudgeChore({ chore_id: 7, message: "bins day", all_assignees: true }, ctxFor(fake.service));

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ all_assignees: true, message: "bins day" });
  });

  test("reports delivered false on a zero-device response, rather than bare success", async () => {
    const fake = fakeService({
      chores: [listRow],
      post: () => ({ message: "Nudge sent to 1 user(s) across 0 device(s)" }),
    });

    const result = await nudgeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.delivered).toBe(false);
    expect(result.message).toMatch(/0 device/);
  });

  test("does not invalidate the cache, because a nudge changes no chore field", async () => {
    // Every other action here writes to the chore and must drop the cached list.
    // A nudge sends a push notification, so invalidating would discard a warm
    // cache only to refetch an identical answer.
    const ok = fakeService({
      chores: [listRow],
      post: () => ({ message: "Nudge sent to 1 user(s) across 1 device(s)" }),
    });
    await nudgeChore({ chore_id: 7 }, ctxFor(ok.service));
    expect(ok.invalidations()).toBe(0);

    const failing = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("nope");
      },
    });
    await expect(nudgeChore({ chore_id: 7 }, ctxFor(failing.service))).rejects.toThrow("nope");
    expect(failing.invalidations()).toBe(0);
  });
});

describe("gaps the second review round named", () => {
  test("an empty note is dropped rather than sent into a min=1 binding", () => {
    // Donetick binds notes as omitempty,min=1, so "" is a 400 for a value that means
    // the same as passing nothing.
    const fake = fakeService({ chores: [listRow] });
    return completeChore({ chore_id: 7, note: "" }, ctxFor(fake.service)).then(() => {
      const body = fake.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("notes");
    });
  });

  test("a response with no status falls back to the chore's approval flag", async () => {
    // The primary signal is the response's status. This is the branch that runs when
    // it carries none, and it had no case with requireApproval set.
    const fake = fakeService({
      chores: [{ ...listRow, requireApproval: true }],
      post: () => ({}),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.pending_approval).toBe(true);
  });
});

describe("an approval-enabled chore whose completion actually landed", () => {
  test("is reported completed, not pending", async () => {
    // The distinguishing case: requireApproval true AND a response saying the
    // completion went through. Both existing tests have requireApproval true with a
    // response that is pending or silent, so `status === 3 || chore.requireApproval`
    // and the ternary produce identical output and the fix is fully reversible.
    const fake = fakeService({
      chores: [{ ...listRow, requireApproval: true }],
      post: () => ({ ...listRow, requireApproval: true, status: 0, nextDueDate: "2026-08-13T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.completed).toBe(true);
    expect(result.pending_approval).toBe(false);
    expect(result.next_due_date).toBe("2026-08-13T13:00:00Z");
  });
});

describe("approve and reject report distinguishable outcomes", () => {
  test("a rejection does not look like a failed approval", async () => {
    // Both handlers shared one shape, so reject returned {approved: false}, which is
    // character for character what a failed approval would look like.
    const fake = fakeService({ chores: [listRow] });

    const result = await rejectChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.decision).toBe("rejected");
    expect(result.message).toMatch(/not marked done/);
  });

  test("an approval says so", async () => {
    const fake = fakeService({ chores: [listRow] });

    const result = await approveChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.decision).toBe("approved");
  });
});


describe("claims made off a row that may be stale", () => {
  // Every fix in this block survived its own mutation when it landed, which is rule
  // 2's case exactly: the behaviour was changed and nothing could tell.
  //
  // The fake serves a different chore from choreDetails than from chores(), which is
  // the whole point. Every other fake in the suite returns the same object from both,
  // so a tool reading the cached copy and a tool reading fresh are indistinguishable.
  function staleFake(cached: Partial<RawChore>, live: Record<string, unknown>) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const service = {
      chores: async () => [{ ...listRow, ...cached }],
      allChores: async () => [{ ...listRow, ...cached }],
      members: async () => members,
      choreDetails: async () => ({ id: 7, name: listRow.name, ...live }),
      write: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
      invalidateMembers: () => {},
      client: {
        post: async (path: string, body?: unknown) => {
          calls.push({ method: "POST", path, body });
          return {};
        },
        put: async (path: string, body?: unknown) => {
          calls.push({ method: "PUT", path, body });
          return {};
        },
      },
    };
    return { service, calls };
  }

  test("skip_chore refuses a completion that went to sign-off after the cache was read", async () => {
    // The guard exists to stop a submission being destroyed. Off a cached status it
    // destroyed one: measured live, cache warm at 0, chore completed out of band to
    // 3, and the skip went through.
    const fake = staleFake({ status: 0 }, { status: 3 });

    await expect(
      skipChore({ chore_id: 7 }, ctxFor(fake.service as never)),
    ).rejects.toThrow(/waiting on sign-off/);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("skip_chore allows one whose sign-off was settled after the cache was read", async () => {
    // The mirror: a confident refusal about a chore with nothing pending is a wrong
    // refusal, which costs more than the bug it prevents.
    const fake = staleFake({ status: 3 }, { status: 0 });

    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service as never))).resolves.toBeDefined();
  });

  test("skip_chore refuses a timer started after the cache was read", async () => {
    const fake = staleFake({ status: 0 }, { status: 1 });

    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service as never))).rejects.toThrow(
      /running timer/,
    );
  });

  test("an adaptive skip is not reported as a failure for holding its due date", async () => {
    // SkipChore sets completedDate to the chore's own nextDueDate and the adaptive arm
    // schedules completedDate.Add(completedDate.Sub(nextDueDate)), a zero delta, so the
    // date it returns is always the one it was given. The no-op detection read that as
    // "nothing was skipped, you probably have a running timer" and threw, after the
    // history row had already been written.
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "adaptive" }],
      post: () => ({ ...listRow, frequencyType: "adaptive", nextDueDate: listRow.nextDueDate }),
    });

    const result = await skipChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.next_due_date).toBe(listRow.nextDueDate);
    expect(result.message).toMatch(/Skipped/);
    expect(result.message).toMatch(/adaptive/i);
  });

  test("a non-adaptive chore holding its due date is still reported as a no-op", async () => {
    // The other side of the same boundary: excluding adaptive must not disable the
    // detection for everything else.
    const fake = fakeService({
      chores: [{ ...listRow, frequencyType: "interval" }],
      post: () => ({ ...listRow, nextDueDate: listRow.nextDueDate }),
    });

    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      /nothing was skipped/,
    );
  });

  test("skip_chore refuses to call a no-op a skip, whatever state caused it", async () => {
    // The guards cover the states known to make Donetick answer 200 without acting.
    // This covers the ones that are not known yet: the response's due date is the one
    // the chore already had.
    const fake = fakeService({
      chores: [{ ...listRow, status: 0 }],
      post: () => ({ ...listRow, nextDueDate: listRow.nextDueDate }),
    });

    await expect(skipChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(
      /nothing was skipped/,
    );
  });

  test("skip_chore accepts a due date that actually moved", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, status: 0 }],
      post: () => ({ ...listRow, nextDueDate: "2026-08-13T13:00:00Z" }),
    });

    const result = await skipChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(result.next_due_date).toBe("2026-08-13T13:00:00Z");
  });

  test("complete_chore's pending branch reports the response's due date, not the cached one", async () => {
    // Measured live: with the due date moved out of band, this reported the stale
    // value under a field named next_due_date and then asserted it was unchanged.
    const fake = fakeService({
      chores: [{ ...listRow, requireApproval: true }],
      post: () => ({ ...listRow, status: 3, nextDueDate: "2026-09-07T13:00:00Z" }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));

    expect(result.pending_approval).toBe(true);
    expect(result.next_due_date).toBe("2026-09-07T13:00:00Z");
    expect(result.message).not.toMatch(/due date is unchanged/);
  });

  test("it says the due date is unchanged only when the response agrees", async () => {
    const fake = fakeService({
      chores: [{ ...listRow, requireApproval: true }],
      post: () => ({ ...listRow, status: 3, nextDueDate: listRow.nextDueDate }),
    });

    const result = await completeChore({ chore_id: 7 }, ctxFor(fake.service));
    expect(result.message).toMatch(/due date is unchanged/);
  });

  test("a completion that lands and then fails still invalidates the member cache", async () => {
    // The chore invalidation is in write()'s finally for exactly this reason. The
    // member invalidation sat after the await, so a timeout on a completion that had
    // already moved points left the pre-completion total for the full five minutes.
    const fake = fakeService({
      chores: [listRow],
      post: () => {
        throw new Error("The request timed out after 15000ms.");
      },
    });

    await expect(completeChore({ chore_id: 7 }, ctxFor(fake.service))).rejects.toThrow(/timed out/);
    expect(fake.memberInvalidations()).toBe(1);
  });

  test("set_subtask_completed resolves against the live checklist, not the cached one", async () => {
    // Measured live: renaming a subtask while keeping its id made this tick a task
    // called something else and report back the name it was given.
    const fake = staleFake(
      { subTasks: [{ id: 52, name: "mop floor", completedAt: null }] as never },
      { subTasks: [{ id: 54, name: "take out bins", completedAt: null }] },
    );

    await expect(
      setSubtaskCompleted({ chore_id: 7, subtask: "mop floor", completed: true }, ctxFor(fake.service as never)),
    ).rejects.toThrow(/Nothing matches/);
  });

  test("set_subtask_completed writes the id the live checklist gives", async () => {
    const fake = staleFake(
      { subTasks: [{ id: 52, name: "wipe counters", completedAt: null }] as never },
      { subTasks: [{ id: 99, name: "wipe counters", completedAt: null }] },
    );

    await setSubtaskCompleted(
      { chore_id: 7, subtask: "wipe counters", completed: true },
      ctxFor(fake.service as never),
    );

    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect((put.body as { id: number }).id).toBe(99);
  });
});
