import { describe, expect, test } from "bun:test";
import { parseConfig } from "@/config";

const valid = {
  DONETICK_URL: "https://dt.example.com",
  DONETICK_TOKEN: "tok_abc",
};

describe("parseConfig", () => {
  test("accepts a minimal valid environment", () => {
    const cfg = parseConfig(valid);
    expect(cfg.baseUrl).toBe("https://dt.example.com");
    expect(cfg.token).toBe("tok_abc");
    expect(cfg.cacheTtlMs).toBe(10_000);
    expect(cfg.timeoutMs).toBe(15_000);
  });

  test("strips a trailing slash from the url", () => {
    expect(parseConfig({ ...valid, DONETICK_URL: "https://dt.example.com/" }).baseUrl).toBe(
      "https://dt.example.com",
    );
  });

  test("allows http for lan addresses", () => {
    expect(parseConfig({ ...valid, DONETICK_URL: "http://192.168.0.2:2021" }).baseUrl).toBe(
      "http://192.168.0.2:2021",
    );
  });

  test("names the missing variable", () => {
    expect(() => parseConfig({ DONETICK_URL: "https://dt.example.com" })).toThrow(
      /DONETICK_TOKEN/,
    );
  });

  test("rejects a url with a path", () => {
    expect(() => parseConfig({ ...valid, DONETICK_URL: "https://dt.example.com/api" })).toThrow(
      /DONETICK_URL/,
    );
  });

  test("falls back to the system zone when DONETICK_TZ is unset", () => {
    expect(parseConfig(valid).timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  test("rejects an unknown timezone by name", () => {
    expect(() => parseConfig({ ...valid, DONETICK_TZ: "Mars/Olympus" })).toThrow(/DONETICK_TZ/);
  });

  test("accepts a cache ttl of zero", () => {
    expect(parseConfig({ ...valid, DONETICK_CACHE_TTL_MS: "0" }).cacheTtlMs).toBe(0);
  });

  test("rejects a url with a query string", () => {
    expect(() => parseConfig({ ...valid, DONETICK_URL: "https://dt.example.com?x=1" })).toThrow(
      /DONETICK_URL/,
    );
  });

  test("rejects a url with a fragment", () => {
    expect(() => parseConfig({ ...valid, DONETICK_URL: "https://dt.example.com#frag" })).toThrow(
      /DONETICK_URL/,
    );
  });

  test("rejects a url with embedded credentials", () => {
    expect(() =>
      parseConfig({ ...valid, DONETICK_URL: "https://user:pass@dt.example.com" }),
    ).toThrow(/DONETICK_URL/);
  });

  test("normalizes an uppercase protocol", () => {
    expect(parseConfig({ ...valid, DONETICK_URL: "HTTPS://dt.example.com" }).baseUrl).toBe(
      "https://dt.example.com",
    );
  });

  test("falls back to the default cache ttl when the value is an empty string", () => {
    expect(parseConfig({ ...valid, DONETICK_CACHE_TTL_MS: "" }).cacheTtlMs).toBe(10_000);
  });

  test("falls back to the default timeout when the value is an empty string", () => {
    expect(parseConfig({ ...valid, DONETICK_TIMEOUT_MS: "" }).timeoutMs).toBe(15_000);
  });

  test("names the variable and unit when the timeout is not numeric", () => {
    expect(() => parseConfig({ ...valid, DONETICK_TIMEOUT_MS: "abc" })).toThrow(
      /DONETICK_TIMEOUT_MS.*milliseconds/,
    );
  });

  test("names the variable when the cache ttl is negative", () => {
    expect(() => parseConfig({ ...valid, DONETICK_CACHE_TTL_MS: "-5" })).toThrow(
      /DONETICK_CACHE_TTL_MS/,
    );
  });

  test("names every invalid variable when several are invalid at once", () => {
    expect(() =>
      parseConfig({
        DONETICK_URL: "not-a-url",
        DONETICK_TOKEN: "",
        DONETICK_TIMEOUT_MS: "abc",
      }),
    ).toThrow(/DONETICK_URL[\s\S]*DONETICK_TOKEN[\s\S]*DONETICK_TIMEOUT_MS/);
  });
});

describe("token hygiene", () => {
  const ok = { DONETICK_URL: "https://dt.example.com", DONETICK_TOKEN: "a1b2c3" };

  test("rejects a token with a trailing newline, the usual copy-paste artifact", () => {
    expect(() => parseConfig({ ...ok, DONETICK_TOKEN: "a1b2c3\n" })).toThrow(/DONETICK_TOKEN/);
  });

  test("rejects a token containing a tab", () => {
    expect(() => parseConfig({ ...ok, DONETICK_TOKEN: "a1b2\tc3" })).toThrow(/DONETICK_TOKEN/);
  });

  test("the rejection explains it is probably a paste artifact", () => {
    expect(() => parseConfig({ ...ok, DONETICK_TOKEN: "a1b2c3\r" })).toThrow(/copy-paste/i);
  });

  test("accepts a non-ascii token, since only control characters break headers", () => {
    expect(parseConfig({ ...ok, DONETICK_TOKEN: "t\u00f6k\u00e9n" }).token).toBe("t\u00f6k\u00e9n");
  });
});

describe("the URL protocol is checked, not only its path and credentials", () => {
  // Path, query, fragment and credentials each had a case. Protocol did not, so
  // dropping the http/https test changed nothing that could fail, and a file: or
  // javascript: URL would have been accepted as a Donetick instance.
  for (const url of ["file:///etc/passwd", "ftp://tasks.example.test", "javascript:alert(1)"]) {
    test(`${url} is refused`, () => {
      expect(() => parseConfig({ DONETICK_URL: url, DONETICK_TOKEN: "t" })).toThrow(/DONETICK_URL/);
    });
  }

  test("http and https are both accepted", () => {
    expect(() => parseConfig({ DONETICK_URL: "http://tasks.example.test", DONETICK_TOKEN: "t" })).not.toThrow();
    expect(() => parseConfig({ DONETICK_URL: "https://tasks.example.test", DONETICK_TOKEN: "t" })).not.toThrow();
  });
});
