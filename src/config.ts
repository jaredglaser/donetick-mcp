import { z } from "zod";

export interface Config {
  baseUrl: string;
  token: string;
  timezone: string;
  cacheTtlMs: number;
  timeoutMs: number;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const schema = z.object({
  DONETICK_URL: z
    .string()
    .min(1, "DONETICK_URL is required")
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          (url.pathname === "/" || url.pathname === "")
        );
      } catch {
        return false;
      }
    }, "DONETICK_URL must be an http or https origin with no path, for example https://donetick.example.com"),
  DONETICK_TOKEN: z.string().min(1, "DONETICK_TOKEN is required"),
  DONETICK_TZ: z
    .string()
    .optional()
    .refine(
      (tz) => tz === undefined || isValidTimezone(tz),
      "DONETICK_TZ must be an IANA zone name, for example America/New_York",
    ),
  DONETICK_CACHE_TTL_MS: z.coerce.number().int().min(0).optional(),
  DONETICK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration. ${detail}`);
  }
  const value = parsed.data;
  return {
    baseUrl: value.DONETICK_URL.replace(/\/+$/, ""),
    token: value.DONETICK_TOKEN,
    timezone: value.DONETICK_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    cacheTtlMs: value.DONETICK_CACHE_TTL_MS ?? 10_000,
    timeoutMs: value.DONETICK_TIMEOUT_MS ?? 15_000,
  };
}
