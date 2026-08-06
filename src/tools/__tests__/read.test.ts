import { describe, expect, test } from "bun:test";
import { listChores, getChore } from "../read";
import type { Member, Project, RawChore } from "@/types";

const now = new Date("2026-06-15T12:00:00Z");
const tz = "America/New_York";

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];
const projects: Project[] = [{ id: 4, name: "Garden" }];

const chores: RawChore[] = [
  { id: 1, name: "Overdue thing", nextDueDate: "2026-06-10T12:00:00Z", assignedTo: 1, priority: 1, status: 0, frequencyType: "once", createdBy: 1, projectId: 4 },
  { id: 2, name: "Later thing", nextDueDate: "2026-07-01T12:00:00Z", assignedTo: 2, priority: 3, status: 0, frequencyType: "once", createdBy: 1 },
  { id: 3, name: "No date thing", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "no_repeat", createdBy: 1 },
];

const ctx = { chores, members, projects, now, timezone: tz };

describe("listChores", () => {
  test("overdue scope selects only past-due chores", () => {
    const out = listChores({ scope: "overdue" }, ctx);
    expect(out.chores.map((c) => c.id)).toEqual([1]);
  });

  test("unscheduled scope selects only chores with no due date", () => {
    expect(listChores({ scope: "unscheduled" }, ctx).chores.map((c) => c.id)).toEqual([3]);
  });

  test("all scope returns everything", () => {
    expect(listChores({ scope: "all" }, ctx).chores.length).toBe(3);
  });

  test("filters by project name", () => {
    expect(listChores({ scope: "all", project: "Garden" }, ctx).chores.map((c) => c.id)).toEqual([1]);
  });

  test("filters by assignee display name", () => {
    expect(listChores({ scope: "all", assignee: "Sam" }, ctx).chores.map((c) => c.id)).toEqual([2]);
  });

  test("assignee 'unassigned' selects chores with no assignee", () => {
    expect(listChores({ scope: "all", assignee: "unassigned" }, ctx).chores.map((c) => c.id)).toEqual([3]);
  });

  test("filters by priority label", () => {
    expect(listChores({ scope: "all", priority: "P1" }, ctx).chores.map((c) => c.id)).toEqual([1]);
  });

  test("search matches on name, case-insensitively", () => {
    expect(listChores({ scope: "all", search: "later" }, ctx).chores.map((c) => c.id)).toEqual([2]);
  });

  test("filters by status, which is how pending-approval chores surface", () => {
    const pending: RawChore = {
      id: 4, name: "Awaiting signoff", nextDueDate: "2026-06-20T12:00:00Z",
      assignedTo: 1, priority: 0, status: 3, frequencyType: "once", createdBy: 1,
    };
    const out = listChores({ scope: "all", status: "pending_approval" }, { ...ctx, chores: [...chores, pending] });
    expect(out.chores.map((c) => c.id)).toEqual([4]);
  });

  test("sorts by due date with undated chores last", () => {
    const out = listChores({ scope: "all", sort: "due_date" }, ctx);
    expect(out.chores.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  test("sorts by priority with none last, respecting the inverted scale", () => {
    const out = listChores({ scope: "all", sort: "priority" }, ctx);
    expect(out.chores.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  test("reports the total when limit truncates", () => {
    const out = listChores({ scope: "all", limit: 2 }, ctx);
    expect(out.chores.length).toBe(2);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
  });

  test("does not report truncation when everything fits", () => {
    expect(listChores({ scope: "all", limit: 50 }, ctx).truncated).toBe(false);
  });
});

describe("getChore", () => {
  test("projects a full chore", () => {
    const out = getChore(chores[0]!, members, projects, now);
    expect(out.name).toBe("Overdue thing");
    expect(out.is_overdue).toBe(true);
  });
});

describe("listChores additional coverage", () => {
  test("an unknown project name returns nothing rather than everything", () => {
    const out = listChores({ scope: "all", project: "Nonexistent Project" }, ctx);
    expect(out.chores).toEqual([]);
  });

  test("an unknown assignee name returns nothing rather than everything", () => {
    const out = listChores({ scope: "all", assignee: "Nobody Real" }, ctx);
    expect(out.chores).toEqual([]);
  });

  test("a chore's own frequencyMetadata.timezone overrides the global timezone for bucketing", () => {
    // Global tz is America/New_York (EDT, UTC-4 in June). At "now" (2026-06-15T12:00Z),
    // NY's "today" spans 2026-06-15T04:00Z through 2026-06-16T04:00Z, while Tokyo's
    // (UTC+9, no DST) spans 2026-06-14T15:00Z through 2026-06-15T15:00Z. The two
    // ranges overlap but each has territory the other lacks; a due date in
    // 2026-06-14T15:00Z..2026-06-15T04:00Z is "today" in Tokyo but "yesterday" in NY.
    const tokyoToday: RawChore = {
      id: 5,
      name: "Tokyo due today",
      nextDueDate: "2026-06-14T20:00:00Z", // 2026-06-15T05:00 JST: today in Tokyo, June 14 in NY
      assignedTo: null,
      priority: 0,
      status: 0,
      frequencyType: "once",
      createdBy: 1,
      frequencyMetadata: { timezone: "Asia/Tokyo" },
    };

    const withTz = listChores({ scope: "due_today" }, { ...ctx, chores: [tokyoToday] });
    expect(withTz.chores.map((c) => c.id)).toEqual([5]);

    // Without the per-chore timezone (simulated by stripping it), bucketing falls
    // back to the global America/New_York zone, where the same instant lands on
    // the previous NY calendar day and is therefore not "due today".
    const { frequencyMetadata, ...withoutTz } = tokyoToday;
    const noTz = listChores({ scope: "due_today" }, { ...ctx, chores: [withoutTz as RawChore] });
    expect(noTz.chores.map((c) => c.id)).toEqual([]);
  });

  test("filters combine: project and priority narrow together rather than replace", () => {
    const gardenLowPriority: RawChore = {
      id: 6, name: "Garden but low priority", nextDueDate: "2026-06-12T12:00:00Z",
      assignedTo: null, priority: 3, status: 0, frequencyType: "once", createdBy: 1, projectId: 4,
    };
    const out = listChores(
      { scope: "all", project: "Garden", priority: "P1" },
      { ...ctx, chores: [...chores, gardenLowPriority] },
    );
    expect(out.chores.map((c) => c.id)).toEqual([1]);
  });

  test("due_within_days honors the days argument", () => {
    const soon: RawChore = {
      id: 7, name: "Due in 3 days", nextDueDate: "2026-06-18T12:00:00Z",
      assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1,
    };
    const within2 = listChores({ scope: "due_within_days", days: 2 }, { ...ctx, chores: [soon] });
    expect(within2.chores.map((c) => c.id)).toEqual([]);

    const within5 = listChores({ scope: "due_within_days", days: 5 }, { ...ctx, chores: [soon] });
    expect(within5.chores.map((c) => c.id)).toEqual([7]);
  });

  test("sorting is stable and deterministic under truncation when due dates tie", () => {
    const tied: RawChore[] = [
      { id: 10, name: "A", nextDueDate: "2026-06-20T12:00:00Z", assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 11, name: "B", nextDueDate: "2026-06-20T12:00:00Z", assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 12, name: "C", nextDueDate: "2026-06-20T12:00:00Z", assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
    ];
    const tiedCtx = { ...ctx, chores: tied };
    const first = listChores({ scope: "all", sort: "due_date", limit: 2 }, tiedCtx).chores.map((c) => c.id);
    const second = listChores({ scope: "all", sort: "due_date", limit: 2 }, tiedCtx).chores.map((c) => c.id);
    expect(first).toEqual(second);
    expect(first).toEqual([10, 11]);
  });

  test("sort: 'name' orders case-insensitively, unlike a plain ordinal string sort", () => {
    // Ordinal comparison (or Array.prototype.sort with no comparator) would put
    // "Cherry" before "banana" because uppercase code points sort below lowercase
    // ones. localeCompare corrects that to alphabetical, case-insensitive order.
    const named: RawChore[] = [
      { id: 20, name: "Cherry", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 21, name: "banana", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 22, name: "Apple", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
    ];
    const out = listChores({ scope: "all", sort: "name" }, { ...ctx, chores: named });
    expect(out.chores.map((c) => c.id)).toEqual([22, 21, 20]);
  });

  test("sort: 'name' with an emoji-prefixed name: localeCompare ranks the emoji ahead of letters", () => {
    // Documenting actual behavior rather than asserting it is ideal: localeCompare
    // treats the leading emoji as sorting before ASCII letters here, so an
    // emoji-prefixed chore name floats to the top rather than sorting by the first
    // letter of the visible word. Accepted as adequate for a chore-name sort: it is
    // stable and locale-aware, just not "ignore leading emoji" smart.
    const named: RawChore[] = [
      { id: 20, name: "banana", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 21, name: "Apple", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
      { id: 22, name: "\u{1F345} Tomato", nextDueDate: null, assignedTo: null, priority: 0, status: 0, frequencyType: "once", createdBy: 1 },
    ];
    const out = listChores({ scope: "all", sort: "name" }, { ...ctx, chores: named });
    expect(out.chores.map((c) => c.id)).toEqual([22, 21, 20]);
  });

  test("an empty chore list returns total 0 and truncated false", () => {
    const out = listChores({ scope: "all" }, { ...ctx, chores: [] });
    expect(out.chores).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.truncated).toBe(false);
  });

  test("limit: 0 means no rows are returned, and total still reports what matched", () => {
    const out = listChores({ scope: "all", limit: 0 }, ctx);
    expect(out.chores).toEqual([]);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
  });
});
