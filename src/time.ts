export type Scope =
  | "all"
  | "overdue"
  | "due_today"
  | "due_this_week"
  | "due_within_days"
  | "unscheduled";

const PARTS = ["year", "month", "day", "hour", "minute", "second"] as const;

function formatterFor(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function partsOf(instant: Date, tz: string): Record<(typeof PARTS)[number], number> {
  const formatted = formatterFor(tz).formatToParts(instant);
  const out = {} as Record<(typeof PARTS)[number], number>;
  for (const part of PARTS) {
    const found = formatted.find((p) => p.type === part);
    out[part] = Number(found?.value ?? 0);
  }
  return out;
}

/** Offset of `tz` from UTC at `instant`, in milliseconds. Positive east of Greenwich. */
function offsetMs(instant: Date, tz: string): number {
  const p = partsOf(instant, tz);
  // Intl renders midnight as hour 24 in some engines; normalize.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function zonedYmd(instant: Date, tz: string): { y: number; m: number; d: number } {
  const p = partsOf(instant, tz);
  return { y: p.year, m: p.month, d: p.day };
}

/**
 * Midnight of the given calendar date in `tz`, as a UTC instant. The offset is
 * resolved twice because the offset that applies at the target midnight can differ
 * from the offset at the initial guess on a DST transition day.
 */
function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let utc = naive;
  for (let i = 0; i < 2; i += 1) {
    utc = naive - offsetMs(new Date(utc), tz);
  }
  return new Date(utc);
}

export function startOfDay(instant: Date, tz: string): Date {
  const { y, m, d } = zonedYmd(instant, tz);
  return zonedMidnight(y, m, d, tz);
}

/** Calendar-day addition. Never `+ n * 24h`, which is wrong on DST transition days. */
export function addDays(instant: Date, n: number, tz: string): Date {
  const { y, m, d } = zonedYmd(instant, tz);
  return zonedMidnight(y, m, d + n, tz);
}

export function bucket(
  dueDate: Date | null,
  scope: Scope,
  now: Date,
  tz: string,
  withinDays = 7,
): boolean {
  if (scope === "all") return true;
  if (dueDate === null) return scope === "unscheduled";
  if (scope === "unscheduled") return false;

  const todayStart = startOfDay(now, tz);
  const tomorrowStart = addDays(now, 1, tz);

  switch (scope) {
    case "overdue":
      return dueDate.getTime() < now.getTime();
    case "due_today":
      return dueDate.getTime() >= todayStart.getTime() && dueDate.getTime() < tomorrowStart.getTime();
    case "due_this_week":
      return dueDate.getTime() >= todayStart.getTime() && dueDate.getTime() < addDays(now, 7, tz).getTime();
    case "due_within_days":
      return (
        dueDate.getTime() >= todayStart.getTime() &&
        dueDate.getTime() < addDays(now, withinDays, tz).getTime()
      );
    default:
      return false;
  }
}

export function humanizeDueIn(dueDate: Date | null, now: Date): string {
  if (dueDate === null) return "no due date";

  const deltaMs = dueDate.getTime() - now.getTime();
  const overdue = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);

  if (days >= 1) {
    const unit = days === 1 ? "day" : "days";
    return overdue ? `${days} ${unit} overdue` : `in ${days} ${unit}`;
  }
  if (hours >= 1) {
    const unit = hours === 1 ? "hour" : "hours";
    return overdue ? `${hours} ${unit} overdue` : `in ${hours} ${unit}`;
  }
  const minutes = Math.max(1, Math.floor(abs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return overdue ? `${minutes} ${unit} overdue` : `in ${minutes} ${unit}`;
}
