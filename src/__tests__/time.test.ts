import { describe, expect, test } from "bun:test";
import { addDays, bucket, humanizeDueIn, startOfDay, zonedYmd } from "@/time";

const NY = "America/New_York";

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
