import { describe, expect, test } from "bun:test";
import { buildToolDefinitions } from "@/tools/index";

/**
 * The README drifted a whole phase behind the code once: it advertised five
 * read-only tools and said writing was "not implemented yet" while twenty tools
 * including create, edit and delete were registered and verified. Nothing failed,
 * because prose is not compiled. This is the cheapest thing that would have.
 */
const readme = await Bun.file(new URL("../../README.md", import.meta.url)).text();

const registered = buildToolDefinitions({
  service: {} as never,
  timezone: "UTC",
  now: () => new Date(),
}).map((tool) => tool.name);

/** Tool names as the README's tables write them: a leading cell of ``name``. */
function documentedToolNames(): string[] {
  return [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!);
}

describe("README", () => {
  test("documents every registered tool", () => {
    const documented = new Set(documentedToolNames());
    const missing = registered.filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  test("documents no tool that is not registered", () => {
    const known = new Set(registered);
    const phantom = documentedToolNames().filter((name) => !known.has(name));
    expect(phantom).toEqual([]);
  });

  test("does not describe the server as read-only or the write tools as unimplemented", () => {
    // The exact sentences that were stale. Matching on the claim rather than on a
    // count keeps this from failing every time a tool is added.
    expect(readme).not.toMatch(/five read-only tools/i);
    expect(readme).not.toMatch(/are not implemented yet/i);
    expect(readme).not.toMatch(/planned but not implemented/i);
  });

  test("its stated verify:live count matches the script", async () => {
    // This one drifted while the tool-count guard above was passing: the guard
    // only covered tools, so three checks were added and the prose stayed put.
    const script = await Bun.file(new URL("../../scripts/verify-live.ts", import.meta.url)).text();
    const checks = [...script.matchAll(/await check\(/g)].length;
    const stated = readme.match(/exercises (\d+) contract facts/);
    expect(stated).not.toBeNull();
    // The cleanup pass runs as a check too but is not a contract fact.
    expect(Number(stated![1])).toBe(checks - 1);
  });

  test("its stated tool count matches the registry", () => {
    const stated = readme.match(/exposes (\w+) tools/);
    expect(stated).not.toBeNull();
    const words: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
    const claimed = words[stated![1]!.toLowerCase()] ?? Number(stated![1]);
    expect(claimed).toBe(registered.length);
  });
});
