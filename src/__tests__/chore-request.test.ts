import { describe, expect, test } from "bun:test";
import {
  ASSIGN_STRATEGIES,
  buildCreateRequest,
  concurrencyToken,
  mergeEditRequest,
  type AssignStrategy,
  type BuildContext,
} from "@/chore-request";
import type { Member, Project, RawChore } from "@/types";

const tz = "America/New_York";
const now = new Date("2026-06-15T16:00:00Z");
const members: Member[] = [
  { userId: 1, username: "jared", displayName: "Jared Glaser", role: "admin", points: 0, pointsRedeemed: 0 },
  { userId: 2, username: "sam", displayName: "Sam", role: "member", points: 0, pointsRedeemed: 0 },
];
const projects: Project[] = [
  { id: 4, name: "Household" },
  { id: 9, name: "Yard" },
];

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return { members, projects, now, timezone: tz, ...overrides };
}

describe("ASSIGN_STRATEGIES", () => {
  test("covers all seven Donetick assign strategies", () => {
    const expected: AssignStrategy[] = [
      "no_assignee",
      "least_assigned",
      "least_completed",
      "random",
      "keep_last_assigned",
      "random_except_last_assigned",
      "round_robin",
    ];
    expect([...ASSIGN_STRATEGIES].sort()).toEqual(expected.sort());
  });
});

describe("buildCreateRequest", () => {
  test("always sets the two required enum fields", () => {
    // Donetick binds both as required. Omitting either is a 400 on every create.
    const body = buildCreateRequest({ name: "Trash" }, ctx());
    expect(body.frequencyType).toBe("once");
    expect(body.assignStrategy).toBe("no_assignee");
  });

  test("uses wire field names, not tool names", () => {
    const body = buildCreateRequest({ name: "Trash", due_date: "2026-07-01" }, ctx());
    expect(body).toHaveProperty("nextDueDate");
    expect(body).not.toHaveProperty("due_date");
    expect(body).not.toHaveProperty("assign_strategy");
    expect(body).toHaveProperty("assignStrategy");
  });

  test("resolves assignee names to user ids", () => {
    const body = buildCreateRequest({ name: "Trash", assignees: ["Sam"] }, ctx());
    expect(body.assignees).toEqual([{ userId: 2 }]);
    expect(body.assignedTo).toBe(2);
  });

  test("resolves an assignee by username as well as display name", () => {
    const body = buildCreateRequest({ name: "Trash", assignees: ["jared"] }, ctx());
    expect(body.assignees).toEqual([{ userId: 1 }]);
  });

  test("an unknown assignee name is an error naming the value and listing known members", () => {
    expect(() => buildCreateRequest({ name: "Trash", assignees: ["Nobody"] }, ctx())).toThrow(
      /Nobody/,
    );
    expect(() => buildCreateRequest({ name: "Trash", assignees: ["Nobody"] }, ctx())).toThrow(
      /Jared Glaser/,
    );
  });

  test("an unknown project name is an error naming the value and listing known projects", () => {
    expect(() => buildCreateRequest({ name: "Trash", project: "Garage" }, ctx())).toThrow(
      /Garage/,
    );
    expect(() => buildCreateRequest({ name: "Trash", project: "Garage" }, ctx())).toThrow(
      /Household/,
    );
  });

  test("resolves a known project to its id", () => {
    const body = buildCreateRequest({ name: "Trash", project: "Yard" }, ctx());
    expect(body.projectId).toBe(9);
  });

  test("assigning anyone switches the strategy off no_assignee", () => {
    const body = buildCreateRequest({ name: "Trash", assignees: ["Sam"] }, ctx());
    expect(body.assignStrategy).toBe("keep_last_assigned");
  });

  test("an explicit assign_strategy is honored even with no assignees", () => {
    const body = buildCreateRequest({ name: "Trash", assign_strategy: "round_robin" }, ctx());
    expect(body.assignStrategy).toBe("round_robin");
  });

  describe("priority mapping", () => {
    test("maps P1 through P4", () => {
      expect(buildCreateRequest({ name: "Trash", priority: "P1" }, ctx()).priority).toBe(1);
      expect(buildCreateRequest({ name: "Trash", priority: "P2" }, ctx()).priority).toBe(2);
      expect(buildCreateRequest({ name: "Trash", priority: "P3" }, ctx()).priority).toBe(3);
      expect(buildCreateRequest({ name: "Trash", priority: "P4" }, ctx()).priority).toBe(4);
    });

    test("maps none to 0", () => {
      expect(buildCreateRequest({ name: "Trash", priority: "none" }, ctx()).priority).toBe(0);
    });

    test("is case-insensitive", () => {
      expect(buildCreateRequest({ name: "Trash", priority: "p1" }, ctx()).priority).toBe(1);
      expect(buildCreateRequest({ name: "Trash", priority: "NONE" }, ctx()).priority).toBe(0);
    });

    test("defaults to none when omitted", () => {
      expect(buildCreateRequest({ name: "Trash" }, ctx()).priority).toBe(0);
    });

    test("rejects anything else, stating P1 is most urgent", () => {
      expect(() => buildCreateRequest({ name: "Trash", priority: "high" }, ctx())).toThrow(
        /P1.*most urgent/i,
      );
    });
  });

  describe("reschedule_from", () => {
    test("completion_date maps to isRolling true", () => {
      const body = buildCreateRequest(
        { name: "Trash", reschedule_from: "completion_date", due_date: "2026-07-01" },
        ctx(),
      );
      expect(body.isRolling).toBe(true);
    });

    test("due_date maps to isRolling false", () => {
      const body = buildCreateRequest({ name: "Trash", reschedule_from: "due_date" }, ctx());
      expect(body.isRolling).toBe(false);
    });

    test("omitted maps to isRolling false", () => {
      expect(buildCreateRequest({ name: "Trash" }, ctx()).isRolling).toBe(false);
    });

    test("rolling with no due date defaults the due date instead of sending an invalid body", () => {
      const body = buildCreateRequest({ name: "Trash", reschedule_from: "completion_date" }, ctx());
      expect(body.isRolling).toBe(true);
      expect(body.nextDueDate).not.toBeNull();
    });
  });

  test("builds subtasks in the wire shape", () => {
    const body = buildCreateRequest({ name: "Trash", subtasks: ["Bins out", "New bag"] }, ctx());
    expect(body.subTasks).toEqual([
      { name: "Bins out", orderId: 0, completedAt: null },
      { name: "New bag", orderId: 1, completedAt: null },
    ]);
  });

  describe("notify", () => {
    test("maps reminders onto notificationMetadata templates", () => {
      const body = buildCreateRequest(
        { name: "Trash", notify: { due_date: true, reminders: ["1h", "30m"] } },
        ctx(),
      );
      expect(body.notification).toBe(true);
      expect(body.notificationMetadata?.dueDate).toBe(true);
      expect(body.notificationMetadata?.templates).toEqual([
        { value: 1, unit: "h" },
        { value: 30, unit: "m" },
      ]);
    });

    test("rejects more than five reminders", () => {
      expect(() =>
        buildCreateRequest(
          { name: "Trash", notify: { reminders: ["1h", "2h", "3h", "4h", "5h", "6h"] } },
          ctx(),
        ),
      ).toThrow(/5/);
    });

    test("no notify means notification false and no metadata", () => {
      const body = buildCreateRequest({ name: "Trash" }, ctx());
      expect(body.notification).toBe(false);
      expect(body.notificationMetadata).toBeUndefined();
    });

    describe("reminder parsing", () => {
      test("accepts minutes, hours, and days", () => {
        const body = buildCreateRequest(
          { name: "Trash", notify: { reminders: ["90m", "2d"] } },
          ctx(),
        );
        expect(body.notificationMetadata?.templates).toEqual([
          { value: 90, unit: "m" },
          { value: 2, unit: "d" },
        ]);
      });

      test("is case-insensitive", () => {
        const body = buildCreateRequest({ name: "Trash", notify: { reminders: ["1H", "2D"] } }, ctx());
        expect(body.notificationMetadata?.templates).toEqual([
          { value: 1, unit: "h" },
          { value: 2, unit: "d" },
        ]);
      });

      test("rejects an unparseable offset", () => {
        expect(() =>
          buildCreateRequest({ name: "Trash", notify: { reminders: ["soon"] } }, ctx()),
        ).toThrow(/soon/);
      });
    });
  });
});

const existing: RawChore = {
  id: 7,
  name: "Take out trash",
  description: "curb by 7am",
  nextDueDate: "2026-06-18T13:00:00Z",
  assignedTo: 1,
  assignees: [{ userId: 1 }],
  assignStrategy: "keep_last_assigned",
  labelsV2: [{ id: 3, name: "outside" }],
  priority: 2,
  status: 0,
  frequencyType: "interval",
  frequency: 3,
  frequencyMetadata: { unit: "days", timezone: tz },
  isRolling: true,
  isPrivate: true,
  points: 5,
  projectId: 4,
  createdBy: 1,
  requireApproval: true,
  completionWindow: 120,
  notification: true,
  notificationMetadata: { dueDate: true, completion: false, predue: false, nagging: false },
  subTasks: [
    { id: 100, choreId: 7, name: "Bins out", completedAt: null, orderId: 0 },
    { id: 101, choreId: 7, name: "New bag", completedAt: "2026-06-01T00:00:00Z", orderId: 1 },
  ],
};

describe("mergeEditRequest", () => {
  test("carries every field forward when nothing is changed", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.id).toBe(7);
    expect(body.name).toBe("Take out trash");
    expect(body.frequencyType).toBe("interval");
    expect(body.frequency).toBe(3);
    expect(body.frequencyMetadata).toEqual({ unit: "days", timezone: tz });
    expect(body.priority).toBe(2);
    expect(body.points).toBe(5);
    expect(body.projectId).toBe(4);
    expect(body.isRolling).toBe(true);
    expect(body.requireApproval).toBe(true);
    expect(body.assignStrategy).toBe("keep_last_assigned");
  });

  test("preserves labels keyed id, which is what Donetick's LabelReq binds", () => {
    // /api/v1/labels is JWT-only, so a label lost on a write cannot be restored here.
    const body = mergeEditRequest(existing, {}, ctx());
expect(body.labelsV2).toEqual([{ id: 3 }]);
  });

  test("applies a name change and nothing else", () => {
    const body = mergeEditRequest(existing, { name: "Take out recycling" }, ctx());
    expect(body.name).toBe("Take out recycling");
    expect(body.frequency).toBe(3);
    expect(body.priority).toBe(2);
    expect(body.projectId).toBe(4);
  });

  test("applies a frequency change", () => {
    const body = mergeEditRequest(
      existing,
      { frequency: { type: "days_of_the_week", days: ["monday"] } },
      ctx(),
    );
    expect(body.frequencyType).toBe("days_of_the_week");
    expect(body.frequencyMetadata.days).toEqual(["monday"]);
  });

  test("add_assignees unions with existing assignees rather than replacing", () => {
    const body = mergeEditRequest(existing, { add_assignees: ["Sam"] }, ctx());
    expect(body.assignees).toEqual([{ userId: 1 }, { userId: 2 }]);
  });

  test("assignees replaces rather than unioning", () => {
    const body = mergeEditRequest(existing, { assignees: ["Sam"] }, ctx());
    expect(body.assignees).toEqual([{ userId: 2 }]);
  });

  test("never emits an id of zero or missing", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.id).toBeGreaterThan(0);
  });

  test("rejects an existing chore with a zero id rather than emitting an invalid write", () => {
    const zeroId: RawChore = { ...existing, id: 0 };
    expect(() => mergeEditRequest(zeroId, {}, ctx())).toThrow(/id/i);
  });

  test("completion_window round-trips through a merge", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.completionWindow).toBe(120);
  });

  test("is_private round-trips through a merge", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.isPrivate).toBe(true);
  });

  test("notification and notificationMetadata carry forward when notify is not given", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.notification).toBe(true);
    expect(body.notificationMetadata).toEqual({
      dueDate: true,
      completion: false,
      predue: false,
      nagging: false,
    });
  });

  test("notify overrides the carried-forward notification settings", () => {
    const body = mergeEditRequest(existing, { notify: { completion: true } }, ctx());
    expect(body.notificationMetadata?.completion).toBe(true);
    expect(body.notificationMetadata?.dueDate).toBe(false);
  });

  test("subtasks carry forward, preserving completion state, when not given", () => {
    const body = mergeEditRequest(existing, {}, ctx());
    expect(body.subTasks).toEqual([
      { id: 100, name: "Bins out", orderId: 0, completedAt: null },
      { id: 101, name: "New bag", orderId: 1, completedAt: "2026-06-01T00:00:00Z" },
    ]);
  });

  test("subtasks replace, resetting completion state, when explicitly given", () => {
    const body = mergeEditRequest(existing, { subtasks: ["Just one"] }, ctx());
    expect(body.subTasks).toEqual([{ name: "Just one", orderId: 0, completedAt: null }]);
  });

  describe("merging when the existing chore has no assignees array, only assignedTo", () => {
    const legacy: RawChore = { ...existing, assignees: undefined, assignedTo: 1 };

    test("assignedTo is preserved rather than dropped", () => {
      const body = mergeEditRequest(legacy, {}, ctx());
      expect(body.assignees).toEqual([{ userId: 1 }]);
      expect(body.assignedTo).toBe(1);
    });

    test("assignStrategy is not silently reset to no_assignee", () => {
      const body = mergeEditRequest(legacy, {}, ctx());
      expect(body.assignStrategy).toBe("keep_last_assigned");
    });

    test("add_assignees still unions correctly", () => {
      const body = mergeEditRequest(legacy, { add_assignees: ["Sam"] }, ctx());
      expect(body.assignees).toEqual([{ userId: 1 }, { userId: 2 }]);
    });
  });

  describe("assignedTo after a merge is never a stale, removed assignee", () => {
    test("assignedTo moves to the remaining assignee when the current one is dropped", () => {
      const body = mergeEditRequest(existing, { assignees: ["Sam"] }, ctx());
      expect(body.assignedTo).toBe(2);
    });

    test("assignedTo becomes null when every assignee is cleared", () => {
      const body = mergeEditRequest(existing, { assignees: [] }, ctx());
      expect(body.assignees).toEqual([]);
      expect(body.assignedTo).toBeNull();
    });

    test("assignedTo stays put when it is still among the resulting assignees", () => {
      const body = mergeEditRequest(existing, { add_assignees: ["Sam"] }, ctx());
      expect(body.assignedTo).toBe(1);
    });
  });

  describe("clearing a field", () => {
    test("points: null clears the value, because the schema advertises that it can", () => {
      // The merge used a ?? chain here, under which an explicit null is nullish and
      // falls through to the existing value exactly like undefined. The schema says
      // points is nullable, so a caller asked to "remove the points" sends null and
      // was told it worked while nothing changed. Advertising a capability that
      // no-ops is worse than not offering it, so the check is against undefined.
      expect(mergeEditRequest(existing, { points: null }, ctx()).points).toBeNull();
    });

    test("omitting points still preserves the existing value", () => {
      expect(mergeEditRequest(existing, { name: "Renamed" }, ctx()).points).toBe(5);
    });

    test("points: 0 is kept rather than treated as absent", () => {
      expect(mergeEditRequest(existing, { points: 0 }, ctx()).points).toBe(0);
    });

    test("an explicit empty assignee list does clear assignees, unlike points: null", () => {
      // Unlike a `??` fallback, `assignees: []` is not nullish, so it is distinguishable
      // from "not provided" and takes effect as a real replacement with zero entries.
      const body = mergeEditRequest(existing, { assignees: [] }, ctx());
      expect(body.assignees).toEqual([]);
    });

    test("due_date: null does not put a null in the full-edit body, because the server ignores one", () => {
      // null means "keep" here; editChore clears via PUT /:id/dueDate.
      const body = mergeEditRequest(existing, { due_date: null, reschedule_from: "due_date" }, ctx());
      expect(body.nextDueDate).toBe("2026-06-18T13:00:00.000Z");
    });
  });

  describe("merging from a /details-shaped object", () => {
    // GET /chores/:id/details omits assignStrategy, assignees, frequency,
    // frequencyMetadata, isRolling, isPrivate, labelsV2, notification,
    // notificationMetadata, points, requireApproval: every field a write requires.
    // Merging onto it would silently destroy recurrence, labels, points, assignees,
    // and the approval flag on every edit, so this is rejected outright rather than
    // degraded, to catch a caller wiring the wrong source in before it reaches Donetick.
    const detailsShaped: RawChore = {
      id: 7,
      name: "Take out trash",
      description: "curb by 7am",
      nextDueDate: "2026-06-18T13:00:00Z",
      assignedTo: 1,
      priority: 2,
      status: 0,
      frequencyType: "interval",
      createdBy: 1,
      completionWindow: 120,
      lastCompletedDate: "2026-06-11T13:00:00Z",
      totalCompletedCount: 4,
    };

    test("is rejected rather than silently degraded", () => {
      expect(() => mergeEditRequest(detailsShaped, {}, ctx())).toThrow();
    });

    test("the error explains what went wrong", () => {
      expect(() => mergeEditRequest(detailsShaped, {}, ctx())).toThrow(/details/i);
    });
  });
});

describe("the due date survives an unrelated edit", () => {
  // The one merge field with no preservation coverage anywhere, unit or live.
  // Deleting the carry-forward left the whole suite and every live check green: because the fixture is rolling, ensureDueDateForRolling
  // rewrote the resulting null to today, so a rename silently rescheduled the
  // chore rather than producing anything that looked like a failure.

  test("a rename keeps the existing due date", () => {
    expect(mergeEditRequest(existing, { name: "Renamed" }, ctx()).nextDueDate).toBe(
      "2026-06-18T13:00:00.000Z",
    );
  });

  test("keeps it on a chore that does not roll, where nothing would rewrite a lost value", () => {
    const notRolling = { ...existing, isRolling: false } as RawChore;
    expect(mergeEditRequest(notRolling, { priority: "P1" }, ctx()).nextDueDate).toBe(
      "2026-06-18T13:00:00.000Z",
    );
  });

  test("an explicit due_date still replaces it", () => {
    expect(mergeEditRequest(existing, { due_date: "2026-07-01" }, ctx()).nextDueDate).toContain(
      "2026-07-01",
    );
  });

  test("due_date null leaves the body carrying the current date, since the server ignores a null here", () => {
    // null means "keep" here; editChore clears via PUT /:id/dueDate.
    const notRolling = { ...existing, isRolling: false } as RawChore;
    expect(mergeEditRequest(notRolling, { due_date: null }, ctx()).nextDueDate).toBe(
      "2026-06-18T13:00:00.000Z",
    );
  });
});

describe("description is never null on the wire", () => {
  // Verified on Donetick v0.1.76: PUT /api/v1/chores/ with description null, or
  // with the key missing, kills the connection and the proxy answers 502. An empty
  // string is accepted. A chore created without a description stores null, so
  // carrying its own value forward unchanged is what triggered this, and it made
  // edit_chore fail on precisely the chores most likely to exist. The type says
  // string, so these guard the two ?? chains that produce it rather than the type.

  test("a create with no description sends an empty string, not null", () => {
    const body = buildCreateRequest({ name: "Water plants" }, ctx());
    expect(body.description).toBe("");
  });

  test("an edit of a chore with a null description sends an empty string", () => {
    const noDescription = { ...existing, description: null } as unknown as RawChore;
    expect(mergeEditRequest(noDescription, {}, ctx()).description).toBe("");
  });

  test("an edit of a chore whose description field is absent sends an empty string", () => {
    const { description: _omitted, ...withoutDescription } = existing;
    expect(mergeEditRequest(withoutDescription as RawChore, {}, ctx()).description).toBe("");
  });

  test("an existing description still survives an unrelated edit", () => {
    expect(mergeEditRequest(existing, { name: "Renamed" }, ctx()).description).toBe("curb by 7am");
  });

  test("a caller can still replace the description", () => {
    expect(mergeEditRequest(existing, { description: "new text" }, ctx()).description).toBe(
      "new text",
    );
  });
});

describe("concurrencyToken", () => {
  const now = new Date("2026-08-06T16:00:00.500Z");
  const withStamp = (updatedAt: string | undefined) =>
    ({ ...existing, updatedAt }) as unknown as RawChore;

  test("sends the row's stamp even when it is older than the clock", () => {
    // Sending now instead looks equivalent and is not: PUT /:id/assignee writes the
    // token it receives into the row, so a client running ahead stamps the chore
    // with a future version and locks it out of editing until the skew passes.
    const stamp = "2026-08-06T15:00:00.000Z";
    expect(concurrencyToken(withStamp(stamp), now)).toBe(stamp);
  });

  test("uses the row's own stamp when it is newer than the local clock too", () => {
    // Measured live: the server's clock ran ahead of the client's, so a write
    // issued right after another sent a "now" already behind the row it was
    // editing, and Donetick refused it with a 403 that reads as a permission
    // problem rather than a clock problem.
    const ahead = "2026-08-06T16:00:01.000Z";
    expect(concurrencyToken(withStamp(ahead), now)).toBe(ahead);
  });

  test("passes a same-millisecond stamp through verbatim rather than reformatting it", () => {
    // Donetick stamps with nanosecond precision. Rebuilding the value through Date
    // truncates it downward, which lands just under the stored value and is refused
    // for being older, so the original string has to survive intact.
    const nanos = "2026-08-06T16:00:00.500123456Z";
    expect(concurrencyToken(withStamp(nanos), now)).toBe(nanos);
  });

  test("falls back to now when the row carries no stamp", () => {
    expect(concurrencyToken(withStamp(undefined), now)).toBe(now.toISOString());
  });

  test("falls back to now only when the row carries no stamp at all", () => {
    expect(concurrencyToken(withStamp(undefined), now)).toBe(now.toISOString());
  });
});

describe("a chore driven by a Donetick Thing", () => {
  // EditChore dissociates the Thing unconditionally and re-associates only for a
  // request carrying thingTrigger, which this server never sends and cannot build.
  // The edit would answer 200, the read-back would look normal, and the chore would
  // simply never fire again.
  const thingDriven = { ...existing, thingChore: { thingId: 3 } } as unknown as RawChore;

  test("is refused rather than silently severed", () => {
    expect(() => mergeEditRequest(thingDriven, { name: "Renamed" }, ctx())).toThrow(/Thing/);
  });

  test("the error says where the edit can be made instead", () => {
    expect(() => mergeEditRequest(thingDriven, {}, ctx())).toThrow(/web UI/);
  });

  test("an ordinary chore is unaffected, including one whose thingChore is null", () => {
    expect(() => mergeEditRequest(existing, { name: "Renamed" }, ctx())).not.toThrow();
    const nulled = { ...existing, thingChore: null } as unknown as RawChore;
    expect(() => mergeEditRequest(nulled, { name: "Renamed" }, ctx())).not.toThrow();
  });
});

describe("combinations Donetick cannot complete", () => {
  // Donetick dereferences NextDueDate without a nil check when a chore has a
  // completion window, and its adaptive scheduler does the same. Either with no due
  // date creates a chore that answers 502 on every completion, permanently.

  test("a completion window with no due date is refused on create", () => {
    expect(() => buildCreateRequest({ name: "x", completion_window: 4 }, ctx())).toThrow(
      /completion window/i,
    );
  });

  test("an adaptive frequency with no due date is refused on create", () => {
    expect(() =>
      buildCreateRequest({ name: "x", frequency: { type: "adaptive" } }, ctx()),
    ).toThrow(/adaptive/i);
  });

  test("both are fine once a due date is given", () => {
    expect(() =>
      buildCreateRequest({ name: "x", completion_window: 4, due_date: "2026-07-01" }, ctx()),
    ).not.toThrow();
    expect(() =>
      buildCreateRequest(
        { name: "x", frequency: { type: "adaptive" }, due_date: "2026-07-01" },
        ctx(),
      ),
    ).not.toThrow();
  });

  test("a completion window of zero still needs a due date", () => {
    // Measured: a chore with completionWindow 0 and no due date answers 502 on every
    // completion, exactly as one with 4 does. Donetick gates the due-date deref on
    // the pointer being non-nil, not on the value, and 0 is not nullish so it
    // survives the ?? chain and reaches the wire as a real window.
    expect(() => buildCreateRequest({ name: "x", completion_window: 0 }, ctx())).toThrow(
      /completion window/i,
    );
  });

  test("no completion window at all is still fine without a due date", () => {
    expect(() => buildCreateRequest({ name: "x" }, ctx())).not.toThrow();
  });
});

describe("adding a checklist item without destroying the checklist", () => {
  const withList = {
    ...existing,
    subTasks: [
      { id: 1, choreId: 7, name: "Bins to curb", completedAt: "2026-06-14T10:00:00Z" },
      { id: 2, choreId: 7, name: "Replace bag", completedAt: null },
    ],
  } as unknown as RawChore;

  test("add_subtasks keeps the existing items, their ids, and their ticked state", () => {
    // subtasks alone replaces the list, and buildSubtasks emits no ids and a null
    // completedAt, so the only way to add an item was to untick everything.
    const body = mergeEditRequest(withList, { add_subtasks: ["Wipe lid"] }, ctx());

    expect(body.subTasks?.map((t) => t.name)).toEqual(["Bins to curb", "Replace bag", "Wipe lid"]);
    expect(body.subTasks?.[0]?.id).toBe(1);
    expect(body.subTasks?.[0]?.completedAt).toBe("2026-06-14T10:00:00Z");
    expect(body.subTasks?.[2]?.completedAt).toBeNull();
  });

  test("the appended item is ordered after the existing ones", () => {
    const body = mergeEditRequest(withList, { add_subtasks: ["Wipe lid"] }, ctx());
    expect(body.subTasks?.map((t) => t.orderId)).toEqual([0, 1, 2]);
  });

  test("subtasks still replaces outright, which is what it says it does", () => {
    const body = mergeEditRequest(withList, { subtasks: ["Only this"] }, ctx());
    expect(body.subTasks?.map((t) => t.name)).toEqual(["Only this"]);
    expect(body.subTasks?.[0]?.completedAt).toBeNull();
  });

  test("add_subtasks on a chore with no checklist just creates one", () => {
    const body = mergeEditRequest(existing, { add_subtasks: ["First"] }, ctx());
    expect(body.subTasks?.map((t) => t.name)).toContain("First");
  });
});

describe("a chore's own timezone survives an edit", () => {
  // Every merge fixture set frequencyMetadata.timezone to the same string as the
  // build context, so "read it from the chore" and "read it from the config" were
  // indistinguishable. Donetick's scheduler honors the chore's own zone, so
  // clobbering it silently reschedules the chore into the server's zone.
  test("the chore's zone wins over the server default", () => {
    const tokyo = {
      ...existing,
      frequencyMetadata: { unit: "days", timezone: "Asia/Tokyo" },
    } as unknown as RawChore;

    expect(mergeEditRequest(tokyo, { name: "Renamed" }, ctx()).frequencyMetadata.timezone).toBe(
      "Asia/Tokyo",
    );
  });

  test("the server default fills in when the chore carries no zone", () => {
    const zoneless = { ...existing, frequencyMetadata: { unit: "days" } } as unknown as RawChore;

    expect(mergeEditRequest(zoneless, { name: "Renamed" }, ctx()).frequencyMetadata.timezone).toBe(tz);
  });
});

describe("a stored subtask order survives an edit", () => {
  test("non-contiguous orderIds are carried, not renumbered", () => {
    // Every fixture had orderId equal to its array index, so "carry the stored
    // value" and "use the position" produced identical output. Deleting a subtask in
    // the web UI leaves gaps, and renumbering reorders the user's checklist.
    const gapped = {
      ...existing,
      subTasks: [
        { id: 1, choreId: 7, name: "first", completedAt: null, orderId: 3 },
        { id: 2, choreId: 7, name: "second", completedAt: null, orderId: 7 },
      ],
    } as unknown as RawChore;

    expect(mergeEditRequest(gapped, { name: "Renamed" }, ctx()).subTasks?.map((t) => t.orderId)).toEqual(
      [3, 7],
    );
  });
});

describe("the Thing guard's live half", () => {
  test("a trigger chore is refused even when thingChore is absent from the row", () => {
    // The thingChore half never fires in production: Donetick's list query does not
    // preload it, so the field is null on every row this server merges from. The
    // fixture that set it was testing the dead branch.
    const trigger = {
      ...existing,
      frequencyType: "trigger",
      thingChore: null,
    } as unknown as RawChore;

    expect(() => mergeEditRequest(trigger, { name: "Renamed" }, ctx())).toThrow(/Thing/);
  });
});

describe("add_subtasks on a chore that genuinely has no checklist", () => {
  test("creates one rather than throwing", () => {
    // The test that claimed to cover this used a fixture with two subtasks, so the
    // empty case was never exercised and a missing null guard would have crashed.
    const bare = { ...existing, subTasks: [] } as unknown as RawChore;

    expect(mergeEditRequest(bare, { add_subtasks: ["First"] }, ctx()).subTasks).toEqual([
      { name: "First", orderId: 0, completedAt: null },
    ]);
  });
});

describe("combinations that would crash or silently revert on Donetick's side", () => {
  test("an assignment never carries no_assignee forward, which would revert on the next completion", () => {
    // Donetick's next-assignee step maps no_assignee to nil and persists it, so an
    // assignment that lands and reports success is undone the first time anyone
    // completes the chore.
    const unassigned = {
      ...existing,
      assignStrategy: "no_assignee",
      assignees: [],
      assignedTo: null,
    } as unknown as RawChore;

    const body = mergeEditRequest(unassigned, { add_assignees: ["Sam"] }, ctx());

    expect(body.assignees).toEqual([{ userId: 2 }]);
    expect(body.assignStrategy).not.toBe("no_assignee");
  });

  test("a chore genuinely left with nobody on it keeps no_assignee", () => {
    const unassigned = {
      ...existing,
      assignStrategy: "no_assignee",
      assignees: [],
      assignedTo: null,
    } as unknown as RawChore;

    expect(mergeEditRequest(unassigned, { name: "Renamed" }, ctx()).assignStrategy).toBe(
      "no_assignee",
    );
  });

  test("notification is never carried forward without the metadata it is read against", () => {
    // Donetick's planner dereferences the metadata whenever notification is true, in
    // a goroutine whose panic is not recovered by the request middleware. A chore
    // whose metadata column is null comes back as null, which is the shape that
    // reaches that deref.
    const noMetadata = {
      ...existing,
      notification: true,
      notificationMetadata: null,
    } as unknown as RawChore;

    const body = mergeEditRequest(noMetadata, { name: "Renamed" }, ctx());

    expect(body.notification).toBe(false);
    expect(body).not.toHaveProperty("notificationMetadata");
  });

  test("a chore with real metadata keeps both", () => {
    const body = mergeEditRequest(existing, { name: "Renamed" }, ctx());
    expect(body.notification).toBe(true);
    expect(body.notificationMetadata).toBeDefined();
  });
});

describe("a stored recurrence Donetick cannot schedule", () => {
  // This server built "first saturday of every month" as day_of_the_month with
  // weekday names until the mapping was corrected, and such a chore answers 500 on
  // every completion. The carry-forward branch would re-send that shape and report
  // success, so it is refused, but only there: a caller passing frequency is
  // replacing the recurrence, which is the repair.
  const broken = {
    ...existing,
    frequencyType: "day_of_the_month",
    frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month", occurrences: [1] },
  } as unknown as RawChore;

  test("an unrelated edit is refused rather than re-sending it", () => {
    expect(() => mergeEditRequest(broken, { name: "Renamed" }, ctx())).toThrow(/cannot schedule/);
  });

  test("the repair the message names is allowed through", () => {
    expect(() =>
      mergeEditRequest(
        broken,
        {
          frequency: {
            type: "days_of_the_week",
            days: ["saturday"],
            week_pattern: "week_of_month",
            occurrences: [1],
          },
        },
        ctx(),
      ),
    ).not.toThrow();
  });

  test("the other repair it names is allowed through too", () => {
    expect(() =>
      mergeEditRequest(
        broken,
        { frequency: { type: "day_of_the_month", day_of_month: 1, months: ["october"] } },
        ctx(),
      ),
    ).not.toThrow();
  });

  test("day_of_the_month with no months is refused the same way", () => {
    const noMonths = {
      ...existing,
      frequencyType: "day_of_the_month",
      frequency: 15,
      frequencyMetadata: { timezone: tz },
    } as unknown as RawChore;
    expect(() => mergeEditRequest(noMonths, { name: "Renamed" }, ctx())).toThrow(/cannot schedule/);
  });

  test("a well-formed day_of_the_month is untouched", () => {
    const fine = {
      ...existing,
      frequencyType: "day_of_the_month",
      frequency: 15,
      frequencyMetadata: { months: ["october"], timezone: tz },
    } as unknown as RawChore;
    expect(() => mergeEditRequest(fine, { name: "Renamed" }, ctx())).not.toThrow();
  });
});

describe("settings an unrelated edit must not change", () => {
  test("notifications stay off on a chore whose metadata row outlived them", () => {
    // Donetick keeps the metadata when notifications are switched off, so
    // notification false with non-null metadata is a real stored shape. Reading only
    // the metadata would turn every unrelated edit into a re-enable.
    const off = { ...existing, notification: false } as unknown as RawChore;

    expect(mergeEditRequest(off, { name: "Renamed" }, ctx()).notification).toBe(false);
  });

  test("an explicit assign_strategy is honored over the promotion", () => {
    // The promotion exists for a chore that would revert on the next completion, but
    // a caller naming a strategy has said what they want.
    const unassigned = {
      ...existing,
      assignStrategy: "no_assignee",
      assignees: [],
      assignedTo: null,
    } as unknown as RawChore;

    expect(
      mergeEditRequest(
        unassigned,
        { assign_strategy: "no_assignee", add_assignees: ["Sam"] },
        ctx(),
      ).assignStrategy,
    ).toBe("no_assignee");
  });
});

describe("clearing a project", () => {
  test("null takes the chore out of its project", () => {
    // The same defect the points fix repaired on the neighbouring field: a ?? chain
    // made "take this out of the project" a silent no-op that reported success.
    expect(mergeEditRequest(existing, { project: null }, ctx()).projectId).toBeNull();
  });

  test("omitting it keeps the chore where it is", () => {
    expect(mergeEditRequest(existing, { name: "Renamed" }, ctx()).projectId).toBe(4);
  });

  test("a name still moves it", () => {
    expect(mergeEditRequest(existing, { project: "Yard" }, ctx()).projectId).toBe(9);
  });
});

describe("an hourly chore already carrying a time", () => {
  const frozen = {
    ...existing,
    frequencyType: "interval",
    frequency: 4,
    frequencyMetadata: { unit: "hours", time: "1970-01-01T07:00:00-04:00", timezone: tz },
  } as unknown as RawChore;

  test("an unrelated edit is refused rather than keeping it stuck", () => {
    // It reschedules to the instant it is already at from the second completion, so
    // carrying the shape forward leaves it permanently overdue.
    expect(() => mergeEditRequest(frozen, { name: "Renamed" }, ctx())).toThrow(/freezes/);
  });

  test("the repair it names is allowed through", () => {
    expect(() =>
      mergeEditRequest(frozen, { frequency: { type: "interval", every: 4, unit: "hours" } }, ctx()),
    ).not.toThrow();
  });

  test("an hourly chore with no time is untouched", () => {
    const fine = {
      ...existing,
      frequencyType: "interval",
      frequencyMetadata: { unit: "hours", timezone: tz },
    } as unknown as RawChore;
    expect(() => mergeEditRequest(fine, { name: "Renamed" }, ctx())).not.toThrow();
  });
});
