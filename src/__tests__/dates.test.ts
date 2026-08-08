import { describe, expect, test } from "bun:test";
import { parseDueDate } from "@/dates";

const NY = "America/New_York";
const now = new Date("2026-06-15T16:00:00Z"); // Monday, noon in New York

describe("parseDueDate", () => {
  test("passes an RFC3339 instant through unchanged", () => {
    expect(parseDueDate("2026-07-01T14:30:00Z", now, NY).toISOString()).toBe(
      "2026-07-01T14:30:00.000Z",
    );
  });

  test("a bare date resolves to 09:00 in the target zone", () => {
    expect(parseDueDate("2026-07-01", now, NY).toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  test("today resolves to 09:00 local today", () => {
    expect(parseDueDate("today", now, NY).toISOString()).toBe("2026-06-15T13:00:00.000Z");
  });

  test("tomorrow resolves to 09:00 local tomorrow", () => {
    expect(parseDueDate("tomorrow", now, NY).toISOString()).toBe("2026-06-16T13:00:00.000Z");
  });

  test("in N days counts calendar days", () => {
    expect(parseDueDate("in 3 days", now, NY).toISOString()).toBe("2026-06-18T13:00:00.000Z");
  });

  test("in N weeks counts calendar days", () => {
    expect(parseDueDate("in 2 weeks", now, NY).toISOString()).toBe("2026-06-29T13:00:00.000Z");
  });

  test("next <weekday> finds the next occurrence, never today", () => {
    // 2026-06-15 is a Monday. "next monday" must be the 22nd, not today.
    expect(parseDueDate("next monday", now, NY).toISOString()).toBe("2026-06-22T13:00:00.000Z");
    expect(parseDueDate("next friday", now, NY).toISOString()).toBe("2026-06-19T13:00:00.000Z");
  });

  test("a bare weekday behaves like next weekday", () => {
    expect(parseDueDate("friday", now, NY).toISOString()).toBe("2026-06-19T13:00:00.000Z");
  });

  test("parsing is case and whitespace insensitive", () => {
    expect(parseDueDate("  Tomorrow  ", now, NY).toISOString()).toBe(
      parseDueDate("tomorrow", now, NY).toISOString(),
    );
  });

  test("crossing the spring-forward boundary still lands at 09:00 local", () => {
    const before = new Date("2026-03-06T17:00:00Z"); // Friday, noon EST
    // 2026-03-08 is the spring-forward day, so the offset changes underneath.
    expect(parseDueDate("in 3 days", before, NY).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  test("an unparseable string throws with the accepted formats", () => {
    expect(() => parseDueDate("sometime next quarter", now, NY)).toThrow(/YYYY-MM-DD/);
  });

  test("null clears the due date", () => {
    expect(parseDueDate(null, now, NY)).toBeNull();
  });
});

describe("parseDueDate, additional coverage", () => {
  const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14
  const NIUE = "Pacific/Niue"; // UTC-11
  const SANTIAGO = "America/Santiago";

  test("a far-east zone (UTC+14) resolves a bare date to 09:00 on the intended local day", () => {
    const result = parseDueDate("2026-07-01", now, KIRITIMATI);
    expect(result).not.toBeNull();
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: KIRITIMATI,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(result!);
    expect(local).toBe("2026-07-01, 09:00");
  });

  test("a far-west zone (UTC-11) resolves a bare date to 09:00 on the intended local day", () => {
    const result = parseDueDate("2026-07-01", now, NIUE);
    expect(result).not.toBeNull();
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: NIUE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(result!);
    expect(local).toBe("2026-07-01, 09:00");
  });

  test("a bare date on a DST-start day whose midnight does not exist still lands at 09:00 local", () => {
    // 2026-09-06 is Santiago's DST-start day: startOfDay returns 01:00, not 00:00.
    // Naively adding 9 hours to that 01:00 instant lands at 10:00 local, not 09:00,
    // because from 01:00 onward the wall clock advances 1:1 with elapsed time and
    // no further transition happens that day. Constructing the ZonedDateTime
    // directly at the target calendar date and 09:00 wall-clock time sidesteps this.
    const result = parseDueDate("2026-09-06", now, SANTIAGO);
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: SANTIAGO,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(result!);
    expect(local).toBe("2026-09-06, 09:00");
  });

  test("yesterday resolves to 09:00 local yesterday", () => {
    expect(parseDueDate("yesterday", now, NY)!.toISOString()).toBe("2026-06-14T13:00:00.000Z");
  });

  // Null is the only clear. As null these two let edit_chore drop the stored date
  // and reschedule a rolling chore to today 09:00, while reschedule_chore read the
  // same string as a deliberate clear.
  // Matching the empty-string message specifically, because matching the shared
  // format help could not tell the guard from its absence: the fall-through throws
  // that same help, so both of these passed with the branch deleted.
  test("an empty string is a parse error, not a silent clear", () => {
    expect(() => parseDueDate("", now, NY)).toThrow(/pass null for "no due date"/);
  });

  test("a whitespace-only string is a parse error too", () => {
    expect(() => parseDueDate("   ", now, NY)).toThrow(/pass null for "no due date"/);
  });

  test("a string that is merely unparseable still gets the plain format help", () => {
    // The mirror: widening the empty-string branch to every parse failure would tell
    // a caller who wrote "nextg tuesday" to pass null, which is not their problem.
    expect(() => parseDueDate("nextg tuesday", now, NY)).toThrow(/Could not parse/);
    expect(() => parseDueDate("nextg tuesday", now, NY)).not.toThrow(/pass null/);
  });

  test("a relative offset past ten years is refused with a bound, not a RangeError", () => {
    // The regex accepts any run of digits. Past four digits of year toISOString
    // switches to the extended +010240-.. form, which Go's RFC3339 binding rejects
    // with an opaque 400; further out Temporal throws a RangeError that would reach
    // the caller instead of the format help.
    expect(() => parseDueDate("in 3000000 days", now, NY)).toThrow(/too far ahead/);
    expect(() => parseDueDate("in 99999999 days", now, NY)).toThrow(/too far ahead/);
    expect(() => parseDueDate("in 3651 days", now, NY)).toThrow(/too far ahead/);
  });

  test("the bound is inclusive, and weeks are converted before it is applied", () => {
    expect(parseDueDate("in 3650 days", now, NY)).toBeInstanceOf(Date);
    expect(parseDueDate("in 521 weeks", now, NY)).toBeInstanceOf(Date); // 3647 days
    expect(() => parseDueDate("in 522 weeks", now, NY)).toThrow(/too far ahead/);
  });

  test("in 1 day is singular and matches in 1 days worth of offset", () => {
    expect(parseDueDate("in 1 day", now, NY)!.toISOString()).toBe(
      parseDueDate("tomorrow", now, NY)!.toISOString(),
    );
  });

  test("in 0 days means today, at 09:00 local", () => {
    expect(parseDueDate("in 0 days", now, NY)!.toISOString()).toBe(
      parseDueDate("today", now, NY)!.toISOString(),
    );
  });

  const WEEKDAYS = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ] as const;

  for (let i = 0; i < 7; i++) {
    const day = WEEKDAYS[i]!;
    test(`a bare "${day}" queried on a ${day} resolves seven days out`, () => {
      // now is a Monday (2026-06-15). Walk to the instance of `now` whose
      // local weekday is `day`, then confirm querying that same weekday
      // from that instant lands exactly seven calendar days later.
      const offsetFromMonday = (i + 6) % 7; // sunday(0) -> 6, monday(1) -> 0, ...
      const queriedFrom = new Date(now.getTime() + offsetFromMonday * 86_400_000);
      const result = parseDueDate(day, queriedFrom, NY)!;
      const expected = new Date(
        parseDueDate("today", queriedFrom, NY)!.getTime() + 7 * 86_400_000,
      );
      expect(result.toISOString()).toBe(expected.toISOString());
    });
  }

  test("a leading NEXT with mixed case still resolves forward", () => {
    expect(parseDueDate("NEXT Friday", now, NY)!.toISOString()).toBe(
      parseDueDate("next friday", now, NY)!.toISOString(),
    );
  });

  test("doubled internal whitespace in a relative phrase is accepted", () => {
    // Whitespace carries no meaning in these phrases (only the RFC3339 and
    // YYYY-MM-DD forms are whitespace-sensitive), so repeated spaces collapse.
    expect(parseDueDate("in  3  days", now, NY)!.toISOString()).toBe(
      parseDueDate("in 3 days", now, NY)!.toISOString(),
    );
  });

  test("an RFC3339 string with a numeric offset round-trips to the correct instant", () => {
    expect(parseDueDate("2026-07-01T14:30:00-04:00", now, NY)!.toISOString()).toBe(
      "2026-07-01T18:30:00.000Z",
    );
  });

  test("a malformed RFC3339 string throws instead of producing an Invalid Date", () => {
    expect(() => parseDueDate("2026-13-45T99:00:00Z", now, NY)).toThrow(/YYYY-MM-DD/);
  });
});
