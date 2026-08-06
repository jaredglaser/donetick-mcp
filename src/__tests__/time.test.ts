import { describe, expect, test } from "bun:test";
import { addDays, bucket, humanizeDueIn, startOfDay, zonedYmd } from "@/time";

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
