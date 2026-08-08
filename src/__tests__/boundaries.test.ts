import { describe, expect, test } from "bun:test";

/**
 * The rules in CLAUDE.md that are structural rather than stylistic, enforced here
 * because nothing else enforces them. There is no linter in this repo, and two
 * modules exist solely to preserve the first of these: confirm.ts restates an SDK
 * type so the confirmation decision can be tested, and probe.ts holds the startup
 * gate outside the entry point for the same reason. Both of those are wasted the
 * moment something else imports the SDK.
 */
const SRC = new URL("../", import.meta.url).pathname;

async function sourceFiles(): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) paths.push(path);
  return paths.sort();
}

async function readAll(): Promise<Array<{ path: string; text: string }>> {
  return Promise.all(
    (await sourceFiles()).map(async (path) => ({ path, text: await Bun.file(SRC + path).text() })),
  );
}

describe("module boundaries", () => {
  test("only index.ts imports the MCP SDK", async () => {
    const offenders = (await readAll())
      .filter(({ path }) => path !== "index.ts")
      // An import statement, not the bare string: this file names the package in its
      // own source and would otherwise report itself.
      .filter(({ text }) => /\bfrom "@modelcontextprotocol\/server/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("only client.ts calls fetch", async () => {
    // The seam every test in this suite depends on: fetch is injected into the
    // client, so a call anywhere else is a request no test can intercept.
    const offenders = (await readAll())
      .filter(({ path }) => path !== "client.ts" && !path.includes("__tests__"))
      .filter(({ text }) => /\bfetch\(/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("nothing under src writes to stdout", async () => {
    // console.log and console.info write to stdout under Bun, and stdout is the
    // JSON-RPC transport. One operational line there corrupts the protocol stream.
    const offenders = (await readAll())
      .filter(({ text }) => /console\.(log|info)\(/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("nothing below the registry imports the write module", async () => {
    // tools/write.ts sits above its peers. It used to declare the shared tool context
    // that chore-lookup.ts and the other four tool modules needed, so the lowest
    // helper pointed back up at a module depending on it. Type-only, so it erased,
    // but it became a real ESM cycle the moment anyone wanted a value from write.ts.
    const offenders = (await readAll())
      .filter(({ path }) => path.startsWith("tools/") && !path.includes("__tests__"))
      .filter(({ path }) => path !== "tools/index.ts" && path !== "tools/write.ts")
      .filter(({ text }) => /from "@\/tools\/write"/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("a chore or member name never reaches a message unsanitized", async () => {
    // Names are written by any circle member and reach the model as untrusted text.
    // safeName was applied at two of roughly twenty-five interpolation sites, which
    // is closer to a comment than a control: a newline in one forged a whole extra
    // candidate line carrying an id no lookup produced. This is the check, because
    // the next site added would otherwise be unsanitized by default.
    //
    // config.ts is excluded: its ${name} is a hard-coded environment variable label,
    // not anything a user writes.
    const RAW_NAME = /\$\{(?:chore|existing|target|found|member|sub)\.(?:name|displayName)\}/;
    const offenders: string[] = [];

    for (const { path, text } of await readAll()) {
      if (path.includes("__tests__") || path === "config.ts") continue;
      text.split("\n").forEach((line, index) => {
        if (RAW_NAME.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test("no doc comment is orphaned from what it describes", async () => {
    // Review passes keep finding a JSDoc block separated from its function by a newer
    // block inserted above it, on several different functions. Each time the fix was
    // another edit, and each time it happened again, because prose has no compiler.
    // This is the compiler.
    const orphans: string[] = [];
    for (const { path, text } of await readAll()) {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // A block ends either on its own closing line or, for the one-line form, on
        // the same line it opened. Checking only the former let a seventh instance
        // through: a helper inserted directly under a single-line /** ... */ left
        // that comment describing the wrong function, and this test stayed green.
        const endsDocBlock =
          trimmed === "*/" || (trimmed.startsWith("/**") && trimmed.endsWith("*/"));
        if (!endsDocBlock) return;
        const next = lines.slice(index + 1).find((l) => l.trim().length > 0);
        if (next !== undefined && next.trim().startsWith("/**")) {
          orphans.push(`${path}:${index + 1}`);
        }
      });
    }

    expect(orphans).toEqual([]);
  });

  test("production modules import by alias, not by relative path", async () => {
    // Relative imports are for a test reaching its own subject. Anywhere else they
    // make a module's place in the graph depend on where it happens to sit.
    const offenders = (await readAll())
      .filter(({ path }) => !path.includes("__tests__"))
      .filter(({ text }) => /\bfrom "\.\.?\//.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
