import { describe, expect, test } from "bun:test";
import { utcOffsetFor } from "@/time";
import { buildFrequency, FREQUENCY_TYPES } from "@/frequency";
import type { FrequencyInput, FrequencyType, WeekPattern } from "@/frequency";

const tz = "America/New_York";
// Fixed so the RFC3339 offset a time-of-day gets stamped with is deterministic.
const now = new Date("2026-08-06T16:00:00Z");

describe("FREQUENCY_TYPES", () => {
  test("covers all eleven values Donetick accepts", () => {
    const expected: FrequencyType[] = [
      "adaptive",
      "daily",
      "day_of_the_month",
      "days_of_the_week",
      "interval",
      "monthly",
      "no_repeat",
      "once",
      "trigger",
      "weekly",
      "yearly",
    ];
    expect([...FREQUENCY_TYPES].sort()).toEqual(expected.sort());
  });
});

describe("buildFrequency", () => {
  test("once needs no metadata", () => {
    const out = buildFrequency({ type: "once" }, tz, now);
    expect(out.frequencyType).toBe("once");
    expect(out.frequency).toBe(1);
  });

  test("daily ignores any count, because Donetick hardcodes the step", () => {
    const out = buildFrequency({ type: "daily", every: 5 }, tz, now);
    expect(out.frequencyType).toBe("daily");
    expect(out.frequency).toBe(1);
  });

  test("every 3 days is an interval, not daily", () => {
    const out = buildFrequency({ type: "interval", every: 3, unit: "days" }, tz, now);
    expect(out.frequencyType).toBe("interval");
    expect(out.frequency).toBe(3);
    expect(out.frequencyMetadata.unit).toBe("days");
  });

  test("interval defaults to days when no unit is given", () => {
    expect(buildFrequency({ type: "interval", every: 2 }, tz, now).frequencyMetadata.unit).toBe("days");
  });

  test("interval rejects a missing count", () => {
    expect(() => buildFrequency({ type: "interval" }, tz, now)).toThrow(/every/);
  });

  test("days_of_the_week carries the day list", () => {
    const out = buildFrequency({ type: "days_of_the_week", days: ["monday", "thursday"] }, tz, now);
    expect(out.frequencyType).toBe("days_of_the_week");
    expect(out.frequencyMetadata.days).toEqual(["monday", "thursday"]);
  });

  test("days_of_the_week rejects an empty day list", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: [] }, tz, now)).toThrow(/days/);
  });

  test("days_of_the_week rejects an unknown day name", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: ["funday"] }, tz, now)).toThrow(
      /funday/,
    );
  });

  test("first saturday of every month is days_of_the_week, not day_of_the_month", () => {
    // Measured on v0.1.76 against a chore due Thu 2026-09-10: days_of_the_week with
    // occurrences [1] scheduled Sat Oct 3, the first Saturday of the next month,
    // while the plain form scheduled Sat Sep 12. day_of_the_month shaped this way
    // produced a chore whose every completion answered 500.
    const out = buildFrequency(
      { type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_month", occurrences: [1] },
      tz,
      now,
    );
    expect(out.frequencyType).toBe("days_of_the_week");
    expect(out.frequencyMetadata.weekPattern).toBe("week_of_month");
    expect(out.frequencyMetadata.occurrences).toEqual([1]);
    expect(out.frequencyMetadata.days).toEqual(["saturday"]);
  });

  test("day_of_the_month carries the day number in frequency, with months", () => {
    // Measured: frequency 15 with months ["october"] scheduled 2026-10-15.
    const out = buildFrequency(
      { type: "day_of_the_month", day_of_month: 15, months: ["october"] },
      tz,
      now,
    );
    expect(out.frequencyType).toBe("day_of_the_month");
    expect(out.frequency).toBe(15);
    expect(out.frequencyMetadata.months).toEqual(["october"]);
  });

  test("day_of_the_month refuses a weekday and points at the type that handles it", () => {
    expect(() =>
      buildFrequency({ type: "day_of_the_month", days: ["saturday"] }, tz, now),
    ).toThrow(/days_of_the_week/);
  });

  test("day_of_the_month refuses to omit months, which makes the chore unschedulable", () => {
    // Measured: omitting months creates the chore and then answers 500 on every
    // completion, permanently.
    expect(() => buildFrequency({ type: "day_of_the_month", day_of_month: 15 }, tz, now)).toThrow(
      /months/,
    );
  });

  test("day_of_the_month refuses a day outside 1 to 31", () => {
    expect(() =>
      buildFrequency({ type: "day_of_the_month", day_of_month: 0, months: ["october"] }, tz, now),
    ).toThrow(/1 to 31/);
    expect(() =>
      buildFrequency({ type: "day_of_the_month", day_of_month: 32, months: ["october"] }, tz, now),
    ).toThrow(/1 to 31/);
  });

  test("day_of_the_month carries its month list", () => {
    const out = buildFrequency(
      { type: "day_of_the_month", day_of_month: 3, months: ["january", "july"] },
      tz,
      now,
    );
    expect(out.frequencyMetadata.months).toEqual(["january", "july"]);
  });

  test("adaptive needs no metadata", () => {
    expect(buildFrequency({ type: "adaptive" }, tz, now).frequencyType).toBe("adaptive");
  });

  test("every result pins the timezone so donetick schedules in the right zone", () => {
    expect(buildFrequency({ type: "daily" }, tz, now).frequencyMetadata.timezone).toBe(tz);
  });

  test("a time of day is sent as RFC3339, which is what Donetick binds", () => {
    // Verified live on v0.1.76: the binding is datetime=2006-01-02T15:04:05Z07:00
    // and the scheduler parses time.RFC3339, so "07:30" is a 400.
    expect(buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "07:30" }, tz, now).frequencyMetadata.time).toBe(
      "1970-01-01T07:30:00-04:00",
    );
  });

  test("the offset is the zone's offset now, not its offset at the placeholder date", () => {
    // Donetick converts the stored timestamp to UTC and reads the clock parts from
    // there, so the offset decides when the chore actually fires. Reading it at the
    // epoch put Asia/Singapore permanently 30 minutes out, since it was +07:30 in
    // 1970 and is +08:00 today.
    expect(
      buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "07:30" }, "Asia/Singapore", now).frequencyMetadata.time,
    ).toBe("1970-01-01T07:30:00+08:00");
  });

  test("a zone with no DST is unaffected either way", () => {
    expect(
      buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "07:30" }, "Asia/Kolkata", now).frequencyMetadata.time,
    ).toBe("1970-01-01T07:30:00+05:30");
  });

  test("a caller still writes HH:MM, and a malformed one is still refused", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "7:30 am" }, tz, now)).toThrow(/time/);
  });

  test("trigger is accepted but flagged as unsupported here", () => {
    expect(() => buildFrequency({ type: "trigger" }, tz, now)).toThrow(/Things/);
  });
});

describe("case-insensitive day and month names", () => {
  test("day names are lowercased regardless of input case", () => {
    const out = buildFrequency({ type: "days_of_the_week", days: ["Monday", "THURSDAY"] }, tz, now);
    expect(out.frequencyMetadata.days).toEqual(["monday", "thursday"]);
  });

  test("month names are lowercased regardless of input case", () => {
    const out = buildFrequency(
      { type: "day_of_the_month", day_of_month: 3, months: ["January", "JULY"] },
      tz,
      now,
    );
    expect(out.frequencyMetadata.months).toEqual(["january", "july"]);
  });
});

describe("interval count validation", () => {
  test("rejects a zero count", () => {
    expect(() => buildFrequency({ type: "interval", every: 0 }, tz, now)).toThrow(/every/);
  });

  test("rejects a negative count", () => {
    expect(() => buildFrequency({ type: "interval", every: -3 }, tz, now)).toThrow(/every/);
  });

  test("rejects a non-integer count", () => {
    // 2.5 does not describe a meaningful "every 2.5 days" schedule, so this is
    // rejected rather than rounded or truncated, which would silently schedule
    // something other than what the caller asked for.
    expect(() => buildFrequency({ type: "interval", every: 2.5 }, tz, now)).toThrow(/every/);
  });
});

describe("occurrences", () => {
  test("accepts a sentinel value for the last occurrence in the pattern", () => {
    // Donetick's web UI offers 1st through 4th and "Last" for day_of_the_month with
    // -1 is "Last occurrence", matching DAY_OCCURRENCE_OPTIONS in the official
    // frontend and confirmed to round-trip intact on a live instance alongside 1
    // through 4. Occurrences are passed through without a range check because the
    // set is the backend's to define, not this module's.
    const out = buildFrequency(
      {
        type: "days_of_the_week",
        days: ["saturday"],
        week_pattern: "week_of_month",
        occurrences: [-1],
      },
      tz,
      now,
    );
    expect(out.frequencyMetadata.occurrences).toEqual([-1]);
  });
});

describe("week_pattern validation", () => {
  test("rejects an unknown value", () => {
    expect(() =>
      buildFrequency(
        {
          type: "days_of_the_week",
          days: ["monday"],
          week_pattern: "fortnightly" as WeekPattern,
        },
        tz,
        now,
      ),
    ).toThrow(/fortnightly/);
  });
});

describe("time validation", () => {
  test("rejects a time that is not HH:MM", () => {
    // A time is passed straight through to Donetick's scheduler; validating it here,
    // at chore-creation time, surfaces a bad value immediately instead of letting it
    // fail silently later at schedule time.
    expect(() => buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "7:30 am" }, tz, now)).toThrow(/time/);
  });

  test("rejects an out-of-range time", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "25:00" }, tz, now)).toThrow(/time/);
  });
});

describe("weekly with an explicit days list", () => {
  test("is rejected, since the caller likely meant days_of_the_week", () => {
    // Silently ignoring "days" here would let a caller believe they picked specific
    // weekdays when Donetick actually schedules every day, which is worse than an error.
    expect(() => buildFrequency({ type: "weekly", days: ["monday"] }, tz, now)).toThrow(
      /days_of_the_week/,
    );
  });
});

describe("exhaustiveness across all eleven types", () => {
  function minimalInputFor(type: FrequencyType): FrequencyInput {
    switch (type) {
      case "interval":
        return { type, every: 1 };
      case "days_of_the_week":
        return { type, days: ["monday"] };
      case "day_of_the_month":
        return { type, day_of_month: 15, months: ["october"] };
      default:
        return { type };
    }
  }

  test("every type is handled or throws a clear error, never crashes or returns an undefined frequencyType", () => {
    for (const raw of FREQUENCY_TYPES) {
      const type = raw as FrequencyType;
      const input = minimalInputFor(type);
      if (type === "trigger") {
        expect(() => buildFrequency(input, tz, now)).toThrow();
        continue;
      }
      const out = buildFrequency(input, tz, now);
      expect(out.frequencyType).toBe(type);
    }
  });
});

describe("occurrence shapes Donetick honors, and the one it ignores", () => {
  // Measured against a chore due Thu 2026-09-10, where the answers differ:
  // week_of_month [2] scheduled the 2nd Saturday (Sep 12), [1,3] the next of either
  // (Sep 19), week_of_quarter [1] the first of the quarter (Oct 3), and occurrences
  // with no pattern scheduled the plain next Saturday (Sep 12), ignoring it.

  test("occurrences without week_pattern is refused, since Donetick discards it", () => {
    expect(() =>
      buildFrequency({ type: "days_of_the_week", days: ["saturday"], occurrences: [-1] }, tz, now),
    ).toThrow(/week_pattern/);
  });

  test("the error names the shape that works", () => {
    expect(() =>
      buildFrequency({ type: "days_of_the_week", days: ["saturday"], occurrences: [1] }, tz, now),
    ).toThrow(/week_of_month/);
  });

  test("week_of_quarter is carried, not just week_of_month", () => {
    const out = buildFrequency(
      { type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_quarter", occurrences: [1] },
      tz,
      now,
    );
    expect(out.frequencyMetadata.weekPattern).toBe("week_of_quarter");
  });

  test("several occurrences are carried", () => {
    const out = buildFrequency(
      { type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_month", occurrences: [1, 3] },
      tz,
      now,
    );
    expect(out.frequencyMetadata.occurrences).toEqual([1, 3]);
  });
});

describe("week_pattern needs occurrences Donetick can match", () => {
  test("a pattern with no occurrences is refused", () => {
    // Measured: week_of_month with no occurrences answers 500 on every completion.
    // Donetick's scheduler requires at least one, and the chore is created happily
    // first, so this is the same never-completable shape as day_of_the_month with no
    // months.
    expect(() =>
      buildFrequency(
        { type: "days_of_the_week", days: ["saturday"], week_pattern: "week_of_month" },
        tz,
        now,
      ),
      // Matched on the sentence, not the word: deleting the guard leaves a TypeError
      // reading "undefined is not an object (evaluating 'input.occurrences.filter')",
      // which contains "occurrences" and satisfied the looser pattern.
    ).toThrow(/needs occurrences/);
  });

  test("an occurrence Donetick can never match is refused", () => {
    // The scheduler matches against the positions that exist in the period, so one
    // outside that range exhausts its search and fails the same way.
    expect(() =>
      buildFrequency(
        {
          type: "days_of_the_week",
          days: ["saturday"],
          week_pattern: "week_of_month",
          occurrences: [6],
        },
        tz,
        now,
      ),
    ).toThrow(/1 through 5/);
  });

  test("a quarter allows more positions than a month", () => {
    expect(() =>
      buildFrequency(
        {
          type: "days_of_the_week",
          days: ["saturday"],
          week_pattern: "week_of_quarter",
          occurrences: [13],
        },
        tz,
        now,
      ),
    ).not.toThrow();
  });

  test("-1 is allowed for both, since it means the last", () => {
    for (const pattern of ["week_of_month", "week_of_quarter"] as const) {
      expect(() =>
        buildFrequency(
          { type: "days_of_the_week", days: ["saturday"], week_pattern: pattern, occurrences: [-1] },
          tz,
          now,
        ),
      ).not.toThrow();
    }
  });
});

describe("every_week takes no occurrences", () => {
  test("is refused, since Donetick ignores them for that pattern", () => {
    // every_week means every matching weekday, so there is nothing to pick from. It
    // also bypassed the range check, letting an occurrence Donetick can never match
    // through, and the projection then read the pattern as monthly.
    expect(() =>
      buildFrequency(
        {
          type: "days_of_the_week",
          days: ["saturday"],
          week_pattern: "every_week",
          occurrences: [3],
        },
        tz,
        now,
      ),
    ).toThrow(/every_week/);
  });

  test("every_week on its own is fine", () => {
    expect(() =>
      buildFrequency(
        { type: "days_of_the_week", days: ["saturday"], week_pattern: "every_week" },
        tz,
        now,
      ),
    ).not.toThrow();
  });
});

describe("occurrence bounds, at their edges", () => {
  const dow = (occurrences: number[], pattern: "week_of_month" | "week_of_quarter") =>
    buildFrequency(
      { type: "days_of_the_week", days: ["saturday"], week_pattern: pattern, occurrences },
      tz,
      now,
    );

  test("an empty list is refused, like an omitted one", () => {
    // A JSON caller produces [] routinely, and it reaches the same 500-on-every-
    // completion shape as omitting the field.
    expect(() => dow([], "week_of_month")).toThrow(/occurrences/);
  });

  test("zero is refused, since no period has a zeroth occurrence", () => {
    expect(() => dow([0], "week_of_month")).toThrow(/1 through 5/);
  });

  test("a fraction is refused", () => {
    expect(() => dow([1.5], "week_of_month")).toThrow(/1 through 5/);
  });

  test("a quarter's ceiling is higher than a month's, and still bounded", () => {
    expect(() => dow([13], "week_of_quarter")).not.toThrow();
    expect(() => dow([14], "week_of_quarter")).not.toThrow();
    expect(() => dow([15], "week_of_quarter")).toThrow(/1 through 14/);
    expect(() => dow([6], "week_of_month")).toThrow(/1 through 5/);
  });
});

describe("a time of day only where Donetick reads one", () => {
  test("an hourly interval refuses it, because carrying one freezes the chore", () => {
    // Measured on v0.1.76: a 4-hourly chore with a time advanced once and then
    // rescheduled to the instant it was already at, on every completion after,
    // permanently overdue and answering 200 each time. The scheduler resets the base
    // date's clock to the stored time before adding the hours, so the result stops
    // depending on where the chore actually was.
    expect(() =>
      buildFrequency({ type: "interval", every: 4, unit: "hours", time: "09:00" }, tz, now),
    ).toThrow(/freezes/);
  });

  test("an hourly interval with no time is fine", () => {
    expect(() => buildFrequency({ type: "interval", every: 4, unit: "hours" }, tz, now)).not.toThrow();
  });

  test("a daily interval still takes one", () => {
    expect(() =>
      buildFrequency({ type: "interval", every: 3, unit: "days", time: "09:00" }, tz, now),
    ).not.toThrow();
  });

  test("the types whose scheduler never reads it refuse it and name due_date instead", () => {
    for (const type of ["daily", "weekly", "monthly", "yearly", "adaptive"] as const) {
      expect(() => buildFrequency({ type, time: "09:00" }, tz, now)).toThrow(/due_date/);
    }
  });

  test("the three that do read it accept it", () => {
    expect(() =>
      buildFrequency({ type: "days_of_the_week", days: ["monday"], time: "09:00" }, tz, now),
    ).not.toThrow();
    expect(() =>
      buildFrequency(
        { type: "day_of_the_month", day_of_month: 15, months: ["october"], time: "09:00" },
        tz,
        now,
      ),
    ).not.toThrow();
  });
});

describe("interval's unit default, which two places have to agree about", () => {
  test("an interval with no unit takes a time, because it defaults to days", () => {
    // The hourly gate and the interval branch each default the unit independently.
    // Only one of the two defaults was pinned, so flipping the gate's to "hours"
    // would refuse a schedule the other builds happily.
    const out = buildFrequency({ type: "interval", every: 3, time: "09:00" }, tz, now);
    expect(out.frequencyMetadata.unit).toBe("days");
    expect(out.frequencyMetadata.time).toBe("1970-01-01T09:00:00-04:00");
  });
});

describe("empty arrays reach the same broken shapes as omitted ones", () => {
  test("months: [] is refused, like omitting months", () => {
    // A JSON caller produces [] routinely, and Donetick answers 500 on every
    // completion for a day_of_the_month chore with no months either way.
    expect(() =>
      buildFrequency({ type: "day_of_the_month", day_of_month: 15, months: [] }, tz, now),
    ).toThrow(/needs "months"/);
  });
});

describe("utcOffsetFor's format guard", () => {
  test("an offset carrying seconds is truncated to what RFC3339 allows", () => {
    // Zones carried local mean times with sub-minute offsets before standardisation,
    // and Go's time.Parse refuses -00:44:30. Nothing exercised the branch, because
    // every test instant lands in the modern era where the regex passes.
    expect(utcOffsetFor("Africa/Monrovia", new Date("1900-01-01T00:00:00Z"))).toMatch(
      /^[+-]\d{2}:\d{2}$/,
    );
  });

  test("an ordinary offset is passed through whole", () => {
    expect(utcOffsetFor("Asia/Kolkata", new Date("2026-08-06T00:00:00Z"))).toBe("+05:30");
  });
});
