import { describe, expect, test } from "bun:test";
import { frequencyHealth } from "@/frequency-health";
import { mergeEditRequest, type BuildContext } from "@/chore-request";
import { summarizeFrequency } from "@/projection";
import type { ChoreListRow } from "@/types";

const tz = "America/New_York";
const ctx = (): BuildContext => ({ members: [], projects: [], now: new Date("2026-06-15T16:00:00Z"), timezone: tz });

const base = {
  id: 5,
  name: "Something",
  description: "d",
  nextDueDate: "2026-08-10T13:00:00Z",
  assignedTo: null,
  assignees: [],
  assignStrategy: "no_assignee",
  priority: 0,
  status: 0,
  isRolling: false,
  isActive: true,
  isPrivate: false,
  requireApproval: false,
  notification: false,
  notificationMetadata: null,
  completionWindow: null,
  points: null,
  projectId: null,
  labelsV2: [],
  createdBy: 1,
  subTasks: [],
} as unknown as ChoreListRow;

const row = (overrides: Record<string, unknown>): ChoreListRow =>
  ({ ...base, ...overrides }) as unknown as ChoreListRow;

/**
 * The shapes Donetick accepts and then cannot schedule, each measured against a live
 * v0.1.76 container, alongside the healthy neighbour that is easiest to confuse it
 * with.
 */
const BROKEN: Array<[string, ChoreListRow]> = [
  ["interval, no unit", row({ frequencyType: "interval", frequency: 3, frequencyMetadata: {} })],
  [
    "interval, hourly with a time",
    row({ frequencyType: "interval", frequency: 4, frequencyMetadata: { unit: "hours", time: "1970-01-01T09:00:00-04:00" } }),
  ],
  ["interval, count 0", row({ frequencyType: "interval", frequency: 0, frequencyMetadata: { unit: "days" } })],
  ["interval, negative count", row({ frequencyType: "interval", frequency: -3, frequencyMetadata: { unit: "days" } })],
  ["days_of_the_week, no days", row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: [] } })],
  [
    "week_of_month, no occurrences",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month" } }),
  ],
  [
    "week_of_quarter, stored occurrence of 14",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_quarter", occurrences: [14] } }),
  ],
  [
    "week_of_month, stored occurrence of 6",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_month", occurrences: [6] } }),
  ],
  [
    "week_of_quarter, stored weekNumbers of 14",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_quarter", weekNumbers: [14] } }),
  ],
    ["day_of_the_month, no months", row({ frequencyType: "day_of_the_month", frequency: 15, frequencyMetadata: {} })],
  [
    "day_of_the_month, day 0",
    row({ frequencyType: "day_of_the_month", frequency: 0, frequencyMetadata: { months: ["october"] } }),
  ],
  [
    "day_of_the_month, day 32",
    row({ frequencyType: "day_of_the_month", frequency: 32, frequencyMetadata: { months: ["october"] } }),
  ],
];

const HEALTHY: Array<[string, ChoreListRow]> = [
  ["daily", row({ frequencyType: "daily", frequency: 1, frequencyMetadata: {} })],
  ["once", row({ frequencyType: "once", frequency: 1, frequencyMetadata: {} })],
  ["interval, 3 days", row({ frequencyType: "interval", frequency: 3, frequencyMetadata: { unit: "days" } })],
  [
    "interval, 24 hours with a time",
    row({ frequencyType: "interval", frequency: 24, frequencyMetadata: { unit: "hours", time: "1970-01-01T09:00:00-04:00" } }),
  ],
  [
    "interval, 48 hours with a time",
    row({ frequencyType: "interval", frequency: 48, frequencyMetadata: { unit: "hours", time: "1970-01-01T09:00:00-04:00" } }),
  ],
  ["days_of_the_week, plain", row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"] } })],
  [
    "week_of_month with occurrences",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month", occurrences: [1] } }),
  ],
  [
    "week_of_month with the deprecated weekNumbers",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["saturday"], weekPattern: "week_of_month", weekNumbers: [1] } }),
  ],
  [
    "every_week needs no occurrences",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["saturday"], weekPattern: "every_week" } }),
  ],
  [
    "week_of_quarter, occurrence 13 is the ceiling and works",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_quarter", occurrences: [13] } }),
  ],
  [
    "week_of_month, occurrence 5 is the ceiling and works",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_month", occurrences: [5] } }),
  ],
  [
    "an occurrence of -1 means the last and is always in range",
    row({ frequencyType: "days_of_the_week", frequencyMetadata: { days: ["monday"], weekPattern: "week_of_month", occurrences: [-1] } }),
  ],
  [
    "day_of_the_month, day 15",
    row({ frequencyType: "day_of_the_month", frequency: 15, frequencyMetadata: { months: ["october"] } }),
  ],
  [
    "day_of_the_month carrying weekday names, which Donetick ignores",
    row({ frequencyType: "day_of_the_month", frequency: 15, frequencyMetadata: { days: ["saturday"], months: ["october"] } }),
  ],
];

describe("the read side and the write side cannot disagree", () => {
  // This is the point of the shared predicate. The two used to enumerate these shapes
  // independently and disagreed three times, each caught a round apart: an interval
  // count of 0 read as "every 0 days" while every edit refused it, an hourly interval
  // with a time read as "every 4 hours" while every edit refused it, and a
  // day_of_the_month row with weekday names was refused by every edit while the
  // projection correctly called it fine.
  for (const [label, chore] of BROKEN) {
    test(`${label}: described as broken and refused on edit`, () => {
      expect(summarizeFrequency(chore).startsWith("broken:")).toBe(true);
      expect(() => mergeEditRequest(chore, { name: "Renamed" }, ctx())).toThrow(/cannot schedule/);
    });
  }

  for (const [label, chore] of HEALTHY) {
    test(`${label}: described plainly and allowed on edit`, () => {
      expect(summarizeFrequency(chore).startsWith("broken:")).toBe(false);
      expect(() => mergeEditRequest(chore, { name: "Renamed" }, ctx())).not.toThrow();
    });
  }
});

describe("frequencyHealth", () => {
  test("a broken shape carries both what is wrong and how to fix it", () => {
    const health = frequencyHealth(BROKEN[0]![1]);
    expect(health.ok).toBe(false);
    if (health.ok) return;
    expect(health.detail.length).toBeGreaterThan(0);
    expect(health.repair).toMatch(/frequency:/);
  });

  test("passing a new frequency is the repair, so the guard must not block it", () => {
    // assertSchedulableFrequency runs only on the carry-forward branch. If it ran
    // unconditionally, the message would name a repair the tool then refused.
    for (const [, chore] of BROKEN) {
      expect(() =>
        mergeEditRequest(chore, { frequency: { type: "interval", every: 3, unit: "days" } }, ctx()),
      ).not.toThrow();
    }
  });
});
