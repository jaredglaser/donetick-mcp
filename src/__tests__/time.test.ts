import { describe, expect, test } from "bun:test";
import { DUE_SCOPES, addDays, bucket, humanizeDueIn, startOfDay, type Scope, zonedYmd } from "@/time";

const NY = "America/New_York";
const SANTIAGO = "America/Santiago";
const HAVANA = "America/Havana";
const LORD_HOWE = "Australia/Lord_Howe";
const KATHMANDU = "Asia/Kathmandu";
const ADELAIDE = "Australia/Adelaide";

function localClock(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(instant);
}

describe("startOfDay", () => {
  test("returns local midnight as a utc instant", () => {
    const midnight = startOfDay(new Date("2026-06-15T18:30:00Z"), NY);
    expect(midnight.toISOString()).toBe("2026-06-15T04:00:00.000Z");
  });

  test("handles the fall-back day, when local midnight is 4 hours off utc", () => {
    const midnight = startOfDay(new Date("2026-11-01T12:00:00Z"), NY);
    expect(midnight.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("addDays", () => {
  test("adds a calendar day across the fall-back transition, not 24 hours", () => {
    // 2026-11-01 is 25 hours long in New York. Naive +24h would land at 23:00 on the 1st.
    const next = addDays(new Date("2026-11-01T12:00:00Z"), 1, NY);
    expect(zonedYmd(next, NY)).toEqual({ y: 2026, m: 11, d: 2 });
    expect(next.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  test("adds a calendar day across the spring-forward transition", () => {
    // 2026-03-08 is 23 hours long in New York.
    const next = addDays(new Date("2026-03-08T12:00:00Z"), 1, NY);
    expect(zonedYmd(next, NY)).toEqual({ y: 2026, m: 3, d: 9 });
  });

  test("spans 23.5 hours across Lord Howe's fractional DST shift", () => {
    const start = startOfDay(new Date("2026-10-04T12:00:00Z"), LORD_HOWE);
    const next = addDays(new Date("2026-10-04T12:00:00Z"), 1, LORD_HOWE);
    expect(localClock(next, LORD_HOWE)).toBe("2026-10-05, 00:00:00");
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23.5);
  });

  test("spans 25 hours across Adelaide's fall-back transition", () => {
    const start = startOfDay(new Date("2026-04-05T02:00:00Z"), ADELAIDE);
    const next = addDays(new Date("2026-04-05T02:00:00Z"), 1, ADELAIDE);
    expect(localClock(next, ADELAIDE)).toBe("2026-04-06, 00:00:00");
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("startOfDay on zones whose day has no midnight", () => {
  test("Santiago's DST-start day begins at 01:00, not 23:00 the day before", () => {
    // Chile's DST starts at midnight, so 00:00 on 2026-09-06 does not exist:
    // the clock jumps straight from 23:59:59 on the 5th to 01:00:00 on the 6th.
    const midnight = startOfDay(new Date("2026-09-06T12:00:00Z"), SANTIAGO);
    expect(localClock(midnight, SANTIAGO)).toBe("2026-09-06, 01:00:00");
  });

  test("Havana's DST-start day begins at 01:00", () => {
    const midnight = startOfDay(new Date("2026-03-08T12:00:00Z"), HAVANA);
    expect(localClock(midnight, HAVANA)).toBe("2026-03-08, 01:00:00");
  });

  test("Kathmandu's 45-minute utc offset still resolves to exact local midnight", () => {
    const midnight = startOfDay(new Date("2026-06-15T12:00:00Z"), KATHMANDU);
    expect(localClock(midnight, KATHMANDU)).toBe("2026-06-15, 00:00:00");
  });
});

describe("bucket", () => {
  const now = new Date("2026-11-01T16:00:00Z"); // noon local, on the 25-hour day

  test("a chore due at 23:30 local on the fall-back day is still due today", () => {
    // This is the exact case a naive startOfDay + 24h window drops.
    const due = new Date("2026-11-02T04:30:00Z"); // 23:30 local on Nov 1
    expect(bucket(due, "due_today", now, NY)).toBe(true);
  });

  test("a chore due just after local midnight is not due today", () => {
    const due = new Date("2026-11-02T05:30:00Z"); // 00:30 local on Nov 2
    expect(bucket(due, "due_today", now, NY)).toBe(false);
  });

  test("a past due date is overdue", () => {
    expect(bucket(new Date("2026-10-30T12:00:00Z"), "overdue", now, NY)).toBe(true);
  });

  // Every comparison below survived mutation: each edge could be flipped between
  // strict and inclusive, and the 7 in `withinDays = 7` could be changed to 8,
  // without failing anything. The DST cases above pinned the hard part and left the
  // ordinary boundaries open.
  describe("boundaries", () => {
    const at = (iso: string) => new Date(iso);
    const todayStart = at("2026-11-01T04:00:00Z"); // 00:00 local on the 25-hour day
    const tomorrowStart = at("2026-11-02T05:00:00Z"); // 00:00 local on Nov 2, after the fall back

    test("a chore due at this instant is not yet overdue", () => {
      expect(bucket(now, "overdue", now, NY)).toBe(false);
    });

    test("a chore due one millisecond ago is overdue", () => {
      expect(bucket(at("2026-11-01T15:59:59.999Z"), "overdue", now, NY)).toBe(true);
    });

    test("due_today includes local midnight exactly and excludes the next one", () => {
      expect(bucket(todayStart, "due_today", now, NY)).toBe(true);
      expect(bucket(new Date(todayStart.getTime() - 1), "due_today", now, NY)).toBe(false);
      expect(bucket(tomorrowStart, "due_today", now, NY)).toBe(false);
      expect(bucket(new Date(tomorrowStart.getTime() - 1), "due_today", now, NY)).toBe(true);
    });

    test("due_this_week spans exactly seven local days from today's start", () => {
      const weekEnd = at("2026-11-08T05:00:00Z"); // 00:00 local, seven days on
      expect(bucket(todayStart, "due_this_week", now, NY)).toBe(true);
      expect(bucket(new Date(todayStart.getTime() - 1), "due_this_week", now, NY)).toBe(false);
      expect(bucket(new Date(weekEnd.getTime() - 1), "due_this_week", now, NY)).toBe(true);
      expect(bucket(weekEnd, "due_this_week", now, NY)).toBe(false);
    });

    test("due_within_days defaults to the same seven days due_this_week uses", () => {
      // Defaulted independently here and at the list_chores call site, so the two
      // can drift apart with nothing failing.
      const weekEnd = at("2026-11-08T05:00:00Z");
      expect(bucket(new Date(weekEnd.getTime() - 1), "due_within_days", now, NY)).toBe(true);
      expect(bucket(weekEnd, "due_within_days", now, NY)).toBe(false);
    });

    test("an explicit withinDays overrides the default at both edges", () => {
      const oneDayOn = at("2026-11-02T05:00:00Z");
      expect(bucket(new Date(oneDayOn.getTime() - 1), "due_within_days", now, NY, 1)).toBe(true);
      expect(bucket(oneDayOn, "due_within_days", now, NY, 1)).toBe(false);
    });

    test("due_within_days excludes the past, so it is not a synonym for overdue", () => {
      expect(bucket(new Date(todayStart.getTime() - 1), "due_within_days", now, NY, 30)).toBe(false);
    });
  });

  test("a future due date is not overdue", () => {
    expect(bucket(new Date("2026-11-05T12:00:00Z"), "overdue", now, NY)).toBe(false);
  });

  test("null due date is unscheduled and nothing else", () => {
    expect(bucket(null, "unscheduled", now, NY)).toBe(true);
    expect(bucket(null, "overdue", now, NY)).toBe(false);
    expect(bucket(null, "due_today", now, NY)).toBe(false);
  });

  test("due_this_week covers the next seven calendar days", () => {
    expect(bucket(new Date("2026-11-07T16:00:00Z"), "due_this_week", now, NY)).toBe(true);
    expect(bucket(new Date("2026-11-09T16:00:00Z"), "due_this_week", now, NY)).toBe(false);
  });

  test("all matches everything including unscheduled", () => {
    expect(bucket(null, "all", now, NY)).toBe(true);
    expect(bucket(new Date("2026-11-05T12:00:00Z"), "all", now, NY)).toBe(true);
  });

  test("due_today on Santiago's midnight-skip day only counts the valid local day", () => {
    const santiagoNow = new Date("2026-09-06T15:00:00Z"); // noon local, on the day with no midnight
    const dueAt0130 = new Date("2026-09-06T04:30:00Z"); // 01:30 local on the 6th, just after the skip
    const dueAt2330 = new Date("2026-09-06T03:30:00Z"); // 23:30 local on the 5th, the day before
    expect(bucket(dueAt0130, "due_today", santiagoNow, SANTIAGO)).toBe(true);
    expect(bucket(dueAt2330, "due_today", santiagoNow, SANTIAGO)).toBe(false);
  });
});

describe("humanizeDueIn", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  test("reports overdue in days", () => {
    expect(humanizeDueIn(new Date("2026-06-13T12:00:00Z"), now)).toBe("2 days overdue");
  });

  test("reports the singular correctly", () => {
    expect(humanizeDueIn(new Date("2026-06-14T12:00:00Z"), now)).toBe("1 day overdue");
  });

  test("reports hours when inside a day", () => {
    expect(humanizeDueIn(new Date("2026-06-15T15:00:00Z"), now)).toBe("in 3 hours");
  });

  test("reports future days", () => {
    expect(humanizeDueIn(new Date("2026-06-18T12:00:00Z"), now)).toBe("in 3 days");
  });

  test("reports no due date", () => {
    expect(humanizeDueIn(null, now)).toBe("no due date");
  });
});

describe("days whose own midnight does not exist", () => {
  const SCL = "America/Santiago";
  const localOf = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(d);

  test("addDays lands on the true start of the target day, not the carried wall clock", () => {
    // 2026-09-06 starts DST in Santiago, so local 00:00 does not exist and the day
    // begins at 01:00. Temporal's add preserves wall-clock time, so adding a day
    // without re-normalizing would yield 01:00 on the 7th, which does have a midnight.
    const next = addDays(new Date("2026-09-06T14:00:00Z"), 1, SCL);
    expect(localOf(next, SCL)).toBe("2026-09-07, 00:00");
  });

  test("a chore just after midnight on the following day is not due today", () => {
    const now = new Date("2026-09-06T14:00:00Z");
    const justAfterMidnight = new Date("2026-09-07T03:30:00Z");
    expect(bucket(justAfterMidnight, "due_today", now, SCL)).toBe(false);
  });

  test("a chore late on the skip day itself is due today", () => {
    const now = new Date("2026-09-06T14:00:00Z");
    const lateSameDay = new Date("2026-09-07T02:30:00Z");
    expect(bucket(lateSameDay, "due_today", now, SCL)).toBe(true);
  });

  test("the skip day is 23 hours long, measured start to start", () => {
    const start = startOfDay(new Date("2026-09-06T14:00:00Z"), SCL);
    const next = addDays(new Date("2026-09-06T14:00:00Z"), 1, SCL);
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });
});


describe("scopes and buckets cannot drift apart", () => {
  test("every advertised scope has a bucketing rule", () => {
    // The two used to be separate lists. bucket's default arm answered an unknown
    // scope with false, so a scope added to the schema and not to bucket returned
    // zero chores and read as "you have none of those".
    const at = new Date("2026-06-15T12:00:00Z");
    for (const scope of DUE_SCOPES) {
      expect(() => bucket(at, scope, at, "America/New_York")).not.toThrow();
    }
  });

  test("a scope with no rule throws rather than filtering everything out", () => {
    expect(() =>
      bucket(
        new Date("2026-06-15T12:00:00Z"),
        "due_this_month" as unknown as Scope,
        new Date("2026-06-15T12:00:00Z"),
        "America/New_York",
      ),
    ).toThrow(/no rule for scope/);
  });
});
