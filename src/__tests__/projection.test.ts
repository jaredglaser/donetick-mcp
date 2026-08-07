import { describe, expect, test } from "bun:test";
import { projectChore, summarizeFrequency } from "@/projection";
import type { Member, Project, RawChore } from "@/types";

const now = new Date("2026-06-15T12:00:00Z");

const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 12, pointsRedeemed: 0 },
];
const projects: Project[] = [{ id: 4, name: "Garden" }];

function chore(overrides: Partial<RawChore> = {}): RawChore {
  return {
    id: 7,
    name: "Take out trash",
    nextDueDate: "2026-06-18T12:00:00Z",
    assignedTo: 1,
    priority: 1,
    status: 0,
    frequencyType: "interval",
    frequency: 3,
    frequencyMetadata: { unit: "days" },
    createdBy: 1,
    ...overrides,
  };
}

describe("projectChore", () => {
  test("resolves the assignee to a display name", () => {
    expect(projectChore(chore(), members, projects, now).assigned_to).toBe("Jared Glaser");
  });

  test("names an unnameable assignee as unknown, not as unassigned", () => {
    // null here reads as "nobody is assigned", which is a different claim from
    // "assigned to someone this server could not name". The member cache outlives
    // the chore cache by minutes, so a newly added member hits this routinely.
    expect(projectChore(chore({ assignedTo: 99 }), members, projects, now).assigned_to).toBe(
      "member #99 (unknown)",
    );
  });

  test("an actually unassigned chore is still null", () => {
    expect(projectChore(chore({ assignedTo: null }), members, projects, now).assigned_to).toBeNull();
  });

  test("names an unnameable last-completer as unknown, matching assigned_to", () => {
    expect(
      projectChore(chore({ lastCompletedBy: 99 }), members, projects, now).last_completed_by,
    ).toBe("member #99 (unknown)");
  });

  test("carries description, points and is_rolling, which write tools accept but nothing could read back", () => {
    const projected = projectChore(
      chore({ description: "curb by 7am", points: 5, isRolling: true }),
      members,
      projects,
      now,
    );
    expect(projected.description).toBe("curb by 7am");
    expect(projected.points).toBe(5);
    expect(projected.is_rolling).toBe(true);
  });

  test("labels priority without re-bucketing the inverted scale", () => {
    expect(projectChore(chore({ priority: 1 }), members, projects, now).priority).toBe("P1");
    expect(projectChore(chore({ priority: 4 }), members, projects, now).priority).toBe("P4");
    expect(projectChore(chore({ priority: 0 }), members, projects, now).priority).toBe("none");
  });

  test("maps all four status values", () => {
    expect(projectChore(chore({ status: 0 }), members, projects, now).status).toBe("idle");
    expect(projectChore(chore({ status: 1 }), members, projects, now).status).toBe("in_progress");
    expect(projectChore(chore({ status: 2 }), members, projects, now).status).toBe("paused");
    expect(projectChore(chore({ status: 3 }), members, projects, now).status).toBe("pending_approval");
  });

  test("resolves the project name", () => {
    expect(projectChore(chore({ projectId: 4 }), members, projects, now).project).toBe("Garden");
    expect(projectChore(chore({ projectId: null }), members, projects, now).project).toBeNull();
  });

  test("humanizes the due date and flags overdue", () => {
    const future = projectChore(chore(), members, projects, now);
    expect(future.due_in).toBe("in 3 days");
    expect(future.is_overdue).toBe(false);

    const past = projectChore(chore({ nextDueDate: "2026-06-13T12:00:00Z" }), members, projects, now);
    expect(past.due_in).toBe("2 days overdue");
    expect(past.is_overdue).toBe(true);
  });

  test("handles a null due date", () => {
    const out = projectChore(chore({ nextDueDate: null }), members, projects, now);
    expect(out.due_date).toBeNull();
    expect(out.due_in).toBe("no due date");
    expect(out.is_overdue).toBe(false);
  });

  test("returns empty labels rather than null", () => {
    expect(projectChore(chore({ labelsV2: null }), members, projects, now).labels).toEqual([]);
  });

  test("projects subtasks with their completion state", () => {
    const out = projectChore(
      chore({
        subTasks: [
          { id: 1, choreId: 7, name: "Bins to curb", completedAt: "2026-06-14T10:00:00Z" },
          { id: 2, choreId: 7, name: "Replace bag", completedAt: null },
        ],
      }),
      members,
      projects,
      now,
    );
    expect(out.subtasks).toEqual([
      { name: "Bins to curb", done: true },
      { name: "Replace bag", done: false },
    ]);
  });

  test("reports no attachment count, because neither wire view carries attachments", () => {
    // Verified live on v0.1.76: neither the chores list row nor GET /:id/details
    // has an attachments key, so the old count read undefined and reported 0 for
    // every chore, including ones that do have attachments. A field that can only
    // ever say zero is worse than no field, since a caller reads it as an answer.
    const projected = projectChore(chore({}), members, projects, now) as unknown as Record<string, unknown>;
    expect(projected).not.toHaveProperty("attachment_count");
  });

  test("projects the approval flag so complete_chore can explain itself", () => {
    expect(projectChore(chore({ requireApproval: true }), members, projects, now).requires_approval).toBe(true);
  });
});

describe("summarizeFrequency", () => {
  test("describes an interval in its own unit, not as daily", () => {
    expect(summarizeFrequency(chore({ frequencyType: "interval", frequency: 3, frequencyMetadata: { unit: "days" } }))).toBe(
      "every 3 days",
    );
  });

  test("describes the fixed types without a count", () => {
    expect(summarizeFrequency(chore({ frequencyType: "daily" }))).toBe("daily");
    expect(summarizeFrequency(chore({ frequencyType: "weekly" }))).toBe("weekly");
  });

  test("describes a once chore", () => {
    expect(summarizeFrequency(chore({ frequencyType: "once" }))).toBe("once");
  });

  test("describes days of the week", () => {
    expect(
      summarizeFrequency(
        chore({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday", "thursday"] } }),
      ),
    ).toBe("every monday, thursday");
  });

  test("describes an adaptive chore", () => {
    expect(summarizeFrequency(chore({ frequencyType: "adaptive" }))).toBe("adaptive, learned from history");
  });
});

describe("notification settings, which used to be write-only", () => {
  const at = new Date("2026-06-15T12:00:00Z");
  const notif = (overrides: Record<string, unknown>) =>
    projectChore(chore(overrides), [], [], at).notifications;

  test("renders the direction, because the sign is the whole meaning", () => {
    // Donetick adds the offset to the due date: negative is a reminder before,
    // positive is an overdue nag after. Rendering the absolute value erased exactly
    // the distinction this server negates offsets to get right, so a nag set in the
    // web UI read back as a reminder half an hour early.
    expect(
      notif({
        notification: true,
        notificationMetadata: { templates: [{ value: -30, unit: "m" }, { value: 2, unit: "h" }, { value: 0, unit: "m" }] },
      }).reminders,
    ).toEqual(["30m before", "2h after", "at the due date"]);
  });

  test("reports the four flags, so a configured chore is not confused with an empty one", () => {
    // Both of these used to project identically, and one of them is the shape any
    // edit silently switches off, which is what this exists to expose.
    const configured = notif({
      notification: true,
      notificationMetadata: { dueDate: true, predue: true },
    });
    const empty = notif({ notification: true, notificationMetadata: null });

    expect(configured).not.toEqual(empty);
    expect(configured.on_due_date).toBe(true);
    expect(configured.before_due).toBe(true);
    expect(configured.when_overdue).toBe(false);
    expect(empty.on_due_date).toBe(false);
  });

  test("a chore with notifications off reports nothing set", () => {
    expect(notif({ notification: false })).toEqual({
      enabled: false,
      reminders: [],
      on_due_date: false,
      before_due: false,
      when_overdue: false,
      on_completion: false,
    });
  });
});

describe("live-observed edge cases", () => {
  // These two used to assert the friendly reading, "every 5 days" and "on selected
  // days". Measured against a live v0.1.76 container: an interval created with the
  // unit omitted stores unit null, and completing it dereferences a nil pointer in
  // scheduleNextDueDate. The router has no Recovery middleware, so the connection is
  // dropped and the container logs "nil pointer dereference". Describing that chore
  // as an ordinary five-day interval told the caller it was fine while every
  // completion killed the request and every edit was refused by
  // assertSchedulableFrequency.
  test("an interval with a null unit reads as broken, because completing it crashes the request", () => {
    expect(
      summarizeFrequency(
        chore({ frequencyType: "interval", frequency: 5, frequencyMetadata: { unit: null } }),
      ),
    ).toBe("broken: an interval with no unit");
  });

  test("days_of_the_week with null days reads as broken, since the scheduler refuses it", () => {
    expect(
      summarizeFrequency(chore({ frequencyType: "days_of_the_week", frequencyMetadata: { days: null } })),
    ).toBe("broken: days_of_the_week with no days");
  });

  test("an hourly interval carrying a time reads as broken, since it never advances", () => {
    // Measured live: five consecutive completions each reported success against the
    // identical next due date. edit_chore already refused this shape; the read side
    // called it "every 4 hours".
    expect(
      summarizeFrequency(
        chore({
          frequencyType: "interval",
          frequency: 4,
          frequencyMetadata: { unit: "hours", time: "1970-01-01T09:00:00-04:00" },
        }),
      ),
    ).toBe("broken: an hourly interval carrying a time of day");
  });

  test("an hourly interval with no time is ordinary", () => {
    expect(
      summarizeFrequency(
        chore({ frequencyType: "interval", frequency: 4, frequencyMetadata: { unit: "hours" } }),
      ),
    ).toBe("every 4 hours");
  });

  test("a daily interval carrying a time is ordinary, since only hourly freezes", () => {
    expect(
      summarizeFrequency(
        chore({
          frequencyType: "interval",
          frequency: 2,
          frequencyMetadata: { unit: "days", time: "1970-01-01T09:00:00-04:00" },
        }),
      ),
    ).toBe("every 2 days");
  });

  test("a week pattern with no occurrences reads as broken, matching what the write side refuses", () => {
    // The write side started refusing this shape and the read side did not learn it,
    // which is the exact split this pairing exists to prevent: measured live, such a
    // chore fails every completion while the projection called it "every saturday".
    expect(
      summarizeFrequency(
        chore({
          frequencyType: "days_of_the_week",
          frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month" },
        }),
      ),
    ).toBe("broken: a week_of_month pattern with no occurrences");
  });

  test("the deprecated weekNumbers satisfies the occurrence read, as Donetick's getOccurrences does", () => {
    // Reading only `occurrences` described a monthly chore as weekly.
    expect(
      summarizeFrequency(
        chore({
          frequencyType: "days_of_the_week",
          frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month", weekNumbers: [1] },
        }),
      ),
    ).toBe("the 1st saturday of every month");
  });

  test("every_week needs no occurrences and is still plainly weekly", () => {
    expect(
      summarizeFrequency(
        chore({
          frequencyType: "days_of_the_week",
          frequencyMetadata: { days: ["saturday"], weekPattern: "every_week" },
        }),
      ),
    ).toBe("every saturday");
  });

  test("a well-formed interval is still described plainly", () => {
    expect(
      summarizeFrequency(
        chore({ frequencyType: "interval", frequency: 5, frequencyMetadata: { unit: "days" } }),
      ),
    ).toBe("every 5 days");
  });

  test("day_of_the_month with a day of 0 reads as broken, since the scheduler takes 1 to 31", () => {
    expect(
      summarizeFrequency(
        chore({ frequencyType: "day_of_the_month", frequency: 0, frequencyMetadata: { months: ["october"] } }),
      ),
    ).toBe("broken: day_of_the_month with a day of 0");
  });

  test("treats an empty-string completedAt as not done", () => {
    const out = projectChore(
      chore({
        subTasks: [{ id: 1, choreId: 7, name: "Sweep porch", completedAt: "" }],
      }),
      members,
      projects,
      now,
    );
    expect(out.subtasks).toEqual([{ name: "Sweep porch", done: false }]);
  });

  test("treats a missing completedAt as not done", () => {
    const subtaskMissingField = [{ id: 2, choreId: 7, name: "Rake leaves" }] as unknown as RawChore["subTasks"];
    const out = projectChore(chore({ subTasks: subtaskMissingField }), members, projects, now);
    expect(out.subtasks).toEqual([{ name: "Rake leaves", done: false }]);
  });

  test("describes 'first Saturday of every month' from days_of_the_week, where it lives", () => {
    // Measured on v0.1.76: this pattern schedules under days_of_the_week. Read off
    // day_of_the_month it described a chore Donetick could not schedule at all.
    const out = summarizeFrequency(
      chore({
        frequencyType: "days_of_the_week",
        frequencyMetadata: { weekPattern: "week_of_month", occurrences: [1], days: ["saturday"] },
      }),
    );
    expect(out).toBe("the 1st saturday of every month");
  });

  test("describes day_of_the_month by its calendar day, which Donetick keeps in frequency", () => {
    const out = summarizeFrequency(
      chore({ frequencyType: "day_of_the_month", frequency: 15, frequencyMetadata: { months: ["october"] } }),
    );
    expect(out).toBe("the 15th of october");
  });

  test("resolves no project when projectId is absent entirely, not just null", () => {
    const withoutProjectId = chore();
    delete (withoutProjectId as { projectId?: number | null }).projectId;
    expect(projectChore(withoutProjectId, members, projects, now).project).toBeNull();
  });

  test("falls back to the stringified number for an unrecognized status", () => {
    expect(projectChore(chore({ status: 9 }), members, projects, now).status).toBe("9");
  });

  test("falls back to the stringified number for an unrecognized priority", () => {
    expect(projectChore(chore({ priority: 7 }), members, projects, now).priority).toBe("7");
  });
});

describe("every occurrence shape reads back as the schedule Donetick runs", () => {
  const dow = (fm: Record<string, unknown>) =>
    summarizeFrequency(chore({ frequencyType: "days_of_the_week", frequencyMetadata: fm }));

  test("-1 is 'last', not '-1th'", () => {
    expect(dow({ days: ["saturday"], weekPattern: "week_of_month", occurrences: [-1] })).toBe(
      "the last saturday of every month",
    );
  });

  test("week_of_quarter says quarter rather than falling back to 'every saturday'", () => {
    expect(dow({ days: ["saturday"], weekPattern: "week_of_quarter", occurrences: [1] })).toBe(
      "the 1st saturday of every quarter",
    );
  });

  test("several occurrences are all named", () => {
    expect(dow({ days: ["saturday"], weekPattern: "week_of_month", occurrences: [1, 3] })).toBe(
      "the 1st, 3rd saturday of every month",
    );
  });

  test("a plain weekday schedule still reads plainly", () => {
    expect(dow({ days: ["monday", "thursday"] })).toBe("every monday, thursday");
  });
});

describe("fields the write tools set and nothing could read back", () => {
  test("is_private, assign_strategy and the assignee list are all projected", () => {
    // Two recent behavioral changes act on assign_strategy, and neither was
    // observable from a tool result. assignees matters separately: replacing the list
    // and adding to it produced identical-looking output without it.
    const projected = projectChore(
      chore({
        isPrivate: true,
        assignStrategy: "round_robin",
        assignees: [{ userId: 1 }, { userId: 99 }],
      }),
      members,
      projects,
      now,
    );

    expect(projected.is_private).toBe(true);
    expect(projected.assign_strategy).toBe("round_robin");
    expect(projected.assignees).toEqual(["Jared Glaser", "member #99 (unknown)"]);
  });

  test("a chore with nobody on it reports an empty list, not null", () => {
    expect(projectChore(chore({ assignees: [] }), members, projects, now).assignees).toEqual([]);
  });
});

describe("occurrence shapes Donetick stores but does not act on", () => {
  const dow = (fm: Record<string, unknown>) =>
    summarizeFrequency(chore({ frequencyType: "days_of_the_week", frequencyMetadata: fm }));

  test("every_week reads as weekly, not monthly", () => {
    // buildFrequency refuses this shape, but the projection reads whatever Donetick
    // stores, so a chore created in the web UI reaches it. Rendering it as an
    // occurrence pattern described a plain weekly chore as monthly, which is the
    // defect the render condition was narrowed to fix and which nothing pinned.
    expect(dow({ days: ["saturday"], weekPattern: "every_week", occurrences: [1] })).toBe(
      "every saturday",
    );
  });

  test("occurrences with no pattern read as weekly too, since Donetick ignores them", () => {
    expect(dow({ days: ["saturday"], occurrences: [1] })).toBe("every saturday");
  });
});
