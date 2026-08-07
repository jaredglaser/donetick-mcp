import { isValidTimezone } from "@/time";
import { z } from "zod";

export interface Config {
  baseUrl: string;
  token: string;
  timezone: string;
  cacheTtlMs: number;
  timeoutMs: number;
}

function isValidDonetickUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function optionalDurationMs(name: string, allowZero: boolean, example: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") {
        return undefined;
      }
      const trimmed = value.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a whole number of milliseconds, for example ${example}`,
        });
        return z.NEVER;
      }
      const n = Number(trimmed);
      if (allowZero ? n < 0 : n <= 0) {
        ctx.addIssue({
          code: "custom",
          message: allowZero
            ? `${name} must be zero or a positive whole number of milliseconds, for example ${example}`
            : `${name} must be a positive whole number of milliseconds, for example ${example}`,
        });
        return z.NEVER;
      }
      return n;
    });
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const schema = z.object({
  DONETICK_URL: z
    .string()
    .min(1, "DONETICK_URL is required")
    .refine(
      isValidDonetickUrl,
      "DONETICK_URL must be an http or https origin with no path, query string, fragment, or credentials, for example https://donetick.example.com",
    ),
  DONETICK_TOKEN: z
    .string()
    .min(1, "DONETICK_TOKEN is required")
    .refine(
      (token) => !CONTROL_CHARS.test(token),
      "DONETICK_TOKEN contains a newline or control character. It is usually a copy-paste artifact; re-copy the token from Donetick under Settings, Access Token.",
    ),
  DONETICK_TZ: z
    .string()
    .optional()
    .refine(
      (tz) => tz === undefined || isValidTimezone(tz),
      "DONETICK_TZ must be an IANA zone name, for example America/New_York",
    ),
  DONETICK_CACHE_TTL_MS: optionalDurationMs("DONETICK_CACHE_TTL_MS", true, 10_000),
  DONETICK_TIMEOUT_MS: optionalDurationMs("DONETICK_TIMEOUT_MS", false, 15_000),
});

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "env";
        return issue.message.startsWith(path) ? issue.message : `${path}: ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid configuration.\n${detail}`);
  }
  const value = parsed.data;
  return {
    baseUrl: new URL(value.DONETICK_URL).origin,
    token: value.DONETICK_TOKEN,
    timezone: value.DONETICK_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    cacheTtlMs: value.DONETICK_CACHE_TTL_MS ?? 10_000,
    timeoutMs: value.DONETICK_TIMEOUT_MS ?? 15_000,
  };
}
