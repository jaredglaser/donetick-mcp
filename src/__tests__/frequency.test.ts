import { describe, expect, test } from "bun:test";
import { buildFrequency, FREQUENCY_TYPES } from "@/frequency";
import type { FrequencyInput, FrequencyType, WeekPattern } from "@/frequency";

const tz = "America/New_York";

describe("FREQUENCY_TYPES", () => {
  test("covers all eleven values Donetick accepts", () => {
    expect([...FREQUENCY_TYPES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe("buildFrequency", () => {
  test("once needs no metadata", () => {
    const out = buildFrequency({ type: "once" }, tz);
    expect(out.frequencyType).toBe("once");
    expect(out.frequency).toBe(1);
  });

  test("daily ignores any count, because Donetick hardcodes the step", () => {
    const out = buildFrequency({ type: "daily", every: 5 }, tz);
    expect(out.frequencyType).toBe("daily");
    expect(out.frequency).toBe(1);
  });

  test("every 3 days is an interval, not daily", () => {
    const out = buildFrequency({ type: "interval", every: 3, unit: "days" }, tz);
    expect(out.frequencyType).toBe("interval");
    expect(out.frequency).toBe(3);
    expect(out.frequencyMetadata.unit).toBe("days");
  });

  test("interval defaults to days when no unit is given", () => {
    expect(buildFrequency({ type: "interval", every: 2 }, tz).frequencyMetadata.unit).toBe("days");
  });

  test("interval rejects a missing count", () => {
    expect(() => buildFrequency({ type: "interval" }, tz)).toThrow(/every/);
  });

  test("days_of_the_week carries the day list", () => {
    const out = buildFrequency({ type: "days_of_the_week", days: ["monday", "thursday"] }, tz);
    expect(out.frequencyType).toBe("days_of_the_week");
    expect(out.frequencyMetadata.days).toEqual(["monday", "thursday"]);
  });

  test("days_of_the_week rejects an empty day list", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: [] }, tz)).toThrow(/days/);
  });

  test("days_of_the_week rejects an unknown day name", () => {
    expect(() => buildFrequency({ type: "days_of_the_week", days: ["funday"] }, tz)).toThrow(
      /funday/,
    );
  });

  test("first saturday of every month carries weekPattern and occurrences", () => {
    const out = buildFrequency(
      { type: "day_of_the_month", days: ["saturday"], week_pattern: "week_of_month", occurrences: [1] },
      tz,
    );
    expect(out.frequencyType).toBe("day_of_the_month");
    expect(out.frequencyMetadata.weekPattern).toBe("week_of_month");
    expect(out.frequencyMetadata.occurrences).toEqual([1]);
    expect(out.frequencyMetadata.days).toEqual(["saturday"]);
  });

  test("day_of_the_month carries a month list when given", () => {
    const out = buildFrequency(
      { type: "day_of_the_month", days: ["monday"], months: ["january", "july"] },
      tz,
    );
    expect(out.frequencyMetadata.months).toEqual(["january", "july"]);
  });

  test("adaptive needs no metadata", () => {
    expect(buildFrequency({ type: "adaptive" }, tz).frequencyType).toBe("adaptive");
  });

  test("every result pins the timezone so donetick schedules in the right zone", () => {
    expect(buildFrequency({ type: "daily" }, tz).frequencyMetadata.timezone).toBe(tz);
  });

  test("a time of day is carried through", () => {
    expect(buildFrequency({ type: "daily", time: "07:30" }, tz).frequencyMetadata.time).toBe("07:30");
  });

  test("trigger is accepted but flagged as unsupported here", () => {
    expect(() => buildFrequency({ type: "trigger" }, tz)).toThrow(/Things/);
  });
});

describe("case-insensitive day and month names", () => {
  test("day names are lowercased regardless of input case", () => {
    const out = buildFrequency({ type: "days_of_the_week", days: ["Monday", "THURSDAY"] }, tz);
    expect(out.frequencyMetadata.days).toEqual(["monday", "thursday"]);
  });

  test("month names are lowercased regardless of input case", () => {
    const out = buildFrequency(
      { type: "day_of_the_month", days: ["Saturday"], months: ["January", "JULY"] },
      tz,
    );
    expect(out.frequencyMetadata.months).toEqual(["january", "july"]);
  });
});

describe("interval count validation", () => {
  test("rejects a zero count", () => {
    expect(() => buildFrequency({ type: "interval", every: 0 }, tz)).toThrow(/every/);
  });

  test("rejects a negative count", () => {
    expect(() => buildFrequency({ type: "interval", every: -3 }, tz)).toThrow(/every/);
  });

  test("rejects a non-integer count", () => {
    // 2.5 does not describe a meaningful "every 2.5 days" schedule, so this is
    // rejected rather than rounded or truncated, which would silently schedule
    // something other than what the caller asked for.
    expect(() => buildFrequency({ type: "interval", every: 2.5 }, tz)).toThrow(/every/);
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
        type: "day_of_the_month",
        days: ["saturday"],
        week_pattern: "week_of_month",
        occurrences: [-1],
      },
      tz,
    );
    expect(out.frequencyMetadata.occurrences).toEqual([-1]);
  });
});

describe("week_pattern validation", () => {
  test("rejects an unknown value", () => {
    expect(() =>
      buildFrequency(
        {
          type: "day_of_the_month",
          days: ["monday"],
          week_pattern: "fortnightly" as WeekPattern,
        },
        tz,
      ),
    ).toThrow(/fortnightly/);
  });
});

describe("time validation", () => {
  test("rejects a time that is not HH:MM", () => {
    // A time is passed straight through to Donetick's scheduler; validating it here,
    // at chore-creation time, surfaces a bad value immediately instead of letting it
    // fail silently later at schedule time.
    expect(() => buildFrequency({ type: "daily", time: "7:30 am" }, tz)).toThrow(/time/);
  });

  test("rejects an out-of-range time", () => {
    expect(() => buildFrequency({ type: "daily", time: "25:00" }, tz)).toThrow(/time/);
  });
});

describe("weekly with an explicit days list", () => {
  test("is rejected, since the caller likely meant days_of_the_week", () => {
    // Silently ignoring "days" here would let a caller believe they picked specific
    // weekdays when Donetick actually schedules every day, which is worse than an error.
    expect(() => buildFrequency({ type: "weekly", days: ["monday"] }, tz)).toThrow(
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
        return { type, days: ["monday"] };
      default:
        return { type };
    }
  }

  test("every type is handled or throws a clear error, never crashes or returns an undefined frequencyType", () => {
    for (const raw of FREQUENCY_TYPES) {
      const type = raw as FrequencyType;
      const input = minimalInputFor(type);
      if (type === "trigger") {
        expect(() => buildFrequency(input, tz)).toThrow();
        continue;
      }
      const out = buildFrequency(input, tz);
      expect(out.frequencyType).toBe(type);
    }
  });
});
